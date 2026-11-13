import {
  type AgentStartInput,
  type ControlEdge,
  type CorralDefinition,
  type CorralNode,
  DEFAULT_LIMITS,
  CorralDefinition as Definition,
  type EffectiveHarnessSnapshot,
  type LoopLimitPolicy,
  type ReasoningLevel,
  type ReasoningPolicy,
  type RunEvent,
} from '@corral/contracts';
import {
  FakeClock,
  Gate,
  ScriptedAgentAdapter,
  type ScriptedAgentOptions,
  SequentialIdFactory,
} from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import {
  applyEvent,
  Coordinator,
  compileDefinition,
  type DecisionPolicy,
  emptyProjection,
  InMemoryRunStore,
  InProcessTransport,
  type RunProjection,
  reviewCriteriaHash,
  waitForProjection,
} from '../src/index.ts';

// A Loop's limit policy at its cap or a stall (docs/specs/features/team-graph.md, "루프 실행").

type Doc = any;

const LEVELS: Record<string, ReasoningLevel[]> = {
  'model-a': ['low', 'medium', 'high', 'xhigh'],
  'model-b': ['low', 'medium', 'high', 'xhigh'],
  'model-u': ['low', 'medium', 'high', 'xhigh'],
  'model-h': ['low', 'medium', 'high', 'xhigh'],
};

const fixed = (level: ReasoningLevel): ReasoningPolicy => ({ mode: 'fixed', level });
const role = (id: string, modelProfile: string, extra: Doc = {}): Doc => ({
  id,
  name: id,
  prompt: `Act as ${id}.`,
  modelProfile,
  allowedWorkTools: ['write_artifact'],
  allowedCollaborationTools: ['submit_result'],
  outputContract: id === 'reviewer' ? 'review' : 'draft',
  ...extra,
});
const writer = (id: string, parentId?: string, roleId = 'writer'): CorralNode => ({
  id,
  type: 'agent',
  label: id,
  roleId,
  invocation: 'scheduled',
  inputBindings: [{ kind: 'run_input', name: 'brief' }],
  outputName: 'draft',
  ...(parentId ? { parentId } : {}),
});
const reviewer = (id: string, draft: string, parentId?: string): CorralNode => ({
  id,
  type: 'agent',
  label: id,
  roleId: 'reviewer',
  invocation: 'scheduled',
  inputBindings: [
    { kind: 'task_output', name: 'draft', sourceNodeId: draft },
    { kind: 'run_input', name: 'criteria' },
  ],
  outputName: 'review',
  ...(parentId ? { parentId } : {}),
});
const decision = (id: string, read: string, parentId?: string): CorralNode => ({
  id,
  type: 'decision',
  label: id,
  mode: 'review',
  rule: 'review_verdict',
  inputBindings: [{ kind: 'task_output', name: 'review', sourceNodeId: read }],
  ...(parentId ? { parentId } : {}),
});
/** A rule Decision on any step's output: `yes` and `no`, answered by the script. */
const rule = (id: string, read: string, parentId?: string): CorralNode => ({
  id,
  type: 'decision',
  label: id,
  mode: 'rule',
  rule: 'required_tasks_submitted',
  inputBindings: [{ kind: 'task_output', name: 'work', sourceNodeId: read }],
  ...(parentId ? { parentId } : {}),
});
const loop = (id: string, extra: Doc = {}, parentId?: string): CorralNode =>
  ({
    id,
    type: 'loop',
    label: id,
    ...(parentId ? { parentId } : {}),
    ...extra,
  }) as CorralNode;
const output = (read: string): CorralNode => ({
  id: 'output',
  type: 'output',
  label: 'output',
  inputBindings: [{ kind: 'task_output', name: 'final', sourceNodeId: read }],
  requireApproval: false,
});

let edgeNo = 0;
const edge = (source: string, sourcePort: string, target: string, targetPort = 'in') =>
  ({ id: `e${++edgeNo}`, source, sourcePort, target, targetPort }) as ControlEdge;

function team(
  nodes: CorralNode[],
  controlEdges: ControlEdge[],
  roles: Doc[] = [role('writer', 'model-a'), role('reviewer', 'model-b')],
  entryNodeId = 'loop',
  id = 'limits',
): CorralDefinition {
  return Definition.parse({
    schemaVersion: '0.1',
    id,
    name: id,
    entryNodeId,
    input: { brief: 'Write it.', criteria: ['It is written.'] },
    roles,
    nodes,
    controlEdges,
    capabilityLinks: [],
    limits: DEFAULT_LIMITS,
  });
}

/**
 * Loop `loop` [write → review → decision (pass: exit, revise: repeat)]; exhausted leads to the
 * fallback F unless `fallback` is false. The run starts at the Loop.
 */
function reviewed(
  loopExtra: Doc,
  { fallback = true, roles }: { fallback?: boolean; roles?: Doc[] } = {},
): CorralDefinition {
  return team(
    [
      loop('loop', loopExtra),
      writer('write', 'loop'),
      reviewer('review', 'write', 'loop'),
      decision('decide', 'review', 'loop'),
      ...(fallback ? [writer('fallback')] : []),
      output(fallback ? 'fallback' : 'write'),
    ],
    [
      edge('loop', 'body', 'write'),
      edge('write', 'out', 'review'),
      edge('review', 'out', 'decide'),
      edge('decide', 'pass', 'loop', 'exit'),
      edge('decide', 'revise', 'loop', 'repeat'),
      ...(fallback
        ? [
            edge('loop', 'next', 'fallback'),
            edge('loop', 'exhausted', 'fallback'),
            edge('fallback', 'out', 'output'),
          ]
        : [edge('loop', 'next', 'output')]),
    ],
    roles,
  );
}

/** Decisions answer from a script per node; a missing answer is `revise`. */
const scripted = (
  script: Record<string, string[]>,
  before?: (request: Parameters<DecisionPolicy['decide']>[0]) => Promise<void>,
) => ({
  decide: async (request: Parameters<DecisionPolicy['decide']>[0]) => {
    await before?.(request);
    return script[request.nodeId]?.shift() ?? 'revise';
  },
});

interface Request {
  nodeId: string;
  round: number | null;
  modelProfile: string;
  reasoning: ReasoningPolicy | undefined;
  input: AgentStartInput;
}

function runtime(
  options: {
    decisions?: DecisionPolicy;
    agents?: Partial<ScriptedAgentOptions>;
    levels?: Record<string, ReasoningLevel[]>;
    store?: InMemoryRunStore;
    ids?: string;
    corrals?: Record<string, CorralDefinition>;
    /** Model profiles whose workers run in Linux isolation. */
    isolated?: string[];
    harness?: EffectiveHarnessSnapshot;
    /** The host's turn between rounds: the FakeClock's by default; null for a Scheduler without one. */
    turn?: (() => Promise<void>) | null;
  } = {},
) {
  const clock = new FakeClock();
  const requests: Request[] = [];
  const levels = { ...LEVELS, ...options.levels };
  const store = options.store ?? new InMemoryRunStore();
  const coordinator = new Coordinator({
    clock,
    timers:
      options.turn === undefined
        ? clock
        : {
            after: (ms: number, fn: () => void) => clock.after(ms, fn),
            ...(options.turn ? { turn: options.turn } : {}),
          },
    store,
    ids: new SequentialIdFactory(options.ids),
    ...(options.ids ? { sessionId: `backend_${options.ids}` } : {}),
    decisions: options.decisions ?? scripted({}),
    agents: new ScriptedAgentAdapter({
      turns: 1,
      ...options.agents,
      beforeReply: async (turn, input) => {
        if (turn === 1)
          requests.push({
            nodeId: input.nodeId,
            round: input.round,
            modelProfile: input.modelProfile,
            reasoning: input.role.reasoning,
            input,
          });
        await options.agents?.beforeReply?.(turn, input);
      },
    }),
    models: {
      resolve: (profile) =>
        levels[profile]
          ? {
              ok: true,
              snapshot: {
                profile,
                provider: 'openai-codex',
                modelId: `${profile}-id`,
                auth: 'oauth',
                reasoning: { levels: levels[profile], providerDefault: true },
                ...(options.isolated?.includes(profile)
                  ? { workerIsolation: 'linux-bwrap' as const }
                  : {}),
              },
            }
          : { ok: false, code: 'CAPABILITY_DENIED', reason: 'not configured' },
    },
    ...(options.harness
      ? {
          harnesses: {
            resolve: () => JSON.parse(JSON.stringify(options.harness)) as EffectiveHarnessSnapshot,
          },
        }
      : {}),
    ...(options.corrals
      ? {
          corrals: {
            getDefinition: (corralId: string, revision: number) =>
              (revision === 1 ? options.corrals?.[corralId] : null) ?? null,
          },
        }
      : {}),
  });
  const transport = new InProcessTransport(coordinator);
  return { coordinator, transport, requests, store };
}

