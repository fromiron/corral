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
function runtime(held: Record<string, Gate>, decisions?: DecisionPolicy, released?: boolean[]) {
  const clock = new FakeClock();
  return new InProcessTransport(
    new Coordinator({
      clock,
      ids: new SequentialIdFactory(),
      timers: clock,
      ...(decisions ? { decisions } : {}),
      // Records how the run gave back its working copy: confirmed ended, or not.
      ...(released
        ? {
            files: {
              available: () => false,
              execute: async () => {
                throw new Error('no file tools in this test');
              },
              releaseRun: (_runId: string, confirmed: boolean) => {
                released.push(confirmed);
              },
            },
          }
        : {}),
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

describe('shared Outrider consultations', () => {
  it.each(['answered', 'timed_out', 'cancelled'] as const)(
    'one of two open requests can be %s without changing its sibling',
    async (outcome) => {
      const definition = forked('all');
      definition.sharedOutrider = {
        modelProfile: 'model-a',
        principles: 'Advise the worker who asked.',
        targets: { kind: 'all' },
      };
      const clock = new FakeClock();
      const releaseA = new Gate();
      const releaseB = new Gate();
      const askerResults = new Map<string, unknown>();
      const replyOutcomes = new Map<string, boolean>();
      const transport = new InProcessTransport(
        new Coordinator({
          clock,
          timers: clock,
          ids: new SequentialIdFactory(),
          agents: new ScriptedAgentAdapter({
            turns: 1,
            collaborate: false,
            script: async (input, host) => {
              if (input.assignment.kind === 'question') {
                const { body, questionId } = input.assignment;
                // Try to deliver even after cancellation so the host's late-reply boundary is exercised.
                await (body === 'Question from a' ? releaseA : releaseB).wait();
                const reply = await host.invokeTool({
                  name: 'reply',
                  args: { questionId, body: `Advice on ${body}`, evidenceRefs: [] },
                });
                replyOutcomes.set(body, reply.ok);
                return { outcome: 'succeeded' };
              }
              if (input.nodeId !== 'a' && input.nodeId !== 'b') return null;
              const target = input.capabilities.askTo[0];
              if (!target)
                return { outcome: 'failed', error: 'No shared Outrider offered to the worker' };
              const asked = await host.invokeTool({
                name: 'ask',
                args: { targetNodeId: target.nodeId, body: `Question from ${input.nodeId}` },
              });
              askerResults.set(input.nodeId, asked.ok ? asked.result : asked.error);
              return null;
            },
          }),
        }),
      );
      try {
        const { runId, events } = await run(transport, definition);
        const started = await waitForProjection(transport, runId, (p) => {
          const open = Object.values(p.questions).filter((q) => q.status === 'open');
          const executions = Object.values(p.executions);
          return (
            finished(p) ||
            (open.length === 2 &&
              open.every((q) => executions.some((execution) => execution.taskId === q.taskId)))
          );
        });
        const questions = Object.values(started.questions);
        expect(questions).toHaveLength(2);
        expect(new Set(questions.map((q) => q.targetNodeId)).size).toBe(1);
        const requestA = questions.find((q) => q.body === 'Question from a');
        const requestB = questions.find((q) => q.body === 'Question from b');
        if (!requestA || !requestB) throw new Error('Both workers must own a distinct request');
        expect(requestA.senderExecutionId).not.toBe(requestB.senderExecutionId);
        const responders = Object.values(started.executions);
        const responderA = responders.find((execution) => execution.taskId === requestA.taskId);
        const responderB = responders.find((execution) => execution.taskId === requestB.taskId);
        if (!responderA || !responderB) throw new Error('Both requests must have a responder');
        expect(responderA.executionId).not.toBe(responderB.executionId);
        expect(responderA.parentExecutionId).toBe(requestA.senderExecutionId);
        expect(responderB.parentExecutionId).toBe(requestB.senderExecutionId);
        releaseB.open();
        const halfway = await waitForProjection(
          transport,
          runId,
          (p) => p.questions[requestB.questionId]?.status === 'answered',
        );
        expect(halfway.questions[requestA.questionId]?.status).toBe('open');
        if (outcome === 'timed_out') clock.advance(definition.limits.questionTimeoutMs);
        if (outcome === 'cancelled') {
          const receipt = await transport.sendCommand({
            schemaVersion: '0.1',
            commandId: 'cancel_responder',
            runId,
            type: 'cancel',
            expectedControlRevision: halfway.controlRevision,
            payload: {
              scope: { kind: 'execution', executionId: responderA.executionId },
              reason: 'Stop this consultation',
            },
          });
          expect(receipt.error).toBeUndefined();
        }
        releaseA.open();
        const final = await waitForProjection(transport, runId, finished);
        expect(final.status).toBe('succeeded');
        expect(final.questions[requestA.questionId]?.status).toBe(outcome);
        expect(askerResults.get('a')).toMatchObject(
          outcome === 'answered' ? { outcome, body: 'Advice on Question from a' } : { outcome },
        );
        expect(askerResults.get('b')).toMatchObject({
          outcome: 'answered',
          body: 'Advice on Question from b',
        });
        expect(replyOutcomes.get('Question from a')).toBe(outcome === 'answered');
        expect(events.filter((e) => e.type === 'message.closed')).toHaveLength(2);
        expect(
          events.filter((e) => e.type === 'message.question_created' && e.payload.sharedOutrider),
        ).toHaveLength(2);
      } finally {
        releaseA.open();
        releaseB.open();
      }
    },
  );
});

describe('parallel branches', () => {
  it('compiles a fan-out with a Join as runnable', () => {
    expect(compileDefinition(forked('all')).ok).toBe(true);
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

  it('#188: an any Join run succeeds only once the stopped branch has ended', async () => {
    const b = new Gate();
    const released: boolean[] = [];
    const transport = runtime({ b }, undefined, released);
    const { runId } = await run(transport, forked('any'));
    await waitForProjection(transport, runId, (p) =>
      executions(p, 'm').some((e) => e.status === 'succeeded'),
    );
    for (let i = 0; i < 50; i++) await Promise.resolve();
    const waiting = await waitForProjection(transport, runId, () => true);
    expect(live(waiting, 'b')).toBe(true);
    expect(waiting.status).toBe('running');
    expect(released).toEqual([]);
    b.open();
    const final = await waitForProjection(transport, runId, finished);
    expect(final.status).toBe('succeeded');
    expect(executions(final, 'b').map((e) => e.status)).toEqual(['cancelled']);
    expect(released).toEqual([true]);
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

  it('#190: accepts a Join of branches one of which already joined its own fan-out', () => {
    const inner: CorralNode = { id: 'k', type: 'join', label: 'k', policy: 'all' };
    const definition = forked('all', {
      nodes: [agent('b', 'p'), agent('b1', 'b'), agent('b2', 'b'), inner],
      edges: [
        edge('p', 'out', 'b'),
        edge('b', 'out', 'b1'),
        edge('b', 'out', 'b2'),
        edge('b1', 'out', 'k'),
        edge('b2', 'out', 'k'),
        edge('k', 'out', 'j'),
      ],
    });
    expect(errors(definition)).toEqual([]);
    expect(planRun(definition).ok).toBe(true);
  });
});
