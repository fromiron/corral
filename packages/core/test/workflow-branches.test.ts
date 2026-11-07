import { type CorralDefinition, CorralDefinition as Definition, RunEvent } from '@corral/contracts';
import {
  FakeClock,
  Gate,
  linearCorral,
  ScriptedAgentAdapter,
  SequentialIdFactory,
} from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import researchTeam from '../../../examples/research-team.corral.json' with { type: 'json' };
import {
  Coordinator,
  InProcessTransport,
  type RunProjection,
  waitForProjection,
} from '../src/index.ts';

function definition(): CorralDefinition {
  const d = linearCorral(['writer']);
  d.nodes.push({
    id: 'ready',
    type: 'decision',
    label: 'Ready',
    mode: 'rule',
    rule: 'required_tasks_submitted',
    inputBindings: [{ kind: 'task_output', sourceNodeId: 'writer', name: 'draft' }],
  });
  d.controlEdges = [
    { id: 'to_ready', source: 'writer', sourcePort: 'out', target: 'ready', targetPort: 'in' },
    { id: 'to_output', source: 'ready', sourcePort: 'yes', target: 'output', targetPort: 'in' },
    { id: 'no_output', source: 'ready', sourcePort: 'no', target: 'output', targetPort: 'in' },
  ];
  return d;
}

const terminal = (p: RunProjection) => ['succeeded', 'failed', 'cancelled'].includes(p.status);

async function runtime(decide?: () => Promise<string>, graph = definition()) {
  const clock = new FakeClock();
  const coordinator = new Coordinator({
    clock,
    timers: clock,
    ids: new SequentialIdFactory(),
    agents: new ScriptedAgentAdapter({ turns: 1 }),
    ...(decide ? { decisions: { decide } } : {}),
  });
  const transport = new InProcessTransport(coordinator);
  const started = await transport.startRun({
    schemaVersion: '0.1',
    commandId: 'start',
    definition: graph,
    mode: 'mock',
  });
  if (!started.runId) throw new Error(JSON.stringify(started.receipt));
  const events: RunEvent[] = [];
  transport.subscribe(started.runId, 0, { onEvent: (event) => events.push(event) });
  return { transport, runId: started.runId, events };
}

describe('workflow branch observations', () => {
  it('records the actual rule branch with its destination and exact task evidence', async () => {
    const r = await runtime();
    const final = await waitForProjection(r.transport, r.runId, terminal);
    const selected = r.events.filter((event) => event.type === 'workflow.branch_selected');
    expect(selected).toHaveLength(1);
    expect(selected[0]?.payload).toMatchObject({
      nodeId: 'ready',
      mode: 'rule',
      iterationId: null,
      selectedPort: 'yes',
      targetNodeId: 'output',
      targetPort: 'in',
      reasonCode: 'required_tasks_completed',
      configRevision: 0,
      evidenceRefs: [{ kind: 'task', id: Object.keys(final.tasks)[0] }],
    });
    expect(final.workflowBranches?.[selected[0]?.eventId ?? '']).toMatchObject({
      nodeId: 'ready',
      selectedPort: 'yes',
    });
    expect(selected[0] && RunEvent.safeParse(selected[0]).success).toBe(true);
    expect(final.status).toBe('succeeded');
    expect(Object.keys(final.decisions)).toHaveLength(0);
  });

  it('records an unconnected selected branch without inventing a destination or explanation', async () => {
    const r = await runtime(async () => 'inconclusive');
    await waitForProjection(r.transport, r.runId, terminal);
    expect(
      r.events.find((event) => event.type === 'workflow.branch_selected')?.payload,
    ).toMatchObject({
      selectedPort: 'inconclusive',
      targetNodeId: null,
      targetPort: null,
      reasonCode: 'external_policy',
      evidenceRefs: [],
    });
  });

  it('does not record or activate a late decision after the Run was cancelled', async () => {
    const waiting = new Gate();
    const entered = new Gate();
    const r = await runtime(async () => {
      entered.open();
      await waiting.wait();
      return 'yes';
    });
    await entered.wait();
    await r.transport.sendCommand({
      schemaVersion: '0.1',
      commandId: 'cancel',
      runId: r.runId,
      type: 'cancel',
      payload: { scope: { kind: 'run' }, reason: 'stop' },
    });
    await waitForProjection(r.transport, r.runId, terminal);
    waiting.open();
    for (let i = 0; i < 50; i++) await Promise.resolve();
    expect(r.events.filter((event) => event.type === 'workflow.branch_selected')).toHaveLength(0);
    expect(r.events.filter((event) => event.type === 'output.finalized')).toHaveLength(0);
  });

  it('binds review iterations and a human branch to the exact review and approval used', async () => {
    const graph = Definition.parse(researchTeam);
    for (const node of graph.nodes) if (node.type === 'output') node.requireApproval = false;
    const r = await runtime(undefined, graph);
    const waiting = await waitForProjection(
      r.transport,
      r.runId,
      (p) => p.status === 'awaiting_user' || terminal(p),
    );
    const reviews = Object.values(waiting.workflowBranches ?? {}).filter(
      (branch) => branch.mode === 'review',
    );
    expect(reviews.map((branch) => branch.selectedPort)).toEqual(['revise', 'pass']);
    expect(new Set(reviews.map((branch) => branch.iterationId)).size).toBe(2);
    for (const branch of reviews) {
      const ref = branch.evidenceRefs.find((ref) => ref.kind === 'review');
      const review = waiting.artifacts[ref?.id ?? ''];
      expect(waiting.executions[review?.authorExecutionId ?? '']?.iterationId).toBe(
        branch.iterationId,
      );
      expect(branch.executionRefs).toContainEqual({
        executionId: review?.authorExecutionId,
        attemptNo: 1,
      });
    }
    const approval = Object.values(waiting.approvals).find((value) => value.status === 'pending');
    if (!approval) throw new Error('expected the approval Decision');
    await r.transport.sendCommand({
      schemaVersion: '0.1',
      commandId: 'approve',
      runId: r.runId,
      type: 'resolve_approval',
      expectedControlRevision: waiting.controlRevision,
      payload: {
        approvalId: approval.approvalId,
        subjectVersionId: approval.subjectVersionIds[0] ?? '',
        decision: 'approve',
      },
    });
    const final = await waitForProjection(r.transport, r.runId, terminal);
    expect(final.status).toBe('succeeded');
    expect(
      Object.values(final.workflowBranches ?? {}).find((branch) => branch.mode === 'approval'),
    ).toMatchObject({
      nodeId: 'approval',
      selectedPort: 'approve',
      targetNodeId: 'output',
      reasonCode: 'human_approval',
      evidenceRefs: [{ kind: 'approval', id: approval.approvalId }],
    });
  });
});