async function start(
  transport: InProcessTransport,
  definition: CorralDefinition,
  onEvent?: (event: RunEvent, runId: string) => void,
) {
  const { runId, receipt } = await transport.startRun({
    schemaVersion: '0.1',
    commandId: `cmd_${++edgeNo}`,
    definition,
    mode: 'live',
  });
  if (!runId) throw new Error(JSON.stringify(receipt.error));
  const events: RunEvent[] = [];
  transport.subscribe(runId, 0, {
    onEvent: (event) => {
      events.push(event);
      onEvent?.(event, runId);
    },
  });
  return { runId, events };
}

/** The host's own timer: real time, unlike the FakeClock the Coordinator runs on. */
const hostTimeout = (globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown })
  .setTimeout;
const terminal = (p: RunProjection) =>
  ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(p.status);
const rounds = (p: RunProjection, loopId: string) =>
  (p.loopIterations[loopId] ?? []).map((id) => [p.iterations[id]?.no, p.iterations[id]?.outcome]);
const of = (requests: Request[], nodeId: string) =>
  requests.filter((r) => r.nodeId === nodeId).map((r) => [r.modelProfile, r.reasoning]);
const escalations = (events: RunEvent[]) =>
  events.flatMap((e) => (e.type === 'loop.escalated' ? [e.payload] : []));
const typesOf = (events: RunEvent[], types: string[]) =>
  events.filter((e) => types.includes(e.type)).map((e) => e.type);
const cancelRun = (coordinator: Coordinator, runId: string) =>
  coordinator.submit({
    schemaVersion: '0.1',
    commandId: `cancel_${++edgeNo}`,
    runId,
    type: 'cancel',
    payload: { scope: { kind: 'run' }, reason: 'stop' },
  });
const control = (
  coordinator: Coordinator,
  runId: string,
  type: 'pause' | 'resume',
  revision: number,
) =>
  coordinator.submit({
    schemaVersion: '0.1',
    commandId: `${type}_${++edgeNo}`,
    runId,
    type,
    expectedControlRevision: revision,
    payload: { scope: 'run' },
  });

const writerAt = (level: ReasoningLevel, profile = 'model-a') =>
  role('writer', profile, { reasoning: fixed(level) });
const reviewerAt = (level: ReasoningLevel, profile = 'model-b') =>
  role('reviewer', profile, { reasoning: fixed(level) });
const policy = (limitPolicy: LoopLimitPolicy, extra: Doc = {}) => ({ limitPolicy, ...extra });

