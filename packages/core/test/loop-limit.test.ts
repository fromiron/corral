import {
  type AgentStartInput,
  type ControlEdge,
  type CorralDefinition,
  type CorralNode,
  DEFAULT_LIMITS,
  CorralDefinition as Definition,
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

// biome-ignore lint/suspicious/noExplicitAny: documents are built loosely, then parsed.
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
  } = {},
) {
  const clock = new FakeClock();
  const requests: Request[] = [];
  const levels = { ...LEVELS, ...options.levels };
  const store = options.store ?? new InMemoryRunStore();
  const coordinator = new Coordinator({
    clock,
    timers: clock,
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
              },
            }
          : { ok: false, code: 'CAPABILITY_DENIED', reason: 'not configured' },
    },
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
      ({ runId } = await start(s.transport, definition));
      await waitForProjection(s.transport, runId, (p) => (p.nodeExecutions.write ?? []).length > 0);
      await patch(s.coordinator, s.transport, runId, { nodeId: 'write', modelProfile: 'model-h' });
      opened.open();
      const final = await waitForProjection(s.transport, runId, terminal);
      expect(final.status).toBe('succeeded');
      expect(of(s.requests, 'write').map(([m]) => m)).toEqual(['model-a', 'model-h']);
      expect(of(s.requests, 'review').map(([m]) => m)).toEqual(['model-b', 'model-u']);
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
