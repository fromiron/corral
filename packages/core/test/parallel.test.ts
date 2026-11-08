import {
  type ControlEdge,
  type CorralDefinition,
  type CorralNode,
  CorralDefinition as Definition,
  type RunEvent,
} from '@corral/contracts';
import { FakeClock, Gate, ScriptedAgentAdapter, SequentialIdFactory } from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import researchTeam from '../../../examples/research-team.corral.json' with { type: 'json' };
import {
  Coordinator,
  compileDefinition,
  type DecisionPolicy,
  InProcessTransport,
  planRun,
  type RunProjection,
  waitForProjection,
} from '../src/index.ts';

// Parallel branches and Joins (docs/specs/features/team-graph.md, "병렬 실행").

const base = Definition.parse(researchTeam);
const agent = (id: string, source?: string, parentId?: string, roleId = 'writer'): CorralNode => ({
  id,
  type: 'agent',
  label: id,
  roleId,
  invocation: 'scheduled',
  inputBindings: source
    ? [{ kind: 'task_output', name: 'input', sourceNodeId: source }]
    : [{ kind: 'run_input', name: 'brief' }],
  outputName: 'draft',
  ...(parentId ? { parentId } : {}),
});
const join = (policy: 'all' | 'any'): CorralNode => ({ id: 'j', type: 'join', label: 'j', policy });
const output = (source: string): CorralNode => ({
  id: 'output',
  type: 'output',
  label: 'output',
  inputBindings: [{ kind: 'task_output', name: 'final', sourceNodeId: source }],
  requireApproval: false,
});
let n = 0;
const edge = (source: string, sourcePort: string, target: string, targetPort = 'in') =>
  ({ id: `e${++n}`, source, sourcePort, target, targetPort }) as ControlEdge;

function team(nodes: CorralNode[], edges: ControlEdge[]): CorralDefinition {
  return Definition.parse({
    ...base,
    entryNodeId: 'p',
    nodes,
    controlEdges: edges,
    capabilityLinks: [],
  });
}

/** p → a, b → Join j → m → output; `b` may be replaced by another branch. */
function forked(
  policy: 'all' | 'any',
  branch: { nodes: CorralNode[]; edges: ControlEdge[] } = {
    nodes: [agent('b', 'p')],
    edges: [edge('p', 'out', 'b'), edge('b', 'out', 'j')],
  },
) {
  return team(
    [agent('p'), agent('a', 'p'), ...branch.nodes, join(policy), agent('m', 'p'), output('m')],
    [
      edge('p', 'out', 'a'),
      edge('a', 'out', 'j'),
      ...branch.edges,
      edge('j', 'out', 'm'),
      edge('m', 'out', 'output'),
    ],
  );
}

/** Agents named in `held` wait at their gate before replying (a cancelled one then stops). */
function runtime(held: Record<string, Gate>, decisions?: DecisionPolicy) {
  const clock = new FakeClock();
  return new InProcessTransport(
    new Coordinator({
      clock,
      ids: new SequentialIdFactory(),
      timers: clock,
      ...(decisions ? { decisions } : {}),
      agents: new ScriptedAgentAdapter({
        turns: 1,
        appendNotes: false,
        beforeReply: async (_turn, input) => held[input.nodeId]?.wait(),
      }),
    }),
  );
}

async function run(transport: InProcessTransport, definition: CorralDefinition) {
  const { runId, receipt } = await transport.startRun({
    schemaVersion: '0.1',
    commandId: `cmd_${++n}`,
    definition,
    mode: 'mock',
  });
  if (!runId) throw new Error(JSON.stringify(receipt.error));
  const events: RunEvent[] = [];
  transport.subscribe(runId, 0, { onEvent: (event) => events.push(event) });
  return { runId, events };
}

const finished = (p: RunProjection) => ['succeeded', 'failed', 'cancelled'].includes(p.status);
const executions = (p: RunProjection, nodeId: string) =>
  (p.nodeExecutions[nodeId] ?? []).map((id) => p.executions[id]!);
const live = (p: RunProjection, nodeId: string) =>
  executions(p, nodeId).some((e) => !['succeeded', 'failed', 'cancelled'].includes(e.status));
const joins = (events: RunEvent[]) =>
  events.flatMap((e) => (e.type === 'workflow.joined' ? [e.payload] : []));