describe('Loop limit policy', () => {
  it('raises reasoning at the cap once, then leaves through exhausted at the next cap', async () => {
    const { transport, requests } = runtime();
    const definition = reviewed(
      policy({ kind: 'raise_reasoning', level: 'high' }, { maxIterations: 2 }),
      { roles: [writerAt('medium'), reviewerAt('low')] },
    );
    const { runId, events } = await start(transport, definition);
    const final = await waitForProjection(transport, runId, terminal);
    expect(final.status).toBe('succeeded');
    expect(rounds(final, 'loop')).toEqual([
      [1, 'revise'],
      [2, 'revise'],
      [3, 'revise'],
      [4, 'cap_reached'],
    ]);
    const [second] = final.loopIterations.loop ?? [];
    expect(escalations(events)).toEqual([
      {
        loopNodeId: 'loop',
        iterationId: final.loopIterations.loop?.[1],
        reason: 'cap_reached',
        policy: 'raise_reasoning',
        nodeIds: ['write', 'review'],
        levels: { write: 'high', review: 'high' },
      },
    ]);
    expect(second).toBeDefined();
    expect(of(requests, 'write').map(([, r]) => r)).toEqual([
      fixed('medium'),
      fixed('medium'),
      fixed('high'),
      fixed('high'),
    ]);
    // The escalation ends round 2 as revise before round 3 opens.
    expect(
      typesOf(events, ['loop.escalated', 'loop.iteration_finished', 'loop.iteration_started']),
    ).toEqual([
      'loop.iteration_started',
      'loop.iteration_finished',
      'loop.iteration_started',
      'loop.escalated',
      'loop.iteration_finished',
      'loop.iteration_started',
      'loop.iteration_finished',
      'loop.iteration_started',
      'loop.iteration_finished',
    ]);
    expect(Object.keys(final.approvals)).toEqual([]);
    expect(final.nodeExecutions.fallback).toHaveLength(1);
    expect(final.loopEscalations?.loop).toEqual([
      expect.objectContaining({
        iterationId: final.loopIterations.loop?.[1],
        reason: 'cap_reached',
      }),
    ]);
  });

  it('switches the Loop Agents to the upper model, keeping their reasoning', async () => {
    const { transport, requests } = runtime();
    const definition = reviewed(
      policy({ kind: 'upper_model', modelProfile: 'model-u' }, { maxIterations: 1 }),
      { roles: [writerAt('medium'), role('reviewer', 'model-b')] },
    );
    const { runId, events } = await start(transport, definition);
    const final = await waitForProjection(transport, runId, terminal);
    expect(final.status).toBe('succeeded');
    expect(rounds(final, 'loop')).toEqual([
      [1, 'revise'],
      [2, 'cap_reached'],
    ]);
    expect(of(requests, 'write')).toEqual([
      ['model-a', fixed('medium')],
      ['model-u', fixed('medium')],
    ]);
    expect(of(requests, 'review')).toEqual([
      ['model-b', undefined],
      ['model-u', undefined],
    ]);
    // The step after the Loop is not in it.
    expect(of(requests, 'fallback')).toEqual([['model-a', fixed('medium')]]);
    expect(escalations(events)).toEqual([
      expect.objectContaining({
        policy: 'upper_model',
        modelProfile: 'model-u',
        nodeIds: ['write', 'review'],
      }),
    ]);
  });

  it('follows the policy on a stall, and stalls out once the upper model repeats too', async () => {
    const { transport, requests } = runtime({
      agents: { reply: (_turn, input) => (input.nodeId === 'write' ? 'The same draft.' : 'x') },
    });
    const definition = reviewed(
      policy(
        { kind: 'upper_model', modelProfile: 'model-u' },
        { maxIterations: 5, stallDetection: true },
      ),
    );
    const { runId, events } = await start(transport, definition);
    const final = await waitForProjection(transport, runId, terminal);
    expect(final.status).toBe('succeeded');
    expect(rounds(final, 'loop')).toEqual([
      [1, 'revise'],
      [2, 'revise'],
      [3, 'stalled'],
    ]);
    expect(escalations(events)).toEqual([
      expect.objectContaining({ reason: 'stalled', iterationId: final.loopIterations.loop?.[1] }),
    ]);
    expect(of(requests, 'write').map(([model]) => model)).toEqual([
      'model-a',
      'model-a',
      'model-u',
    ]);
    expect(final.nodeExecutions.fallback).toHaveLength(1);
  });

  it('applies once per entry, even when a second raise would change an Agent', async () => {
    let patched = false;
    const s = runtime({
      levels: { 'model-a': ['low', 'medium'] },
      agents: {
        beforeReply: async (_turn, input) => {
          // Round 2 runs at medium, all model-a has; a person moves it to a model with more.
          if (input.nodeId === 'write' && input.round === 2 && !patched) {
            patched = true;
            const { projection } = await s.transport.getSnapshot(input.runId);
            s.coordinator.submit({
              schemaVersion: '0.1',
              commandId: `patch_${++edgeNo}`,
              runId: input.runId,
              type: 'patch',
              expectedControlRevision: projection.controlRevision,
              payload: { kind: 'node_future', nodeId: 'write', modelProfile: 'model-h' },
            });
          }
        },
      },
    });
    const definition = reviewed(
      policy({ kind: 'raise_reasoning', level: 'xhigh' }, { maxIterations: 1 }),
      { roles: [writerAt('low'), reviewerAt('xhigh', 'model-h')] },
    );
    const { runId, events } = await start(s.transport, definition);
    const final = await waitForProjection(s.transport, runId, terminal);
    expect(final.status).toBe('succeeded');
    expect(rounds(final, 'loop')).toEqual([
      [1, 'revise'],
      [2, 'cap_reached'],
    ]);
    expect(escalations(events)).toEqual([
      expect.objectContaining({ nodeIds: ['write'], levels: { write: 'medium' } }),
    ]);
    expect(of(s.requests, 'write')).toEqual([
      ['model-a', fixed('low')],
      ['model-a', fixed('medium')],
    ]);
  });

  it('exhausts without loop.escalated when no Agent would change', async () => {
    const { transport, requests } = runtime();
    const definition = reviewed(
      policy({ kind: 'raise_reasoning', level: 'high' }, { maxIterations: 2 }),
      { roles: [writerAt('high'), reviewerAt('xhigh')] },
    );
    const { runId, events } = await start(transport, definition);
    const final = await waitForProjection(transport, runId, terminal);
    expect(final.status).toBe('succeeded');
    expect(rounds(final, 'loop')).toEqual([
      [1, 'revise'],
      [2, 'cap_reached'],
    ]);
    expect(escalations(events)).toEqual([]);
    expect(of(requests, 'write').map(([, r]) => r)).toEqual([fixed('high'), fixed('high')]);
  });

  it('leaves an Agent already on the upper model, and exhausts when every Agent is', async () => {
    const upper = policy({ kind: 'upper_model', modelProfile: 'model-u' }, { maxIterations: 1 });
    const some = runtime();
    const one = await start(
      some.transport,
      reviewed(upper, { roles: [role('writer', 'model-u'), role('reviewer', 'model-b')] }),
    );
    const first = await waitForProjection(some.transport, one.runId, terminal);
    expect(first.status).toBe('succeeded');
    expect(escalations(one.events)).toEqual([expect.objectContaining({ nodeIds: ['review'] })]);
    expect(of(some.requests, 'write').map(([m]) => m)).toEqual(['model-u', 'model-u']);

    const all = runtime();
    const two = await start(
      all.transport,
      reviewed(upper, { roles: [role('writer', 'model-u'), role('reviewer', 'model-u')] }),
    );
    const second = await waitForProjection(all.transport, two.runId, terminal);
    expect(second.status).toBe('succeeded');
    expect(rounds(second, 'loop')).toEqual([[1, 'cap_reached']]);
    expect(escalations(two.events)).toEqual([]);
    expect(second.nodeExecutions.fallback).toHaveLength(1);
  });

  it('names the cap when a round reaches the cap and stalls at once', async () => {
    const same = {
      reply: (_turn: number, input: AgentStartInput) => (input.nodeId === 'write' ? 'Same.' : 'x'),
    };
    const plain = runtime({ agents: same });
    const exhausting = await start(
      plain.transport,
      reviewed({ maxIterations: 2, stallDetection: true }),
    );
    const exhausted = await waitForProjection(plain.transport, exhausting.runId, terminal);
    expect(rounds(exhausted, 'loop')).toEqual([
      [1, 'revise'],
      [2, 'cap_reached'],
    ]);

    const raised = runtime({ agents: same });
    const escalating = await start(
      raised.transport,
      reviewed(
        policy(
          { kind: 'upper_model', modelProfile: 'model-u' },
          { maxIterations: 2, stallDetection: true },
        ),
      ),
    );
    await waitForProjection(raised.transport, escalating.runId, terminal);
    expect(escalations(escalating.events)).toEqual([
      expect.objectContaining({ reason: 'cap_reached' }),
    ]);
  });

  // Loop A [ Loop B [ b_write -> b_decide ] -> a_decide ]: both raise b_write, once per entry each.
  it.each([
    [
      'model',
      { kind: 'upper_model', modelProfile: 'model-u' },
      { kind: 'upper_model', modelProfile: 'model-h' },
    ],
    [
      'reasoning',
      { kind: 'raise_reasoning', level: 'medium' },
      { kind: 'raise_reasoning', level: 'high' },
    ],
  ] as const)(
    'gives an Agent in nested Loops the %s the latest raise set',
    async (item, outer, inner) => {
      const { transport, requests } = runtime({
        decisions: scripted({ b_decide: ['no', 'no', 'no', 'no'], a_decide: ['no', 'yes'] }),
      });
      const definition = team(
        [
          loop('loop', policy(outer, { maxIterations: 1 })),
          loop('inner', policy(inner, { maxIterations: 1 }), 'loop'),
          writer('b_write', 'inner'),
          rule('b_decide', 'b_write', 'inner'),
          rule('a_decide', 'b_write', 'loop'),
          output('b_write'),
        ],
        [
          edge('loop', 'body', 'inner', 'enter'),
          edge('inner', 'body', 'b_write'),
          edge('b_write', 'out', 'b_decide'),
          edge('b_decide', 'yes', 'inner', 'exit'),
          edge('b_decide', 'no', 'inner', 'repeat'),
          edge('inner', 'next', 'a_decide'),
          edge('inner', 'exhausted', 'a_decide'),
          edge('a_decide', 'yes', 'loop', 'exit'),
          edge('a_decide', 'no', 'loop', 'repeat'),
          edge('loop', 'next', 'output'),
        ],
        [writerAt('low')],
      );
      const { runId, events } = await start(transport, definition);
      const final = await waitForProjection(transport, runId, terminal);
      expect(final.status).toBe('succeeded');
      expect(escalations(events).map((e) => e.loopNodeId)).toEqual(['inner', 'loop', 'inner']);
      // B's second entry: A raised before it and B again after, so B's raise wins in its round 2.
      expect(of(requests, 'b_write').map(([m, r]) => (item === 'model' ? m : r))).toEqual(
        item === 'model'
          ? ['model-a', 'model-h', 'model-u', 'model-h']
          : [fixed('low'), fixed('high'), fixed('medium'), fixed('high')],
      );
    },
  );

  it.each([
    ['fixed at the fitted level', ['low', 'medium'], fixed('medium')],
    ['on a model with no level at or below the target', ['xhigh', 'max'], undefined],
  ] as const)(
    'fits an unsupported level down to the model, and leaves an Agent %s',
    async (_name, reviewerLevels, reviewerReasoning) => {
      const { transport, requests } = runtime({
        levels: { 'model-a': ['low', 'medium'], 'model-b': [...reviewerLevels] },
      });
      const definition = reviewed(
        policy({ kind: 'raise_reasoning', level: 'high' }, { maxIterations: 1 }),
        {
          roles: [
            writerAt('low'),
            role('reviewer', 'model-b', reviewerReasoning ? { reasoning: reviewerReasoning } : {}),
          ],
        },
      );
      const { runId, events } = await start(transport, definition);
      const final = await waitForProjection(transport, runId, terminal);
      expect(final.status).toBe('succeeded');
      expect(escalations(events)).toEqual([
        expect.objectContaining({ nodeIds: ['write'], levels: { write: 'medium' } }),
      ]);
      expect(of(requests, 'write').map(([, r]) => r)).toEqual([fixed('low'), fixed('medium')]);
      expect(of(requests, 'review').map(([, r]) => r)).toEqual([
        reviewerReasoning,
        reviewerReasoning,
      ]);
    },
  );

  it('starts a re-entered Loop from the definition and raises it again', async () => {
    const { transport, requests } = runtime({
      decisions: scripted({
        a_decide: ['revise', 'pass'],
        b_decide: ['no', 'no', 'no', 'no'],
      }),
    });
    // Loop A [ Loop B [ b_write → b_decide ] → a_review → a_decide ]; B leaves to a_review.
    const definition = team(
      [
        loop('loop', { maxIterations: 3 }),
        loop(
          'inner',
          policy({ kind: 'raise_reasoning', level: 'high' }, { maxIterations: 1 }),
          'loop',
        ),
        writer('b_write', 'inner'),
        rule('b_decide', 'b_write', 'inner'),
        reviewer('a_review', 'b_write', 'loop'),
        decision('a_decide', 'a_review', 'loop'),
        output('b_write'),
      ],
      [
        edge('loop', 'body', 'inner', 'enter'),
        edge('inner', 'body', 'b_write'),
        edge('b_write', 'out', 'b_decide'),
        edge('b_decide', 'yes', 'inner', 'exit'),
        edge('b_decide', 'no', 'inner', 'repeat'),
        edge('inner', 'next', 'a_review'),
        edge('inner', 'exhausted', 'a_review'),
        edge('a_review', 'out', 'a_decide'),
        edge('a_decide', 'pass', 'loop', 'exit'),
        edge('a_decide', 'revise', 'loop', 'repeat'),
        edge('loop', 'next', 'output'),
      ],
      [writerAt('low'), reviewerAt('low')],
    );
    const { runId, events } = await start(transport, definition);
    const final = await waitForProjection(transport, runId, terminal);
    expect(final.status).toBe('succeeded');
    expect(rounds(final, 'inner')).toEqual([
      [1, 'revise'],
      [2, 'cap_reached'],
      [1, 'revise'],
      [2, 'cap_reached'],
    ]);
    expect(of(requests, 'b_write').map(([, r]) => r)).toEqual([
      fixed('low'),
      fixed('high'),
      fixed('low'),
      fixed('high'),
    ]);
    expect(escalations(events).map((e) => e.loopNodeId)).toEqual(['inner', 'inner']);
    expect(final.loopEscalations?.inner?.map((e) => e.iterationId)).toEqual([
      final.loopIterations.inner?.[0],
      final.loopIterations.inner?.[2],
    ]);
    // The outer Loop's Agent is not in the inner Loop.
    expect(of(requests, 'a_review').map(([, r]) => r)).toEqual([fixed('low'), fixed('low')]);
  });

  describe('a person who set an Agent keeps it', () => {
    const patch = async (
      coordinator: Coordinator,
      transport: InProcessTransport,
      runId: string,
      change: Doc,
    ) => {
      const { projection } = await transport.getSnapshot(runId);
      const receipt = coordinator.submit({
        schemaVersion: '0.1',
        commandId: `patch_${++edgeNo}`,
        runId,
        type: 'patch',
        expectedControlRevision: projection.controlRevision,
        payload: { kind: 'node_future', ...change },
      });
      expect(receipt.status).toBe('applied');
    };

    it('keeps a model the person chose before the policy, and changes the other Agents', async () => {
      const opened = new Gate();
      let runId = '';
      const s = runtime({
        agents: {
          beforeReply: async (_turn, input) => {
            if (input.nodeId === 'write' && input.round === 1) await opened.wait();
          },
        },
      });
      const definition = reviewed(
        policy({ kind: 'upper_model', modelProfile: 'model-u' }, { maxIterations: 1 }),
      );
      let events: RunEvent[] = [];
      ({ runId, events } = await start(s.transport, definition));
      await waitForProjection(s.transport, runId, (p) => (p.nodeExecutions.write ?? []).length > 0);
      await patch(s.coordinator, s.transport, runId, { nodeId: 'write', modelProfile: 'model-h' });
      opened.open();
      const final = await waitForProjection(s.transport, runId, terminal);
      expect(final.status).toBe('succeeded');
      expect(of(s.requests, 'write').map(([m]) => m)).toEqual(['model-a', 'model-h']);
      expect(of(s.requests, 'review').map(([m]) => m)).toEqual(['model-b', 'model-u']);
      // Only the Agents the policy changed are named.
      expect(escalations(events)).toEqual([expect.objectContaining({ nodeIds: ['review'] })]);
    });

    it('leaves on its model an Agent whose patched reasoning the upper model cannot serve', async () => {
      const opened = new Gate();
      const s = runtime({
        levels: { 'model-u': ['low', 'medium'] },
        agents: {
          beforeReply: async (_turn, input) => {
            if (input.nodeId === 'write' && input.round === 1) await opened.wait();
          },
        },
      });
      const definition = reviewed(
        policy({ kind: 'upper_model', modelProfile: 'model-u' }, { maxIterations: 1 }),
      );
      const { runId, events } = await start(s.transport, definition);
      await waitForProjection(s.transport, runId, (p) => (p.nodeExecutions.write ?? []).length > 0);
      await patch(s.coordinator, s.transport, runId, { nodeId: 'write', reasoning: fixed('high') });
      opened.open();
      const final = await waitForProjection(s.transport, runId, terminal);
      expect(final.status).toBe('succeeded');
      expect(of(s.requests, 'write')).toEqual([
        ['model-a', undefined],
        ['model-a', fixed('high')],
      ]);
      expect(of(s.requests, 'review')).toEqual([
        ['model-b', undefined],
        ['model-u', undefined],
      ]);
      expect(escalations(events)).toEqual([expect.objectContaining({ nodeIds: ['review'] })]);
    });

    it('checks a reasoning patch in a raised round against the upper model', async () => {
      const receipts: unknown[] = [];
      const s = runtime({
        levels: { 'model-u': ['low', 'medium'] },
        agents: {
          beforeReply: async (_turn, input) => {
            if (input.nodeId !== 'write' || input.round !== 2) return;
            const { projection } = await s.transport.getSnapshot(input.runId);
            receipts.push(
              s.coordinator.submit({
                schemaVersion: '0.1',
                commandId: `patch_${++edgeNo}`,
                runId: input.runId,
                type: 'patch',
                expectedControlRevision: projection.controlRevision,
                payload: { kind: 'node_future', nodeId: 'write', reasoning: fixed('high') },
              }),
            );
          },
        },
      });
      // model-a serves high; the upper model the round runs on does not.
      const definition = reviewed(
        policy({ kind: 'upper_model', modelProfile: 'model-u' }, { maxIterations: 1 }),
        { roles: [writerAt('low'), role('reviewer', 'model-b')] },
      );
      const { runId } = await start(s.transport, definition);
      const final = await waitForProjection(s.transport, runId, terminal);
      expect(final.status).toBe('succeeded');
      expect(receipts).toEqual([
        expect.objectContaining({ error: expect.objectContaining({ code: 'CAPABILITY_DENIED' }) }),
      ]);
      expect(of(s.requests, 'write')).toEqual([
        ['model-a', fixed('low')],
        ['model-u', fixed('low')],
      ]);
    });

    it('raises the reasoning of an Agent whose model alone the person set', async () => {
      const opened = new Gate();
      const s = runtime({
        agents: {
          beforeReply: async (_turn, input) => {
            if (input.nodeId === 'write' && input.round === 1) await opened.wait();
          },
        },
      });
      const definition = reviewed(
        policy({ kind: 'raise_reasoning', level: 'high' }, { maxIterations: 1 }),
        { roles: [writerAt('low'), reviewerAt('low')] },
      );
      const { runId, events } = await start(s.transport, definition);
      await waitForProjection(s.transport, runId, (p) => (p.nodeExecutions.write ?? []).length > 0);
      await patch(s.coordinator, s.transport, runId, { nodeId: 'write', modelProfile: 'model-h' });
      await patch(s.coordinator, s.transport, runId, {
        nodeId: 'review',
        reasoning: fixed('medium'),
      });
      opened.open();
      const final = await waitForProjection(s.transport, runId, terminal);
      expect(final.status).toBe('succeeded');
      expect(of(s.requests, 'write')).toEqual([
        ['model-a', fixed('low')],
        ['model-h', fixed('high')],
      ]);
      // The reviewer's reasoning is the person's, which the raise leaves alone.
      expect(of(s.requests, 'review').map(([, r]) => r)).toEqual([
        fixed('medium'),
        fixed('medium'),
      ]);
      expect(escalations(events)).toEqual([
        expect.objectContaining({ nodeIds: ['write'], levels: { write: 'high' } }),
      ]);
    });

    it('lets a later patch of the person win over the raised model', async () => {
      let patched = false;
      const s = runtime({
        agents: {
          beforeReply: async (_turn, input) => {
            if (input.nodeId === 'write' && input.round === 3 && !patched) {
              patched = true;
              await patch(s.coordinator, s.transport, input.runId, {
                nodeId: 'write',
                modelProfile: 'model-h',
              });
            }
          },
        },
      });
      const definition = reviewed(
        policy({ kind: 'upper_model', modelProfile: 'model-u' }, { maxIterations: 2 }),
      );
      const { runId } = await start(s.transport, definition);
      const final = await waitForProjection(s.transport, runId, terminal);
      expect(final.status).toBe('succeeded');
      expect(of(s.requests, 'write').map(([m]) => m)).toEqual([
        'model-a',
        'model-a',
        'model-u',
        'model-h',
      ]);
      expect(of(s.requests, 'review').map(([m]) => m)).toEqual([
        'model-b',
        'model-b',
        'model-u',
        'model-u',
      ]);
    });
  });

  it('leaves an execution that is still running when the policy applies as it started', async () => {
    const slow = new Gate();
    const held: AgentStartInput[] = [];
    const s = runtime({
      agents: {
        beforeReply: async (_turn, input) => {
          if (input.nodeId === 'slow' && input.round === 1) {
            held.push(input);
            await slow.wait();
          }
        },
      },
    });
    // Loop [ fast | slow → Join any → review → decide ]
    const definition = team(
      [
        loop('loop', policy({ kind: 'raise_reasoning', level: 'high' }, { maxIterations: 1 })),
        writer('fast', 'loop'),
        writer('slow', 'loop'),
        { id: 'join', type: 'join', label: 'join', policy: 'any', parentId: 'loop' },
        reviewer('review', 'fast', 'loop'),
        decision('decide', 'review', 'loop'),
        writer('fallback'),
        output('fallback'),
      ],
      [
        edge('loop', 'body', 'fast'),
        edge('loop', 'body', 'slow'),
        edge('fast', 'out', 'join'),
        edge('slow', 'out', 'join'),
        edge('join', 'out', 'review'),
        edge('review', 'out', 'decide'),
        edge('decide', 'pass', 'loop', 'exit'),
        edge('decide', 'revise', 'loop', 'repeat'),
        edge('loop', 'next', 'fallback'),
        edge('loop', 'exhausted', 'fallback'),
        edge('fallback', 'out', 'output'),
      ],
      [writerAt('low'), reviewerAt('low')],
    );
    const { runId, events } = await start(s.transport, definition);
    await waitForProjection(s.transport, runId, () => escalations(events).length > 0);
    await waitForProjection(s.transport, runId, (p) => (p.loopIterations.loop ?? []).length === 2);
    expect(held).toHaveLength(1);
    expect(held[0]?.role.reasoning).toEqual(fixed('low'));
    expect(held[0]?.model.reasoning?.levels).toEqual(LEVELS['model-a']);
    slow.open();
    const final = await waitForProjection(s.transport, runId, terminal);
    expect(final.status).toBe('succeeded');
    expect(held[0]?.role.reasoning).toEqual(fixed('low'));
    expect(of(s.requests, 'fast').map(([, r]) => r)).toEqual([fixed('low'), fixed('high')]);
  });

  it('changes the Agents nested in the Loop and in its inline Teams, not those of a reference Team or an outer Loop', async () => {
    const saved = team(
      [writer('r_write'), output('r_write')],
      [edge('r_write', 'out', 'output')],
      [writerAt('low')],
      'r_write',
      'saved',
    );
    const { transport, requests } = runtime({
      corrals: { saved },
      decisions: scripted({ b_decide: ['no', 'yes', 'yes'], a_decide: ['no', 'yes'] }),
    });
    // Loop A [ a_write → Team T [ t_write ] → Loop B [ b_write → b_decide ] → R (saved) → a_decide ]
    const definition = team(
      [
        loop('loop', policy({ kind: 'raise_reasoning', level: 'high' }, { maxIterations: 1 })),
        writer('a_write', 'loop'),
        { id: 'T', type: 'team', label: 'T', parentId: 'loop', source: { kind: 'inline' } },
        writer('t_write', 'T'),
        loop(
          'inner',
          policy({ kind: 'upper_model', modelProfile: 'model-u' }, { maxIterations: 1 }),
          'loop',
        ),
        writer('b_write', 'inner'),
        rule('b_decide', 'b_write', 'inner'),
        {
          id: 'R',
          type: 'team',
          label: 'R',
          parentId: 'loop',
          source: { kind: 'reference', corralId: 'saved', definitionRevision: 1 },
        },
        rule('a_decide', 'b_write', 'loop'),
        output('b_write'),
      ],
      [
        edge('loop', 'body', 'a_write'),
        edge('a_write', 'out', 'T', 'enter'),
        edge('T', 'body', 't_write'),
        edge('t_write', 'out', 'T', 'exit'),
        edge('T', 'next', 'inner', 'enter'),
        edge('inner', 'body', 'b_write'),
        edge('b_write', 'out', 'b_decide'),
        edge('b_decide', 'yes', 'inner', 'exit'),
        edge('b_decide', 'no', 'inner', 'repeat'),
        edge('inner', 'next', 'R', 'enter'),
        edge('R', 'next', 'a_decide'),
        edge('a_decide', 'yes', 'loop', 'exit'),
        edge('a_decide', 'no', 'loop', 'repeat'),
        edge('loop', 'next', 'output'),
      ],
      [writerAt('low'), reviewerAt('low')],
    );
    const { runId, events } = await start(transport, definition);
    const final = await waitForProjection(transport, runId, terminal);
    expect(final.status).toBe('succeeded');
    expect(escalations(events)).toEqual([
      expect.objectContaining({ loopNodeId: 'inner', nodeIds: ['b_write'] }),
      expect.objectContaining({
        loopNodeId: 'loop',
        nodeIds: ['a_write', 't_write', 'b_write'],
        levels: { a_write: 'high', t_write: 'high', b_write: 'high' },
      }),
    ]);
    expect(of(requests, 'a_write')).toEqual([
      ['model-a', fixed('low')],
      ['model-a', fixed('high')],
    ]);
    expect(of(requests, 't_write')).toEqual([
      ['model-a', fixed('low')],
      ['model-a', fixed('high')],
    ]);
    expect(of(requests, 'b_write')).toEqual([
      ['model-a', fixed('low')],
      ['model-u', fixed('low')],
      ['model-a', fixed('high')],
    ]);
    expect(of(requests, 'R.r_write')).toEqual([
      ['model-a', fixed('low')],
      ['model-a', fixed('low')],
    ]);
  });

  describe('a Loop without a round cap', () => {
    const unlimited = { limitPolicy: { kind: 'unlimited' } };

    it('runs as many rounds as its decision asks for, without asking', async () => {
      const { transport } = runtime({
        decisions: scripted({ decide: [...Array(30).fill('revise'), 'pass'] }),
      });
      const { runId } = await start(transport, reviewed(unlimited));
      const final = await waitForProjection(transport, runId, terminal);
      expect(final.status).toBe('succeeded');
      expect(rounds(final, 'loop')).toHaveLength(31);
      expect(rounds(final, 'loop').at(-1)).toEqual([31, 'pass']);
      expect(Object.keys(final.approvals)).toEqual([]);
    });

    it('exhausts at a loop_limit patch', async () => {
      const opened = new Gate();
      const s = runtime({
        agents: {
          beforeReply: async (_turn, input) => {
            if (input.nodeId === 'write' && input.round === 1) await opened.wait();
          },
        },
      });
      const { runId } = await start(s.transport, reviewed(unlimited));
      const first = await waitForProjection(
        s.transport,
        runId,
        (p) => (p.nodeExecutions.write ?? []).length > 0,
      );
      expect(
        s.coordinator.submit({
          schemaVersion: '0.1',
          commandId: `limit_${++edgeNo}`,
          runId,
          type: 'patch',
          expectedControlRevision: first.controlRevision,
          payload: { kind: 'loop_limit', nodeId: 'loop', maxIterations: 3 },
        }).status,
      ).toBe('applied');
      opened.open();
      const final = await waitForProjection(s.transport, runId, terminal);
      expect(final.status).toBe('succeeded');
      expect(rounds(final, 'loop')).toEqual([
        [1, 'revise'],
        [2, 'revise'],
        [3, 'cap_reached'],
      ]);
      expect(final.nodeExecutions.fallback).toHaveLength(1);
    });

    it('exhausts on a stall when stall detection is on', async () => {
      const { transport } = runtime({
        agents: { reply: (_turn, input) => (input.nodeId === 'write' ? 'Same.' : 'x') },
      });
      const { runId } = await start(transport, reviewed({ ...unlimited, stallDetection: true }));
      const final = await waitForProjection(transport, runId, terminal);
      expect(final.status).toBe('succeeded');
      expect(rounds(final, 'loop')).toEqual([
        [1, 'revise'],
        [2, 'stalled'],
      ]);
    });
  });

  it('fails the run, without asking, when an exhausted Loop has no exhausted path', async () => {
    const { transport } = runtime();
    const { runId, events } = await start(
      transport,
      reviewed({ maxIterations: 1 }, { fallback: false }),
    );
    const final = await waitForProjection(transport, runId, terminal);
    expect(final.status).toBe('failed');
    expect(final.statusReason).toBe('loop_exhausted: loop cap_reached');
    expect(rounds(final, 'loop')).toEqual([[1, 'cap_reached']]);
    expect(events.some((e) => e.type === 'approval.requested')).toBe(false);
    const [execution] = final.nodeExecutions.write ?? [];
    const [draft] = final.tasks[final.executions[execution ?? '']?.taskId ?? '']
      ?.submittedArtifactVersionIds ?? [''];
    expect(await transport.getArtifactText(runId, draft ?? '')).toEqual(expect.any(String));
  });

  it('names a stall in the reason of a run its stalled Loop fails', async () => {
    const { transport } = runtime({ agents: { reply: () => 'Same.' } });
    const { runId } = await start(
      transport,
      reviewed({ maxIterations: 5, stallDetection: true }, { fallback: false }),
    );
    const final = await waitForProjection(transport, runId, terminal);
    expect(final.status).toBe('failed');
    expect(final.statusReason).toBe('loop_exhausted: loop stalled');
  });

  describe('pausing, cancelling and restarting around the policy', () => {
    const raised = () =>
      reviewed(policy({ kind: 'raise_reasoning', level: 'high' }, { maxIterations: 2 }), {
        roles: [writerAt('low'), reviewerAt('low')],
      });

    it('keeps the raised values and the recount through a pause right after the policy', async () => {
      const s = runtime();
      let paused = false;
      const { runId, events } = await start(s.transport, raised(), (event, id) => {
        if (event.type === 'loop.escalated' && !paused) {
          paused = true;
          const p = s.store.getRun(id)?.projection;
          expect(control(s.coordinator, id, 'pause', p?.controlRevision ?? 0).status).not.toBe(
            'rejected',
          );
        }
      });
      const waiting = await waitForProjection(s.transport, runId, (p) => p.status === 'paused');
      for (let i = 0; i < 50; i++) await Promise.resolve();
      // Paused: round 3 waits to open, with the escalation recorded.
      const held = (await s.transport.getSnapshot(runId)).projection;
      expect(held.status).toBe('paused');
      expect(held.loopIterations.loop).toHaveLength(2);
      expect(held.loopEscalations?.loop).toHaveLength(1);
      expect(control(s.coordinator, runId, 'resume', waiting.controlRevision).status).not.toBe(
        'rejected',
      );
      const final = await waitForProjection(s.transport, runId, terminal);
      expect(final.status).toBe('succeeded');
      expect(rounds(final, 'loop')).toEqual([
        [1, 'revise'],
        [2, 'revise'],
        [3, 'revise'],
        [4, 'cap_reached'],
      ]);
      expect(of(s.requests, 'write').map(([, r]) => r)).toEqual([
        fixed('low'),
        fixed('low'),
        fixed('high'),
        fixed('high'),
      ]);
      expect(escalations(events)).toHaveLength(1);
    });

    it('a pause right before the policy holds it until the run resumes', async () => {
      let s!: ReturnType<typeof runtime>;
      s = runtime({
        decisions: scripted({}, async ({ runId, iteration }) => {
          const p = s.store.getRun(runId)?.projection;
          if (iteration?.no === 2 && p?.status === 'running')
            expect(control(s.coordinator, runId, 'pause', p.controlRevision).status).not.toBe(
              'rejected',
            );
        }),
      });
      const { runId, events } = await start(s.transport, raised());
      const waiting = await waitForProjection(s.transport, runId, (p) => p.status === 'paused');
      for (let i = 0; i < 50; i++) await Promise.resolve();
      expect(escalations(events)).toEqual([]);
      expect(control(s.coordinator, runId, 'resume', waiting.controlRevision).status).not.toBe(
        'rejected',
      );
      const final = await waitForProjection(s.transport, runId, terminal);
      expect(final.status).toBe('succeeded');
      expect(escalations(events)).toHaveLength(1);
      expect(rounds(final, 'loop')).toEqual([
        [1, 'revise'],
        [2, 'revise'],
        [3, 'revise'],
        [4, 'cap_reached'],
      ]);
    });

    it('cancelling right before the policy opens no round and records no escalation', async () => {
      let s!: ReturnType<typeof runtime>;
      s = runtime({
        decisions: scripted({}, async ({ runId, iteration }) => {
          if (iteration?.no === 2) cancelRun(s.coordinator, runId);
        }),
      });
      const { runId, events } = await start(s.transport, raised());
      const final = await waitForProjection(s.transport, runId, terminal);
      expect(final.status).toBe('cancelled');
      expect(escalations(events)).toEqual([]);
      expect(rounds(final, 'loop')).toEqual([
        [1, 'revise'],
        [2, 'cancelled'],
      ]);
    });

    it('cancelling right after the policy wins: the next round never opens', async () => {
      const s = runtime();
      const { runId, events } = await start(s.transport, raised(), (event, id) => {
        if (event.type === 'loop.escalated') cancelRun(s.coordinator, id);
      });
      const final = await waitForProjection(s.transport, runId, terminal);
      expect(final.status).toBe('cancelled');
      // The escalation already ended round 2 as revise; round 3 is never opened.
      expect(rounds(final, 'loop')).toEqual([
        [1, 'revise'],
        [2, 'revise'],
      ]);
      expect(
        typesOf(events, [
          'loop.escalated',
          'cancel.requested',
          'loop.iteration_finished',
          'loop.iteration_started',
          'cancel.confirmed',
        ]).slice(3),
      ).toEqual([
        'loop.escalated',
        'cancel.requested',
        'loop.iteration_finished',
        'cancel.confirmed',
      ]);
      expect(of(s.requests, 'write')).toHaveLength(2);
    });

    it('a restarted host keeps the escalation the run recorded, rebuilt from its events', async () => {
      const store = new InMemoryRunStore();
      const held = new Gate();
      const s = runtime({
        store,
        agents: {
          beforeReply: async (_turn, input) => {
            if (input.nodeId === 'write' && input.round === 3) await held.wait();
          },
        },
      });
      const { runId } = await start(s.transport, raised());
      const before = await waitForProjection(
        s.transport,
        runId,
        (p) => (p.nodeExecutions.write ?? []).length === 3,
      );
      expect(before.loopEscalations?.loop).toHaveLength(1);
      // A new process over the same store ends what the old one left open.
      runtime({ store, ids: 'b' });
      const stored = store.getRun(runId)?.projection;
      expect(stored?.status).toBe('interrupted');
      expect(stored?.loopEscalations).toEqual(before.loopEscalations);
      const replayed = store
        .readEvents(runId, 0)
        .reduce((p, event) => applyEvent(p, event), emptyProjection(runId));
      expect(replayed.loopEscalations).toEqual(before.loopEscalations);
      expect(rounds(replayed, 'loop').at(-1)).toEqual([3, 'cancelled']);
    });
  });

  describe('starting a run', () => {
    it('refuses an upper model the Loop Agents cannot use with their reasoning', async () => {
      const { transport } = runtime({ levels: { 'model-u': ['low', 'medium'] } });
      const result = await transport.startRun({
        schemaVersion: '0.1',
        commandId: `cmd_${++edgeNo}`,
        definition: reviewed(
          policy({ kind: 'upper_model', modelProfile: 'model-u' }, { maxIterations: 1 }),
          { roles: [writerAt('high'), role('reviewer', 'model-b')] },
        ),
        mode: 'live',
      });
      expect(result.runId).toBeFalsy();
      expect(result.receipt.error).toMatchObject({ code: 'CAPABILITY_DENIED' });
      expect(result.receipt.error?.message).toContain('model-u');
    });

    it('refuses an upper model whose isolated workers cannot load the role harness', async () => {
      // A trusted harness with a native extension, which Linux isolation cannot run.
      const harness: EffectiveHarnessSnapshot = {
        binding: { profileId: 'writing', revision: 1 },
        snapshotHash: 'a'.repeat(64),
        piVersion: '1.3.0',
        policyRevision: 1,
        policy: 'trusted-native',
        resources: [
          {
            hash: 'c'.repeat(64),
            name: 'fixture',
            version: '1.0.0',
            kind: 'extension',
            required: true,
          },
        ],
        allowedTools: ['echo'],
        tools: [],
        diagnostics: [],
      };
      const roles = [
        role('writer', 'model-a', { harness: harness.binding }),
        role('reviewer', 'model-b'),
      ];
      const startWith = (limit: Doc) =>
        runtime({ isolated: ['model-u'], harness }).transport.startRun({
          schemaVersion: '0.1',
          commandId: `cmd_${++edgeNo}`,
          definition: reviewed(limit, { roles }),
          mode: 'live',
        });
      const refused = await startWith(
        policy({ kind: 'upper_model', modelProfile: 'model-u' }, { maxIterations: 1 }),
      );
      expect(refused.runId).toBeFalsy();
      expect(refused.receipt.error).toMatchObject({ code: 'CAPABILITY_DENIED' });
      expect(refused.receipt.error?.message).toContain('Linux isolation');
      const started = await startWith({ maxIterations: 1 });
      expect(started.runId).toBeTruthy();
    });

    it('refuses an upper model that is not configured', async () => {
      const { transport } = runtime();
      const result = await transport.startRun({
        schemaVersion: '0.1',
        commandId: `cmd_${++edgeNo}`,
        definition: reviewed(
          policy({ kind: 'upper_model', modelProfile: 'model-missing' }, { maxIterations: 1 }),
        ),
        mode: 'live',
      });
      expect(result.runId).toBeFalsy();
      expect(result.receipt.error?.message).toContain('model-missing');
    });
  });
});

