import {
  type ControlEdge,
  type CorralDefinition,
  type CorralNode,
  CorralDefinition as Definition,
  type RunEvent,
} from '@corral/contracts';
import { FakeClock, Gate, ScriptedAgentAdapter, SequentialIdFactory } from '@corral/testkit';
import { describe, expect, it, vi } from 'vitest';
import researchTeam from '../../../examples/research-team.corral.json' with { type: 'json' };
import {
  Coordinator,
  type CoordinatorDeps,
  compileDefinition,
  type DecisionPolicy,
  type GraphRunner,
  InProcessTransport,
  planRun,
  type RunnerCallbacks,
  type RunProjection,
  reviewCriteriaHash,
  waitForProjection,
  walkPlan,
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
function runtime(
  held: Record<string, Gate>,
  decisions?: DecisionPolicy,
  released?: boolean[],
  deps: Partial<CoordinatorDeps> = {},
) {
  const clock = new FakeClock();
  return new InProcessTransport(
    new Coordinator({
      clock,
      ids: new SequentialIdFactory(),
      timers: clock,
      ...deps,
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
/** Executions that have not ended. */
const settled = (p: RunProjection) =>
  Object.values(p.executions).filter(
    (e) => !['succeeded', 'failed', 'cancelled'].includes(e.status),
  );
const afterJoin = (events: RunEvent[]) =>
  events.slice(events.findIndex((e) => e.type === 'workflow.joined') + 1);
const selected = (events: RunEvent[], nodeId: string) =>
  events.filter((e) => e.type === 'workflow.branch_selected' && e.payload.nodeId === nodeId);
const roundsOf = (events: RunEvent[], loopId: string) =>
  events.filter(
    (e) =>
      (e.type === 'loop.iteration_started' || e.type === 'loop.iteration_finished') &&
      e.payload.loopNodeId === loopId,
  );

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

/**
 * The Coordinator's own walker, logging each callback as it is reached (before the Coordinator
 * acts on it), so a test can show the loser had entered its wait before the Join fired.
 */
function recording(log: string[], before?: (name: string, args: unknown[]) => void): GraphRunner {
  return {
    run: (plan, callbacks, signal) =>
      walkPlan(
        plan,
        Object.fromEntries(
          Object.entries(callbacks).map(([name, fn]) => [
            name,
            (...args: unknown[]) => {
              log.push(`${name} ${String(args[0])}`);
              before?.(name, args);
              return (fn as (...a: unknown[]) => unknown).apply(callbacks, args);
            },
          ]),
        ) as unknown as RunnerCallbacks,
        signal,
      ),
  };
}

// "any Join이 멈춘 분기는 그 뒤에 아무것도 시작하지 않는다": a step the stopped branch was
// about to start, still waiting inside the Coordinator when the Join fired, starts nothing.
describe('a branch an any Join stopped', () => {
  /** p → [x, j]: one branch runs x, the other reaches the any Join at once. */
  const direct = () =>
    team(
      [agent('p'), agent('x', 'p'), join('any'), agent('m', 'p'), output('m')],
      [
        edge('p', 'out', 'x'),
        edge('p', 'out', 'j'),
        edge('x', 'out', 'j'),
        edge('j', 'out', 'm'),
        edge('m', 'out', 'output'),
      ],
    );

  it('creates no execution of the step the stopped branch was about to start', async () => {
    const log: string[] = [];
    const transport = runtime({}, undefined, undefined, { runner: recording(log) });
    const { runId, events } = await run(transport, direct());
    const final = await waitForProjection(transport, runId, finished);
    expect(log.indexOf('activate x')).toBeGreaterThan(-1);
    expect(log.indexOf('activate x')).toBeLessThan(log.indexOf('joined j'));
    expect(joins(events)).toEqual([
      { nodeId: 'j', policy: 'any', iterationId: null, cancelledNodeIds: ['x'] },
    ]);
    expect(executions(final, 'x')).toEqual([]);
    expect(final.status).toBe('succeeded');
    expect(settled(final)).toEqual([]);
  });

  it('creates no execution when the Join fired while the run was paused', async () => {
    const log: string[] = [];
    let coordinator: Coordinator | null = null;
    let runId = '';
    const clock = new FakeClock();
    coordinator = new Coordinator({
      clock,
      timers: clock,
      ids: new SequentialIdFactory(),
      agents: new ScriptedAgentAdapter({ turns: 1, appendNotes: false }),
      // The run pauses as the losing branch is about to start x: x waits at the pause.
      runner: recording(log, (name, args) => {
        if (name !== 'activate' || args[0] !== 'x') return;
        coordinator?.submit({
          schemaVersion: '0.1',
          commandId: 'pause',
          runId,
          type: 'pause',
          payload: { scope: 'run' },
        });
      }),
    });
    const transport = new InProcessTransport(coordinator);
    const started = await run(transport, direct());
    runId = started.runId;
    const paused = await waitForProjection(
      transport,
      runId,
      (p) => p.status === 'paused' && joins(started.events).length > 0,
    );
    expect(log.indexOf('activate x')).toBeLessThan(log.indexOf('joined j'));
    expect(executions(paused, 'x')).toEqual([]);
    coordinator.submit({
      schemaVersion: '0.1',
      commandId: 'resume',
      runId,
      type: 'resume',
      payload: { scope: 'run' },
    });
    const final = await waitForProjection(transport, runId, finished);
    expect(final.status).toBe('succeeded');
    expect(executions(final, 'x')).toEqual([]);
    expect(executions(final, 'm')).toHaveLength(1);
    expect(settled(final)).toEqual([]);
  });

  it('opens no round of the Loop the stopped branch was entering', async () => {
    // p → [Loop l [ w → d ], j]; l.next → j.
    const log: string[] = [];
    const transport = runtime({}, { decide: async () => 'pass' }, undefined, {
      runner: recording(log),
    });
    const definition = team(
      [
        agent('p'),
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
        join('any'),
        agent('m', 'p'),
        output('m'),
      ],
      [
        edge('p', 'out', 'l', 'enter'),
        edge('p', 'out', 'j'),
        edge('l', 'body', 'w'),
        edge('w', 'out', 'd'),
        edge('d', 'pass', 'l', 'exit'),
        edge('d', 'revise', 'l', 'repeat'),
        edge('l', 'next', 'j'),
        edge('j', 'out', 'm'),
        edge('m', 'out', 'output'),
      ],
    );
    const { runId, events } = await run(transport, definition);
    const final = await waitForProjection(transport, runId, finished);
    expect(log.indexOf('loopEntered l')).toBeGreaterThan(-1);
    expect(log.indexOf('loopEntered l')).toBeLessThan(log.indexOf('joined j'));
    expect(final.status).toBe('succeeded');
    expect(roundsOf(events, 'l')).toEqual([]);
    expect(executions(final, 'w')).toEqual([]);
    expect(settled(final)).toEqual([]);
  });

  it('starts no chooser of a router the stopped branch was about to decide', async () => {
    // p → [router d, j]; d.go → j.
    const log: string[] = [];
    const transport = runtime({}, undefined, undefined, { runner: recording(log) });
    const router: CorralNode = {
      id: 'd',
      type: 'decision',
      label: 'd',
      mode: 'router',
      routes: [
        { id: 'go', label: 'go' },
        { id: 'stay', label: 'stay' },
      ],
      inputBindings: [{ kind: 'task_output', name: 'input', sourceNodeId: 'p' }],
    };
    const definition = team(
      [agent('p'), router, join('any'), agent('m', 'p'), output('m')],
      [
        edge('p', 'out', 'd'),
        edge('p', 'out', 'j'),
        edge('d', 'go', 'j'),
        edge('j', 'out', 'm'),
        edge('m', 'out', 'output'),
      ],
    );
    const { runId, events } = await run(transport, definition);
    const final = await waitForProjection(transport, runId, finished);
    expect(log.indexOf('decide d')).toBeGreaterThan(-1);
    expect(log.indexOf('decide d')).toBeLessThan(log.indexOf('joined j'));
    expect(final.status).toBe('succeeded');
    expect(executions(final, 'd')).toEqual([]);
    expect(selected(events, 'd')).toEqual([]);
    expect(settled(final)).toEqual([]);
  });

  it('records no route of a Decision in a cancelled round that was waiting to decide', async () => {
    // p → [Loop l [ rule d ], j]. A scripted runner asks d to decide and, while d waits at
    // its first boundary, reports the Join that stops it and cancels l's round: the order the
    // walker produces when the other branch reaches j during that wait.
    const consulted: string[] = [];
    const branches: (string | null)[] = [];
    const runner: GraphRunner = {
      run: async (_plan, callbacks) => {
        await callbacks.activate('p', null);
        await callbacks.loopEntered('l', 1);
        const deciding = callbacks.decide('d', { loopId: 'l', no: 1 });
        await callbacks.joined(
          'j',
          null,
          [{ nodeId: 'd', iteration: { loopId: 'l', no: 1 } }],
          [{ loopId: 'l', no: 1 }],
        );
        branches.push(await deciding.catch(() => 'threw'));
        await callbacks.activate('m', null);
        await callbacks.finalize('output');
        return { kind: 'finished', outputNodeId: 'output' };
      },
    };
    const transport = runtime(
      {},
      {
        decide: async ({ nodeId }) => {
          consulted.push(nodeId);
          return 'yes';
        },
      },
      undefined,
      { runner },
    );
    const definition = team(
      [
        agent('p'),
        { id: 'l', type: 'loop', label: 'l', maxIterations: 3 } as CorralNode,
        {
          id: 'd',
          type: 'decision',
          label: 'd',
          mode: 'rule',
          rule: 'required_tasks_submitted',
          parentId: 'l',
          inputBindings: [{ kind: 'task_output', name: 'input', sourceNodeId: 'p' }],
        },
        join('any'),
        agent('m', 'p'),
        output('m'),
      ],
      [
        edge('p', 'out', 'l', 'enter'),
        edge('p', 'out', 'j'),
        edge('l', 'body', 'd'),
        edge('d', 'yes', 'l', 'exit'),
        edge('d', 'no', 'l', 'repeat'),
        edge('l', 'next', 'j'),
        edge('j', 'out', 'm'),
        edge('m', 'out', 'output'),
      ],
    );
    expect(planRun(definition).ok).toBe(true);
    const { runId, events } = await run(transport, definition);
    const final = await waitForProjection(transport, runId, finished);
    expect(final.status).toBe('succeeded');
    expect(roundsOf(events, 'l').map((e) => e.type)).toEqual([
      'loop.iteration_started',
      'loop.iteration_finished',
    ]);
    expect(branches).toEqual([null]);
    expect(consulted).toEqual([]);
    expect(selected(afterJoin(events), 'd')).toEqual([]);
  });
});

// A recipe Loop the stopped branch was entering: its criteria pin is slow, and settles late.
describe('a recipe Loop entry an any Join stopped', () => {
  const criteriaFile = { path: 'criteria.md', sha256: 'a'.repeat(64) };
  const recipe = {
    recipeId: 'quality',
    revision: 1,
    criteriaHash: reviewCriteriaHash(base.input.criteria),
    candidateNodeId: 'write',
    evaluatorRoleId: 'reviewer',
    checkIds: [],
    criteriaFiles: [criteriaFile],
    maxAttempts: 3,
    maxRepairs: 2,
  };
  const review = (id: string, source: string, parentId: string): CorralNode => ({
    id,
    type: 'decision',
    label: id,
    mode: 'review',
    rule: 'review_verdict',
    parentId,
    inputBindings: [{ kind: 'task_output', name: 'review', sourceNodeId: source }],
  });
  const reviewer = (id: string, source: string, parentId: string): CorralNode => ({
    id,
    type: 'agent',
    label: id,
    roleId: 'reviewer',
    invocation: 'scheduled',
    parentId,
    inputBindings: [
      { kind: 'task_output', name: 'draft', sourceNodeId: source },
      { kind: 'run_input', name: 'criteria' },
    ],
    outputName: 'review',
  });
  /**
   * s → Loop o [ p → [ recipe Loop l [ write → review → rd ], x ] → Join j (any) → or → od ]
   * → output. od revises o's first round and passes its second.
   */
  function nested(): CorralDefinition {
    return Definition.parse({
      ...base,
      entryNodeId: 's',
      nodes: [
        agent('s'),
        { id: 'o', type: 'loop', label: 'o', maxIterations: 3 },
        { ...agent('p', 's'), parentId: 'o' },
        {
          id: 'l',
          type: 'loop',
          label: 'l',
          parentId: 'o',
          maxIterations: 3,
          reviewRecipe: recipe,
        },
        {
          ...agent('write', undefined, 'l'),
          inputBindings: [
            { kind: 'run_input', name: 'brief' },
            { kind: 'run_input', name: 'criteria' },
          ],
        },
        reviewer('review', 'write', 'l'),
        review('rd', 'review', 'l'),
        agent('x', 'p', 'o'),
        { ...join('any'), parentId: 'o' },
        reviewer('or', 'p', 'o'),
        review('od', 'or', 'o'),
        output('p'),
      ],
      controlEdges: [
        edge('s', 'out', 'o', 'enter'),
        edge('o', 'body', 'p'),
        edge('p', 'out', 'l', 'enter'),
        edge('p', 'out', 'x'),
        edge('l', 'body', 'write'),
        edge('write', 'out', 'review'),
        edge('review', 'out', 'rd'),
        edge('rd', 'pass', 'l', 'exit'),
        edge('rd', 'revise', 'l', 'repeat'),
        edge('l', 'next', 'j'),
        edge('x', 'out', 'j'),
        edge('j', 'out', 'or'),
        edge('or', 'out', 'od'),
        edge('od', 'pass', 'o', 'exit'),
        edge('od', 'revise', 'o', 'repeat'),
        edge('o', 'next', 'output'),
      ],
      capabilityLinks: [],
    });
  }

  /**
   * The first pin waits for `firstPin`; later pins settle at once. In o's second round x waits
   * at its gate so l's fresh entry wins the Join, and write waits so the run stays live.
   */
  function recipeRuntime(
    firstPin: () => Promise<void>,
    gates: { x: Gate; write: Gate },
    heldX = 2,
  ) {
    const clock = new FakeClock();
    const pins: string[] = [];
    let xRuns = 0;
    const coordinator = new Coordinator({
      clock,
      timers: clock,
      ids: new SequentialIdFactory(),
      files: {
        available: () => false,
        execute: async () => {
          throw new Error('no file tools in this test');
        },
        pinCriteria: async () => {
          pins.push(pins.length === 0 ? 'first' : 'later');
          if (pins.length === 1) await firstPin();
        },
        validateCriteria: async () => true,
      },
      agents: new ScriptedAgentAdapter({
        turns: 1,
        collaborate: false,
        appendNotes: false,
        reply: (_turn, input) => `${input.nodeId} ${input.executionId}`,
        review: (input) => (input.nodeId === 'or' && (input.round ?? 1) === 1 ? 'revise' : 'pass'),
        beforeReply: async (_turn, input) => {
          if (input.nodeId === 'x' && ++xRuns === heldX) await gates.x.wait();
          if (input.nodeId === 'write') await gates.write.wait();
        },
      }),
    });
    return { transport: new InProcessTransport(coordinator), pins };
  }

  it.each<['resolves' | 'rejects', string]>([
    ['resolves', 'keeps the fresh round of the later entry open and finishes it'],
    ['rejects', 'neither stops the recipe nor fails the run'],
  ])('a late first pin that %s %s', async (settle) => {
    expect(planRun(nested()).ok).toBe(true);
    let release: (ok: boolean) => void = () => {};
    const firstPin = new Promise<void>((resolve, reject) => {
      release = (ok) => (ok ? resolve() : reject(new Error('criteria changed')));
    });
    const gates = { x: new Gate(), write: new Gate() };
    const { transport, pins } = recipeRuntime(() => firstPin, gates);
    const { runId, events } = await run(transport, nested());
    // o's second round: l's fresh entry has opened its round and write is running.
    const live = await waitForProjection(
      transport,
      runId,
      (p) => finished(p) || executions(p, 'write').some((e) => e.status === 'active'),
    );
    expect(live.status).toBe('running');
    expect(pins).toEqual(['first', 'later']);
    // o's first Join stopped l's entry while it waited on its first pin.
    expect(joins(events)[0]?.cancelledNodeIds).toEqual(['l']);
    const fresh = roundsOf(events, 'l');
    expect(fresh.map((e) => e.type)).toEqual(['loop.iteration_started']);
    const freshId = String(
      (fresh[0]?.payload as { iterationId?: string } | undefined)?.iterationId,
    );
    // The stopped first entry's pin settles while the winning run is live.
    release(settle === 'resolves');
    for (let i = 0; i < 50; i++) await Promise.resolve();
    gates.write.open();
    const final = await waitForProjection(transport, runId, (p) => {
      if (finished(p)) return true;
      if (joins(events).length === 2) gates.x.open();
      return false;
    });
    gates.x.open();
    expect(final.status).toBe('succeeded');
    expect(events.filter((e) => e.type === 'recipe.stopped')).toEqual([]);
    const ids = roundsOf(events, 'l').map((e) => [
      e.type,
      (e.payload as { iterationId: string }).iterationId,
    ]);
    expect(ids).toEqual([
      ['loop.iteration_started', freshId],
      ['loop.iteration_finished', freshId],
    ]);
    expect(final.iterations[freshId]?.outcome).toBe('pass');
  });

  /** p → [ recipe Loop l [ write → review → rd ], x ] → Join j (any) → m → output. */
  function flat(): CorralDefinition {
    return Definition.parse({
      ...base,
      entryNodeId: 'p',
      nodes: [
        agent('p'),
        { id: 'l', type: 'loop', label: 'l', maxIterations: 3, reviewRecipe: recipe },
        {
          ...agent('write', undefined, 'l'),
          inputBindings: [
            { kind: 'run_input', name: 'brief' },
            { kind: 'run_input', name: 'criteria' },
          ],
        },
        reviewer('review', 'write', 'l'),
        review('rd', 'review', 'l'),
        agent('x', 'p'),
        join('any'),
        agent('m', 'p'),
        output('m'),
      ],
      controlEdges: [
        edge('p', 'out', 'l', 'enter'),
        edge('p', 'out', 'x'),
        edge('l', 'body', 'write'),
        edge('write', 'out', 'review'),
        edge('review', 'out', 'rd'),
        edge('rd', 'pass', 'l', 'exit'),
        edge('rd', 'revise', 'l', 'repeat'),
        edge('l', 'next', 'j'),
        edge('x', 'out', 'j'),
        edge('j', 'out', 'm'),
        edge('m', 'out', 'output'),
      ],
      capabilityLinks: [],
    });
  }

  /**
   * Holds the criteria check rd makes for its recipe evidence (any check once the reviewer has
   * started) until `release`; x and m wait at their gates.
   */
  function evidenceRuntime(gates: { x: Gate; m: Gate }) {
    const clock = new FakeClock();
    let reviewed = false;
    const held: ((valid: boolean) => void)[] = [];
    const coordinator = new Coordinator({
      clock,
      timers: clock,
      ids: new SequentialIdFactory(),
      files: {
        available: () => false,
        execute: async () => {
          throw new Error('no file tools in this test');
        },
        pinCriteria: async () => {},
        validateCriteria: () =>
          reviewed ? new Promise<boolean>((resolve) => held.push(resolve)) : Promise.resolve(true),
      },
      agents: new ScriptedAgentAdapter({
        turns: 1,
        collaborate: false,
        appendNotes: false,
        reply: (_turn, input) => `${input.nodeId} ${input.executionId}`,
        review: () => 'pass',
        beforeReply: async (_turn, input) => {
          if (input.nodeId === 'review') reviewed = true;
          if (input.nodeId === 'x') await gates.x.wait();
          if (input.nodeId === 'm') await gates.m.wait();
        },
      }),
    });
    return {
      transport: new InProcessTransport(coordinator),
      held: () => held.length,
      release: (valid: boolean) => {
        for (const resolve of held.splice(0)) resolve(valid);
      },
    };
  }

  it.each([false, true])(
    'drops the recipe evidence check (valid: %s) of a review Decision stopped meanwhile',
    async (valid) => {
      expect(planRun(flat()).ok).toBe(true);
      const gates = { x: new Gate(), m: new Gate() };
      const s = evidenceRuntime(gates);
      const { runId, events } = await run(s.transport, flat());
      // rd is checking its evidence; x then wins the Join and m keeps the run live.
      await vi.waitFor(() => expect(s.held()).toBe(1));
      gates.x.open();
      await waitForProjection(s.transport, runId, () => joins(events).length > 0);
      expect(joins(events)[0]?.cancelledNodeIds).toEqual(['rd']);
      s.release(valid);
      for (let i = 0; i < 50; i++) await Promise.resolve();
      gates.m.open();
      const final = await waitForProjection(s.transport, runId, finished);
      expect([final.status, final.statusReason]).toEqual(['succeeded', 'output_finalized']);
      expect(events.filter((e) => e.type === 'recipe.stopped')).toEqual([]);
      expect(afterJoin(events).filter((e) => e.type === 'recipe.evaluated')).toEqual([]);
      expect(selected(events, 'rd')).toEqual([]);
    },
  );

  it('still evaluates the recipe evidence of a review Decision nobody stopped', async () => {
    const gates = { x: new Gate(), m: new Gate() };
    gates.m.open();
    const s = evidenceRuntime(gates);
    const { runId, events } = await run(s.transport, flat());
    await vi.waitFor(() => expect(s.held()).toBe(1));
    s.release(true);
    const final = await waitForProjection(s.transport, runId, (p) => {
      if (joins(events).length > 0) gates.x.open();
      return finished(p);
    });
    expect(final.status).toBe('succeeded');
    expect(events.filter((e) => e.type === 'recipe.evaluated')).toHaveLength(1);
    expect(joins(events)[0]?.cancelledNodeIds).toEqual(['x']);
  });

  it('still stops the recipe when the pin of an entry nobody stopped fails', async () => {
    const gates = { x: new Gate(), write: new Gate() };
    // x is held in o's first round, so l's entry is not stopped; its pin fails.
    const { transport } = recipeRuntime(
      () => Promise.reject(new Error('criteria changed')),
      gates,
      1,
    );
    const { runId, events } = await run(transport, nested());
    const final = await waitForProjection(transport, runId, (p) => {
      if (p.status !== 'running') gates.x.open();
      return finished(p);
    });
    expect(final.status).toBe('failed');
    expect(final.statusReason).toBe('review_recipe:criteria_changed');
    expect(events.filter((e) => e.type === 'recipe.stopped')).toHaveLength(1);
  });
});

// "병렬 실행": a branch stopped while it passed another Join fans out past it no more.
describe('a branch stopped while it passed another Join', () => {
  const rule = (id: string, parentId?: string): CorralNode =>
    ({
      id,
      type: 'decision',
      label: id,
      mode: 'rule',
      rule: 'required_tasks_submitted',
      inputBindings: [{ kind: 'task_output', name: 'input', sourceNodeId: 'p' }],
      ...(parentId ? { parentId } : {}),
    }) as CorralNode;
  /**
   * Loop o [ p → [dx0, dy0]; dx0.yes → [dx, a2]; dx.yes → j2 (any) ← a2; j2 → [c1, c2] → j3
   * (all) → j1; dy0.yes → dy; dy.yes → j1 (any) → od ], od's no: o.repeat, yes: o.exit;
   * o.next → m → output.
   */
  function passingJoin(): CorralDefinition {
    return Definition.parse({
      ...base,
      entryNodeId: 'o',
      nodes: [
        { id: 'o', type: 'loop', label: 'o', maxIterations: 3 },
        { ...agent('p'), parentId: 'o' },
        rule('dx0', 'o'),
        rule('dy0', 'o'),
        rule('dx', 'o'),
        agent('a2', 'p', 'o'),
        { id: 'j2', type: 'join', label: 'j2', parentId: 'o', policy: 'any' },
        agent('c1', 'p', 'o'),
        agent('c2', 'p', 'o'),
        { id: 'j3', type: 'join', label: 'j3', parentId: 'o', policy: 'all' },
        rule('dy', 'o'),
        { id: 'j1', type: 'join', label: 'j1', parentId: 'o', policy: 'any' },
        rule('od', 'o'),
        agent('m', 'p'),
        output('m'),
      ],
      controlEdges: [
        edge('o', 'body', 'p'),
        edge('p', 'out', 'dx0'),
        edge('p', 'out', 'dy0'),
        edge('dx0', 'yes', 'dx'),
        edge('dx0', 'yes', 'a2'),
        edge('dx', 'yes', 'j2'),
        edge('a2', 'out', 'j2'),
        edge('j2', 'out', 'c1'),
        edge('j2', 'out', 'c2'),
        edge('c1', 'out', 'j3'),
        edge('c2', 'out', 'j3'),
        edge('j3', 'out', 'j1'),
        edge('dy0', 'yes', 'dy'),
        edge('dy', 'yes', 'j1'),
        edge('j1', 'out', 'od'),
        edge('od', 'no', 'o', 'repeat'),
        edge('od', 'yes', 'o', 'exit'),
        edge('o', 'next', 'm'),
        edge('m', 'out', 'output'),
      ],
      capabilityLinks: [],
    });
  }

  it('starts nothing after the Join it was passing, and the Loop goes round again', async () => {
    expect(planRun(passingJoin()).ok).toBe(true);
    const log: string[] = [];
    const answers = ['no', 'yes'];
    // a2 stands in for a slow agent; c2 would outlast the opening of o's next round.
    const a2 = new Gate();
    const c2 = new Gate();
    const transport = runtime(
      { a2, c2 },
      { decide: async ({ nodeId }) => (nodeId === 'od' ? (answers.shift() ?? 'yes') : 'yes') },
      undefined,
      { runner: recording(log) },
    );
    const { runId, events } = await run(transport, passingJoin());
    const final = await waitForProjection(transport, runId, (p) => {
      if (finished(p)) return true;
      // Once o's second round has opened, the held agents may end.
      if ((p.loopIterations.o ?? []).length === 2) {
        a2.open();
        c2.open();
      }
      return false;
    });
    a2.open();
    c2.open();
    expect([final.status, final.statusReason]).toEqual(['succeeded', 'output_finalized']);
    const passed = joins(events).map((j) => j.nodeId);
    expect(passed).toEqual(['j2', 'j1', 'j2', 'j1']);
    // j1 stopped the branch that passed j2: neither c1 nor c2 ran in either round.
    expect(log.filter((line) => /activate c[12]/.test(line))).toEqual([]);
    expect(executions(final, 'c1')).toEqual([]);
    expect(executions(final, 'c2')).toEqual([]);
  });
});

// "끝난 회차의 분기": once a Loop round has ended, a branch still in it goes no further.
describe('a branch whose Loop round has ended', () => {
  /**
   * s → Loop l [ p → [ d, e ] → Join j (any) → f → output ], f.revise → g (yes: repeat, no:
   * exit), l.next → after → done. d's inconclusive has no edge.
   */
  function inconclusiveInLoop(): CorralDefinition {
    const decision = (id: string, mode: 'review' | 'rule'): CorralNode =>
      ({
        id,
        type: 'decision',
        label: id,
        mode,
        rule: mode === 'review' ? 'review_verdict' : 'required_tasks_submitted',
        parentId: 'l',
        inputBindings: [{ kind: 'task_output', name: 'input', sourceNodeId: 'p' }],
      }) as CorralNode;
    return Definition.parse({
      ...base,
      entryNodeId: 's',
      nodes: [
        agent('s'),
        { id: 'l', type: 'loop', label: 'l', maxIterations: 3 },
        agent('p', 's', 'l', 'reviewer'),
        decision('d', 'review'),
        decision('e', 'review'),
        { ...join('any'), parentId: 'l' },
        decision('f', 'review'),
        decision('g', 'rule'),
        { ...output('p'), parentId: 'l' },
        agent('after', 's'),
        { ...output('after'), id: 'done' },
      ],
      controlEdges: [
        edge('s', 'out', 'l', 'enter'),
        edge('l', 'body', 'p'),
        edge('p', 'out', 'd'),
        edge('p', 'out', 'e'),
        edge('d', 'pass', 'j'),
        edge('e', 'pass', 'j'),
        edge('j', 'out', 'f'),
        edge('f', 'pass', 'output'),
        edge('f', 'revise', 'g'),
        edge('g', 'yes', 'l', 'repeat'),
        edge('g', 'no', 'l', 'exit'),
        edge('l', 'next', 'after'),
        edge('after', 'out', 'done'),
      ],
      capabilityLinks: [],
    });
  }

  it('ends the run with the needs_user of the Decision that ended the round', async () => {
    expect(
      compileDefinition(inconclusiveInLoop()).diagnostics.filter((d) => d.severity === 'error'),
    ).toEqual([]);
    // d and e decide together once both are waiting: d ends the round inconclusive, and e
    // reaches the Join before d's branch ends the run.
    const gate = new Gate();
    const waiting: string[] = [];
    const log: string[] = [];
    const transport = runtime(
      {},
      {
        decide: async ({ nodeId }) => {
          if (nodeId === 'd' || nodeId === 'e') {
            waiting.push(nodeId);
            await gate.wait();
          }
          return nodeId === 'd' ? 'inconclusive' : 'pass';
        },
      },
      undefined,
      { runner: recording(log) },
    );
    const { runId, events } = await run(transport, inconclusiveInLoop());
    await vi.waitFor(() => expect(waiting).toEqual(['d', 'e']));
    gate.open();
    const final = await waitForProjection(transport, runId, finished);
    const types = events.map((e) => e.type);
    expect(log).toContain('loopLeft l');
    expect(final.status).toBe('failed');
    expect(final.statusReason).toBe('needs_user: d inconclusive');
    expect(types).not.toContain('output.finalized');
    expect(types).not.toContain('workflow.joined');
  });

  it('keeps that needs_user when a sibling approval then ends as rejected', async () => {
    // e is an approval whose reject has no edge. d and e decide together, as above; this relies
    // on the order microtasks settle in, the runner contract pins the order itself.
    const definition = inconclusiveInLoop();
    definition.nodes = definition.nodes.map((node) =>
      node.id === 'e'
        ? ({ ...node, mode: 'approval', rule: 'human_approval' } as CorralNode)
        : node,
    );
    definition.controlEdges = definition.controlEdges.map((e) =>
      e.source === 'e' ? { ...e, sourcePort: 'approve' } : e,
    );
    expect(planRun(definition).ok).toBe(true);
    const gate = new Gate();
    const waiting: string[] = [];
    const transport = runtime(
      {},
      {
        decide: async ({ nodeId }) => {
          if (nodeId === 'd' || nodeId === 'e') {
            waiting.push(nodeId);
            await gate.wait();
          }
          return nodeId === 'd' ? 'inconclusive' : 'reject';
        },
      },
    );
    const { runId } = await run(transport, definition);
    await vi.waitFor(() => expect(waiting).toEqual(['d', 'e']));
    gate.open();
    const final = await waitForProjection(transport, runId, finished);
    expect([final.status, final.statusReason]).toEqual(['failed', 'needs_user: d inconclusive']);
  });
});

/**
 * s → Loop o [ Loop l [ w → r → d ] → output ] → done, where d's revise goes to both l's and
 * o's repeat: one port that fans out into two Loops' repeat.
 */
function twoRepeats(): CorralDefinition {
  return Definition.parse({
    ...base,
    entryNodeId: 's',
    nodes: [
      agent('s'),
      { id: 'o', type: 'loop', label: 'o', maxIterations: 3 },
      { id: 'l', type: 'loop', label: 'l', parentId: 'o', maxIterations: 3 },
      agent('w', 's', 'l'),
      {
        id: 'r',
        type: 'agent',
        label: 'r',
        roleId: 'reviewer',
        invocation: 'scheduled',
        parentId: 'l',
        inputBindings: [
          { kind: 'task_output', name: 'draft', sourceNodeId: 'w' },
          { kind: 'run_input', name: 'criteria' },
        ],
        outputName: 'review',
      },
      {
        id: 'd',
        type: 'decision',
        label: 'd',
        mode: 'review',
        rule: 'review_verdict',
        parentId: 'l',
        inputBindings: [{ kind: 'task_output', name: 'review', sourceNodeId: 'r' }],
      },
      { ...output('w'), parentId: 'o' },
      { ...output('w'), id: 'done' },
    ],
    controlEdges: [
      edge('s', 'out', 'o', 'enter'),
      edge('o', 'body', 'l', 'enter'),
      edge('l', 'body', 'w'),
      edge('w', 'out', 'r'),
      edge('r', 'out', 'd'),
      edge('d', 'pass', 'l', 'exit'),
      edge('d', 'revise', 'l', 'repeat'),
      edge('d', 'revise', 'o', 'repeat'),
      edge('l', 'next', 'output'),
      edge('l', 'exhausted', 'o', 'exit'),
      edge('o', 'next', 'done'),
    ],
    capabilityLinks: [],
  });
}

// "모이기 전에 끝나는 분기는 오류다": a fan-out into a Loop's repeat does not start.
describe('a fan-out into a repeat', () => {
  it('is refused at the start of the run', async () => {
    const { runId, receipt } = await runtime({}).startRun({
      schemaVersion: '0.1',
      commandId: `cmd_${++n}`,
      definition: twoRepeats(),
      mode: 'mock',
    });
    expect(runId).toBeNull();
    expect(receipt.error?.code).toBe('GRAPH_INVALID');
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

  // "모이기 전에 끝나는 분기는 오류다": a fan-out port that leads straight into a repeat.
  describe('a fan-out port straight into a repeat', () => {
    const unjoined = (definition: CorralDefinition) =>
      errors(definition)
        .filter((d) => d.code === 'PARALLEL_UNJOINED')
        .map((d) => {
          const e = definition.controlEdges.find((edge) => edge.id === d.edgeId);
          return `${e?.source}.${e?.sourcePort} → ${e?.target}.${e?.targetPort}`;
        });
    const router = (id: string, source: string, parentId?: string): CorralNode => ({
      id,
      type: 'decision',
      label: id,
      mode: 'router',
      routes: [
        { id: 'a', label: 'a' },
        { id: 'b', label: 'b' },
      ],
      inputBindings: [{ kind: 'task_output', name: 'input', sourceNodeId: source }],
      ...(parentId ? { parentId } : {}),
    });
    const reviewer = (id: string, source: string, parentId: string): CorralNode => ({
      id,
      type: 'agent',
      label: id,
      roleId: 'reviewer',
      invocation: 'scheduled',
      parentId,
      inputBindings: [
        { kind: 'task_output', name: 'draft', sourceNodeId: source },
        { kind: 'run_input', name: 'criteria' },
      ],
      outputName: 'review',
    });
    const review = (id: string, source: string, parentId: string): CorralNode => ({
      id,
      type: 'decision',
      label: id,
      mode: 'review',
      rule: 'review_verdict',
      parentId,
      inputBindings: [{ kind: 'task_output', name: 'review', sourceNodeId: source }],
    });
    /**
     * s → Loop o [ Loop l [ w → r → d, router x ] → r2 → od ] → output, with od's pass: o.exit,
     * revise: o.repeat. `ports` wires d's pass and revise; x has no edges of its own.
     */
    const nested = (ports: ControlEdge[], withX = true) =>
      team(
        [
          agent('s'),
          { id: 'o', type: 'loop', label: 'o', maxIterations: 3 } as CorralNode,
          { id: 'l', type: 'loop', label: 'l', parentId: 'o', maxIterations: 3 } as CorralNode,
          agent('w', 's', 'l'),
          reviewer('r', 'w', 'l'),
          review('d', 'r', 'l'),
          ...(withX ? [router('x', 'w', 'l')] : []),
          reviewer('r2', 'w', 'o'),
          review('od', 'r2', 'o'),
          output('w'),
        ],
        [
          edge('s', 'out', 'o', 'enter'),
          edge('o', 'body', 'l', 'enter'),
          edge('l', 'body', 'w'),
          edge('w', 'out', 'r'),
          edge('r', 'out', 'd'),
          ...ports,
          edge('l', 'next', 'r2'),
          edge('r2', 'out', 'od'),
          edge('od', 'pass', 'o', 'exit'),
          edge('od', 'revise', 'o', 'repeat'),
          edge('o', 'next', 'output'),
        ],
      );
    const withEntry = (definition: CorralDefinition) => ({ ...definition, entryNodeId: 's' });

    it('refuses one port into an outer and an inner Loop’s repeat on both edges', () => {
      expect(unjoined(twoRepeats())).toEqual(['d.revise → l.repeat', 'd.revise → o.repeat']);
    });

    it('refuses one port into a step and its Loop’s repeat on the repeat edge', () => {
      const definition = withEntry(
        nested([
          edge('d', 'pass', 'l', 'exit'),
          edge('d', 'revise', 'l', 'repeat'),
          edge('d', 'revise', 'x'),
        ]),
      );
      expect(unjoined(definition)).toEqual(['d.revise → l.repeat']);
    });

    it('accepts one edge into a repeat, and two ports into two Loops’ repeat', () => {
      expect(errors(base)).toEqual([]);
      const definition = withEntry(
        nested([edge('d', 'pass', 'l', 'exit'), edge('d', 'revise', 'l', 'repeat')], false),
      );
      expect(errors(definition)).toEqual([]);
    });

    it('already refuses a port into its Loop’s exit and a step, and into an Output and a step', () => {
      const exit = withEntry(
        nested([
          edge('d', 'pass', 'l', 'exit'),
          edge('d', 'pass', 'x'),
          edge('d', 'revise', 'l', 'repeat'),
        ]),
      );
      expect(unjoined(exit)).toContain('d.pass → l.exit');
      const outputAndStep = team(
        [agent('p'), router('x', 'p'), output('p')],
        [edge('p', 'out', 'output'), edge('p', 'out', 'x')],
      );
      expect(unjoined(outputAndStep)).toContain('p.out → output.in');
    });
  });
});