describe('parallel branches', () => {
  it('compiles a fan-out with a Join as runnable', () => {
    expect(
      compileDefinition(forked('all')).diagnostics.filter((d) => d.code === 'RUNTIME_UNSUPPORTED'),
    ).toEqual([]);
    expect(planRun(forked('any')).ok).toBe(true);
  });

  it('runs both branches at once and continues once after an all Join', async () => {
    const a = new Gate();
    const b = new Gate();
    const transport = runtime({ a, b });
    const { runId, events } = await run(transport, forked('all'));
    await waitForProjection(transport, runId, (p) => live(p, 'a') && live(p, 'b'));
    b.open();
    const halfway = await waitForProjection(transport, runId, (p) =>
      executions(p, 'b').every((e) => e.status === 'succeeded'),
    );
    expect(executions(halfway, 'm')).toHaveLength(0);
    a.open();
    const final = await waitForProjection(transport, runId, finished);
    expect(final.status).toBe('succeeded');
    expect(executions(final, 'm')).toHaveLength(1);
    expect(joins(events)).toEqual([
      { nodeId: 'j', policy: 'all', iterationId: null, cancelledNodeIds: [] },
    ]);
  });

  it('continues after an any Join with the first branch and cancels the other', async () => {
    const b = new Gate();
    const transport = runtime({ b });
    const { runId, events } = await run(transport, forked('any'));
    await waitForProjection(transport, runId, () => joins(events).length > 0);
    b.open();
    const final = await waitForProjection(transport, runId, finished);
    expect(final.status).toBe('succeeded');
    expect(executions(final, 'm')).toHaveLength(1);
    expect(executions(final, 'b').map((e) => e.status)).toEqual(['cancelled']);
    expect(joins(events)[0]).toMatchObject({ policy: 'any', cancelledNodeIds: ['b'] });
    // A stopped branch is not a task the person must restart.
    expect(Object.values(final.tasks).some((t) => t.status === 'blocked')).toBe(false);
  });

  it('withdraws an approval the stopped branch was waiting on', async () => {
    const a = new Gate();
    const transport = runtime({ a });
    const approval: CorralNode = {
      id: 'gate',
      type: 'decision',
      label: 'gate',
      mode: 'approval',
      rule: 'human_approval',
      inputBindings: [{ kind: 'task_output', name: 'input', sourceNodeId: 'p' }],
    };
    const { runId, events } = await run(
      transport,
      forked('any', {
        nodes: [approval],
        edges: [edge('p', 'out', 'gate'), edge('gate', 'approve', 'j')],
      }),
    );
    const waiting = await waitForProjection(transport, runId, (p) =>
      Object.values(p.approvals).some((x) => x.status === 'pending'),
    );
    const pending = Object.values(waiting.approvals).find((x) => x.status === 'pending');
    a.open();
    const final = await waitForProjection(transport, runId, finished);
    expect(final.status).toBe('succeeded');
    expect(final.approvals[pending?.approvalId ?? '']?.status).toBe('rejected');
    expect(
      events.find(
        (e) => e.type === 'approval.resolved' && e.payload.approvalId === pending?.approvalId,
      ),
    ).toMatchObject({ payload: { reason: 'cancelled' } });
    expect(joins(events)[0]?.cancelledNodeIds).toEqual(['gate']);
  });

  it('ends the run when one branch fails, and stops the other', async () => {
    const b = new Gate();
    const clock = new FakeClock();
    const transport = new InProcessTransport(
      new Coordinator({
        clock,
        ids: new SequentialIdFactory(),
        timers: clock,
        agents: new ScriptedAgentAdapter({
          turns: 1,
          beforeReply: async (_turn, input) => (input.nodeId === 'b' ? b.wait() : undefined),
          script: async (input) =>
            input.nodeId === 'a' ? { outcome: 'failed', error: 'a broke' } : null,
        }),
      }),
    );
    const { runId } = await run(transport, forked('all'));
    const final = await waitForProjection(transport, runId, finished);
    b.open();
    expect(final.status).toBe('failed');
    expect(final.statusReason).toBe('execution_failed: a');
  });

  /** b's branch is Loop l [ w → d ], whose next reaches the Join. */
  const looped = (): { nodes: CorralNode[]; edges: ControlEdge[] } => ({
    nodes: [
      { id: 'l', type: 'loop', label: 'l', maxIterations: 3 } as CorralNode,
      agent('w', 'p', 'l', 'reviewer'),
      {
        id: 'd',
        type: 'decision',
        label: 'd',
        mode: 'review',
        rule: 'review_verdict',
        parentId: 'l',
        inputBindings: [{ kind: 'task_output', name: 'review', sourceNodeId: 'w' }],
      },
    ],
    edges: [
      edge('p', 'out', 'l', 'enter'),
      edge('l', 'body', 'w'),
      edge('w', 'out', 'd'),
      edge('d', 'pass', 'l', 'exit'),
      edge('d', 'revise', 'l', 'repeat'),
      edge('l', 'next', 'j'),
    ],
  });
  const rounds = (p: RunProjection) =>
    (p.loopIterations.l ?? []).map((id) => [p.iterations[id]?.no, p.iterations[id]?.outcome]);

  it('runs a Loop inside a branch to its end before the branch arrives', async () => {
    const script = ['revise', 'pass'];
    const transport = runtime({}, { decide: async () => script.shift() ?? 'pass' });
    const { runId } = await run(transport, forked('all', looped()));
    const final = await waitForProjection(transport, runId, finished);
    expect(final.status).toBe('succeeded');
    expect(rounds(final)).toEqual([
      [1, 'revise'],
      [2, 'pass'],
    ]);
    expect(executions(final, 'm')).toHaveLength(1);
  });

  it('ends the open Loop round of a stopped branch as cancelled', async () => {
    const w = new Gate();
    const transport = runtime({ w }, { decide: async () => 'pass' });
    const { runId, events } = await run(transport, forked('any', looped()));
    await waitForProjection(transport, runId, () => joins(events).length > 0);
    w.open();
    const final = await waitForProjection(transport, runId, finished);
    expect(final.status).toBe('succeeded');
    expect(rounds(final)).toEqual([[1, 'cancelled']]);
    expect(joins(events)[0]?.cancelledNodeIds).toEqual(['w']);
  });
});