describe('a Loop whose rounds wait on nothing', () => {
  // pre → [ slow | Loop spin [ rule decision: yes → exit, no → repeat ] ] → Join (all) → output.
  // Each round is one decision with no execution, so nothing in it waits on the host.
  const definition = () =>
    team(
      [
        writer('pre'),
        writer('slow'),
        loop('spin', { limitPolicy: { kind: 'unlimited' } }),
        rule('decide', 'pre', 'spin'),
        { id: 'join', type: 'join', label: 'join', policy: 'all' },
        output('slow'),
      ],
      [
        edge('pre', 'out', 'slow'),
        edge('pre', 'out', 'spin', 'enter'),
        edge('spin', 'body', 'decide'),
        edge('decide', 'yes', 'spin', 'exit'),
        edge('decide', 'no', 'spin', 'repeat'),
        edge('slow', 'out', 'join'),
        edge('spin', 'next', 'join'),
        edge('join', 'out', 'output'),
      ],
      [writerAt('low')],
      'pre',
    );
  /** Answers `no` until `done` says yes; past the safety cap it ends the Loop and says so. */
  const spinning = (done: (p: RunProjection) => boolean) => {
    const state = { rounds: 0, overflow: false };
    const decisions: DecisionPolicy = {
      decide: async ({ projection }) => {
        state.rounds += 1;
        if (state.rounds > 3000) {
          state.overflow = true;
          return 'yes';
        }
        return done(projection) ? 'yes' : 'no';
      },
    };
    return { state, decisions };
  };
  const later = (ms: number) =>
    new Promise<void>((resolve) => {
      hostTimeout(resolve, ms);
    });
  const slowDone = (p: RunProjection) =>
    (p.nodeExecutions.slow ?? []).some((id) => p.executions[id]?.status === 'succeeded');

  it('lets a parallel branch finish while it spins, then leaves and ends the run', async () => {
    const spin = spinning(slowDone);
    const s = runtime({
      decisions: spin.decisions,
      agents: {
        beforeReply: async (_turn, input) => {
          if (input.nodeId === 'slow') await later(5);
        },
      },
    });
    const { runId } = await start(s.transport, definition());
    const final = await waitForProjection(s.transport, runId, terminal);
    expect(spin.state.overflow).toBe(false);
    expect(final.status).toBe('succeeded');
    expect(rounds(final, 'spin').at(-1)?.[1]).toBe('pass');
  });

  it.each([
    ['its Scheduler turn', undefined],
    ['the host macrotask, for a Scheduler without a turn', null],
  ] as const)(
    'is stopped by a cancel sent while it spins, yielding with %s',
    async (_name, turn) => {
      const spin = spinning(() => false);
      const held = new Gate();
      const s = runtime({
        turn,
        decisions: spin.decisions,
        agents: {
          beforeReply: async (_turn, input) => {
            if (input.nodeId === 'slow') await held.wait();
          },
        },
      });
      const { runId } = await start(s.transport, definition());
      hostTimeout(() => {
        cancelRun(s.coordinator, runId);
        // The held worker then sees its cancel and stops.
        held.open();
      }, 1);
      const final = await waitForProjection(s.transport, runId, terminal);
      expect(spin.state.overflow).toBe(false);
      expect(final.status).toBe('cancelled');
      expect(rounds(final, 'spin').at(-1)?.[1]).toBe('cancelled');
    },
  );

  it('holds at a pause sent while it spins, and goes on after resume', async () => {
    let resumedAt: number | null = null;
    const spin = spinning(
      (p) => resumedAt !== null && slowDone(p) && spin.state.rounds >= resumedAt + 3,
    );
    const s = runtime({
      decisions: spin.decisions,
      agents: {
        beforeReply: async (_turn, input) => {
          if (input.nodeId === 'slow') await later(5);
        },
      },
    });
    const { runId } = await start(s.transport, definition());
    hostTimeout(() => {
      const p = s.store.getRun(runId)?.projection;
      control(s.coordinator, runId, 'pause', p?.controlRevision ?? 0);
    }, 1);
    const waiting = await waitForProjection(s.transport, runId, (p) => p.status === 'paused');
    const held = spin.state.rounds;
    await later(10);
    expect(spin.state.rounds).toBe(held);
    expect(spin.state.overflow).toBe(false);
    resumedAt = held;
    expect(control(s.coordinator, runId, 'resume', waiting.controlRevision).status).not.toBe(
      'rejected',
    );
    const final = await waitForProjection(s.transport, runId, terminal);
    expect(spin.state.overflow).toBe(false);
    expect(final.status).toBe('succeeded');
    expect(spin.state.rounds).toBeGreaterThanOrEqual(held + 3);
  });
});

describe('a Loop round that waits at its turn', () => {
  const settle = async (done: () => boolean) => {
    const until = Date.now() + 2_000;
    while (!done() && Date.now() < until) await new Promise<void>((r) => hostTimeout(r, 1));
  };

  // pre -> [ Loop [ write -> review -> decide ] | quick ] -> Join (any) -> after -> Output.
  // The Loop has no exhausted path; quick finishes inside the Loop's first turn and wins.
  const racing = (loopExtra: Doc) =>
    team(
      [
        writer('pre'),
        writer('quick'),
        loop('loop', loopExtra),
        writer('write', 'loop'),
        reviewer('review', 'write', 'loop'),
        decision('decide', 'review', 'loop'),
        { id: 'join', type: 'join', label: 'join', policy: 'any' },
        writer('after'),
        output('after'),
      ],
      [
        edge('pre', 'out', 'quick'),
        edge('pre', 'out', 'loop', 'enter'),
        edge('loop', 'body', 'write'),
        edge('write', 'out', 'review'),
        edge('review', 'out', 'decide'),
        edge('decide', 'pass', 'loop', 'exit'),
        edge('decide', 'revise', 'loop', 'repeat'),
        edge('loop', 'next', 'join'),
        edge('quick', 'out', 'join'),
        edge('join', 'out', 'after'),
        edge('after', 'out', 'output'),
      ],
      undefined,
      'pre',
    );

  it.each([
    [
      'its limit policy',
      policy({ kind: 'upper_model', modelProfile: 'model-u' }, { maxIterations: 1 }),
    ],
    ['its exhaustion', { maxIterations: 1 }],
  ])('a Loop that loses an any Join during its turn leaves nothing by %s', async (_name, extra) => {
    const quick = new Gate();
    // The winner's next step stays running until the turn is over, so the run is still live.
    const after = new Gate();
    let runId = '';
    let s!: ReturnType<typeof runtime>;
    s = runtime({
      agents: {
        beforeReply: async (_turn, input) => {
          if (input.nodeId === 'quick') await quick.wait();
          if (input.nodeId === 'after') await after.wait();
        },
      },
      turn: async () => {
        quick.open();
        await settle(() =>
          s.store.readEvents(runId, 0).some((event) => event.type === 'workflow.joined'),
        );
        hostTimeout(() => after.open(), 20);
      },
    });
    let events: RunEvent[] = [];
    ({ runId, events } = await start(s.transport, racing(extra)));
    const final = await waitForProjection(s.transport, runId, terminal);
    expect(final.status).toBe('succeeded');
    expect(final.nodeExecutions.after).toHaveLength(1);
    expect(rounds(final, 'loop')).toEqual([[1, 'cancelled']]);
    const joined = events.findIndex((event) => event.type === 'workflow.joined');
    expect(joined).toBeGreaterThan(0);
    expect(
      events
        .slice(joined + 1)
        .filter((event) => (event.payload as { loopNodeId?: string }).loopNodeId === 'loop'),
    ).toEqual([]);
    expect(escalations(events)).toEqual([]);
  });

  it('stops at a pause sent between rounds before it checks the round limit', async () => {
    let runId = '';
    let s!: ReturnType<typeof runtime>;
    s = runtime({
      turn: async () => {
        const p = s.store.getRun(runId)?.projection;
        if (p?.status === 'running')
          expect(control(s.coordinator, runId, 'pause', p.controlRevision).status).not.toBe(
            'rejected',
          );
      },
    });
    ({ runId } = await start(s.transport, reviewed({ maxIterations: 1 }, { fallback: false })));
    const waiting = await waitForProjection(s.transport, runId, (p) => p.status === 'paused');
    await settle(() => false);
    const held = (await s.transport.getSnapshot(runId)).projection;
    // Paused at the cap round's turn: the round is still open and the run has not failed.
    expect(held.status).toBe('paused');
    expect(rounds(held, 'loop')).toEqual([[1, null]]);
    expect(control(s.coordinator, runId, 'resume', waiting.controlRevision).status).not.toBe(
      'rejected',
    );
    const final = await waitForProjection(s.transport, runId, terminal);
    expect(final.statusReason).toBe('loop_exhausted: loop cap_reached');
  });
});