describe('parallel structure', () => {
  const errors = (definition: unknown) =>
    compileDefinition(definition).diagnostics.filter((d) => d.severity === 'error');

  it('refuses a branch that reaches an Output before the branches rejoin', () => {
    // b ends at a review whose exits are unconnected, so only a reaches the Output.
    const definition = team(
      [
        agent('p'),
        agent('a', 'p'),
        agent('b', 'p', undefined, 'reviewer'),
        {
          id: 'd',
          type: 'decision',
          label: 'd',
          mode: 'review',
          rule: 'review_verdict',
          inputBindings: [{ kind: 'task_output', name: 'review', sourceNodeId: 'b' }],
        },
        output('a'),
      ],
      [
        edge('p', 'out', 'a'),
        edge('p', 'out', 'b'),
        edge('a', 'out', 'output'),
        edge('b', 'out', 'd'),
      ],
    );
    expect(errors(definition)).toEqual([
      expect.objectContaining({ code: 'PARALLEL_UNJOINED', nodeId: 'output' }),
    ]);
  });

  it('refuses a branch that leaves the Loop it split in through exit', () => {
    const definition = team(
      [
        agent('p'),
        { id: 'l', type: 'loop', label: 'l', maxIterations: 2 } as CorralNode,
        agent('a', 'p', 'l'),
        agent('b', 'p', 'l', 'reviewer'),
        {
          id: 'd',
          type: 'decision',
          label: 'd',
          mode: 'review',
          rule: 'review_verdict',
          parentId: 'l',
          inputBindings: [{ kind: 'task_output', name: 'review', sourceNodeId: 'b' }],
        },
        output('a'),
      ],
      [
        edge('p', 'out', 'l', 'enter'),
        edge('l', 'body', 'a'),
        edge('l', 'body', 'b'),
        edge('a', 'out', 'l', 'exit'),
        edge('b', 'out', 'd'),
        edge('d', 'pass', 'l', 'exit'),
        edge('d', 'revise', 'l', 'repeat'),
        edge('l', 'next', 'output'),
      ],
    );
    expect(errors(definition)).toContainEqual(
      expect.objectContaining({ code: 'PARALLEL_UNJOINED' }),
    );
  });

  it('refuses a Join that gathers only some branches of a port', () => {
    const definition = team(
      [
        agent('p'),
        agent('a', 'p'),
        agent('b', 'p'),
        agent('c', 'p'),
        join('all'),
        agent('m', 'p'),
        { id: 'k', type: 'join', label: 'k', policy: 'all' } as CorralNode,
        output('m'),
      ],
      [
        edge('p', 'out', 'a'),
        edge('p', 'out', 'b'),
        edge('p', 'out', 'c'),
        edge('a', 'out', 'j'),
        edge('b', 'out', 'j'),
        edge('j', 'out', 'k'),
        edge('c', 'out', 'k'),
        edge('k', 'out', 'm'),
        edge('m', 'out', 'output'),
      ],
    );
    expect(errors(definition)).toContainEqual(
      expect.objectContaining({ code: 'JOIN_PARTIAL', nodeId: 'j' }),
    );
  });
});