describe('Loop limit policy: structure rules', () => {
  const codes = (definition: CorralDefinition, known?: string[]) =>
    compileDefinition(definition, known ? { knownModelProfiles: known } : {})
      .diagnostics.filter((d) => d.severity === 'error' && d.nodeId === 'loop')
      .map((d) => d.code);
  const recipe = {
    recipeId: 'recipe',
    revision: 1,
    criteriaHash: reviewCriteriaHash(['It is written.']),
    candidateNodeId: 'write',
    evaluatorRoleId: 'reviewer',
    checkIds: [],
    criteriaFiles: [],
    maxAttempts: 3,
    maxRepairs: 2,
  };

  it.each([
    ['unlimited with a round cap', { limitPolicy: { kind: 'unlimited' }, maxIterations: 3 }],
    ['a round cap missing', {}],
    [
      'a round cap missing under a raise',
      { limitPolicy: { kind: 'raise_reasoning', level: 'high' } },
    ],
  ])('needs a round cap exactly when the Loop is not unlimited: %s', (_name, extra) => {
    expect(codes(reviewed(extra))).toEqual(['LOOP_MAX_ITERATIONS']);
  });

  it('accepts every policy in its own shape', () => {
    for (const extra of [
      { maxIterations: 2 },
      { maxIterations: 2, limitPolicy: { kind: 'exhaust' } },
      { maxIterations: 2, limitPolicy: { kind: 'raise_reasoning', level: 'max' } },
      { maxIterations: 2, limitPolicy: { kind: 'upper_model', modelProfile: 'model-u' } },
      { limitPolicy: { kind: 'unlimited' } },
    ])
      expect(
        codes(reviewed(extra), ['model-a', 'model-b', 'model-u']),
        JSON.stringify(extra),
      ).toEqual([]);
  });

  it('lets a Loop with a review recipe only exhaust', () => {
    const definition = reviewed({
      maxIterations: 2,
      limitPolicy: { kind: 'raise_reasoning', level: 'high' },
      reviewRecipe: recipe,
    });
    expect(codes(definition)).toContain('LOOP_LIMIT_RECIPE');
    const exhausting = reviewed({ maxIterations: 2, reviewRecipe: recipe });
    expect(codes(exhausting)).not.toContain('LOOP_LIMIT_RECIPE');
  });

  it('does not raise reasoning to off', () => {
    expect(
      codes(reviewed({ maxIterations: 2, limitPolicy: { kind: 'raise_reasoning', level: 'off' } })),
    ).toEqual(['LOOP_REASONING_OFF']);
  });

  it('switches only to an allowed model', () => {
    const definition = reviewed({
      maxIterations: 2,
      limitPolicy: { kind: 'upper_model', modelProfile: 'model-x' },
    });
    expect(codes(definition, ['model-a', 'model-b'])).toEqual(['LOOP_UPPER_MODEL']);
    expect(codes(definition)).toEqual([]);
  });

  it('plans the cap, the policy and the Agents of each Loop', () => {
    const compiled = compileDefinition(reviewed({ limitPolicy: { kind: 'unlimited' } }));
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
    expect(compiled.plan.loops.loop).toMatchObject({
      maxIterations: null,
      limitPolicy: { kind: 'unlimited' },
      agents: ['write', 'review'],
    });
    const capped = compileDefinition(reviewed({ maxIterations: 4 }));
    if (!capped.ok) throw new Error('compile');
    expect(capped.plan.loops.loop).toMatchObject({
      maxIterations: 4,
      limitPolicy: { kind: 'exhaust' },
    });
  });
});
