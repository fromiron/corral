import type {
  AgentAdapter,
  AgentHost,
  AgentSettlement,
  CallSnapshotInput,
  EffortRoutingSettings,
  ModelRequestRecord,
  ReasoningPolicy,
  RunCommand,
  RunEvent,
} from '@corral/contracts';
import {
  FakeClock,
  FakeRoutingBackend,
  type FakeRoutingOptions,
  linearCorral,
  SequentialIdFactory,
} from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import { Coordinator, InProcessTransport, SPEC_HARD_CAPS } from '../src/index.ts';

// features/effort-routing.md: the per-request judgment through the Coordinator, with fake engines.

async function drain() {
  for (let i = 0; i < 100; i++) await Promise.resolve();
}

const hash = (n: number) => n.toString(16).padStart(64, '0');
const record = (context = 1, directiveIds: string[] = []): ModelRequestRecord => ({
  purpose: 'turn',
  runtime: 'pi-core',
  directiveIds,
  contextHash: hash(context),
  contextBytes: 10,
  sections: [],
});
const snapshot = (request: string, extra: Partial<CallSnapshotInput> = {}): CallSnapshotInput => ({
  request: { text: request },
  requestImages: 0,
  previousAssistant: null,
  toolCalls: [],
  earlierReplies: [],
  presentQuestionIds: [],
  ...extra,
});

const LOCAL: EffortRoutingSettings = {
  mode: 'manual',
  engine: { kind: 'local', device: { kind: 'cpu', threads: 4 }, callerTimeoutMs: 5000 },
  fallback: { kind: 'provider-default' },
};
const API: EffortRoutingSettings = {
  mode: 'manual',
  engine: { kind: 'api', id: 'jev', callerTimeoutMs: 300, consentRevision: 'jev:1' },
  fallback: { kind: 'provider-default' },
};

async function setup(
  options: {
    settings?: EffortRoutingSettings;
    reasoning?: ReasoningPolicy;
    local?: FakeRoutingOptions;
    api?: FakeRoutingOptions;
    levels?: ('low' | 'medium' | 'high' | 'xhigh')[];
  } = {},
) {
  const clock = new FakeClock();
  const hosts: AgentHost[] = [];
  let settle!: (result: AgentSettlement) => void;
  const agents: AgentAdapter = {
    async start(_input, host) {
      hosts.push(host);
      const done = new Promise<AgentSettlement>((resolve) => {
        settle = resolve;
      });
      return {
        cancel: async () => settle({ outcome: 'cancelled' }),
        waitForSettlement: () => done,
      };
    },
  };
  const local = new FakeRoutingBackend({
    kind: 'local',
    now: () => clock.monotonicMs(),
    ...options.local,
  });
  const api = new FakeRoutingBackend({
    kind: 'api',
    now: () => clock.monotonicMs(),
    ...options.api,
  });
  const asked: string[] = [];
  const settings = { current: options.settings ?? LOCAL };
  const coordinator = new Coordinator({
    clock,
    timers: clock,
    ids: new SequentialIdFactory(),
    agents,
    policy: SPEC_HARD_CAPS,
    effortRouting: {
      settings: () => settings.current,
      backend: (engine) => {
        asked.push(engine.kind);
        return engine.kind === 'local' ? local : api;
      },
    },
    models: {
      resolve: (profile) => ({
        ok: true,
        snapshot: {
          profile,
          provider: 'openai-codex',
          modelId: 'gpt-6-luna',
          auth: 'oauth',
          maxOutputTokens: 4096,
          reasoning: {
            levels: options.levels ?? ['low', 'medium', 'high', 'xhigh'],
            providerDefault: true,
          },
        },
      }),
    },
  });
  const transport = new InProcessTransport(coordinator);
  const team = linearCorral(['writer']);
  team.roles[0]!.reasoning = options.reasoning ?? { mode: 'auto' };
  const start = coordinator.startRun({
    schemaVersion: '0.1',
    commandId: 'start',
    mode: 'live',
    definition: team,
  });
  if (!start.runId) throw new Error(JSON.stringify(start.receipt.error));
  const runId = start.runId;
  const events: RunEvent[] = [];
  transport.subscribe(runId, 0, { onEvent: (e) => events.push(e) });
  await drain();
  const host = () => {
    const found = hosts[0];
    if (!found) throw new Error('agent not started');
    return found;
  };
  const send = (type: RunCommand['type'], payload: unknown, id: string) =>
    coordinator.submit({ schemaVersion: '0.1', commandId: id, runId, type, payload } as RunCommand);
  const observe = (modelCallId: string) =>
    host().observe({
      kind: 'model_completed',
      modelCallId,
      text: 'reply',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
  return { clock, coordinator, local, api, asked, settings, host, events, send, observe, runId };
}

describe('effort routing through request preparation', () => {
  it('C01: Off asks no engine and sends the provider default', async () => {
    const s = await setup({ settings: { mode: 'off' } });
    const permit = await s.host().prepareModelRequest(record(), { snapshot: snapshot('fix it') });
    expect(permit.reasoning).toMatchObject({ resolved: null, source: 'off' });
    expect(permit.reasoning?.route).toBeUndefined();
    expect(s.asked).toEqual([]);
    expect(s.local.admits + s.local.countCalls + s.api.admits).toBe(0);
  });

  it('C02: a fixed level under Manual is not judged', async () => {
    const s = await setup({ reasoning: { mode: 'fixed', level: 'high' } });
    const permit = await s.host().prepareModelRequest(record(), { snapshot: snapshot('fix it') });
    expect(permit.reasoning).toMatchObject({ resolved: 'high', source: 'fixed' });
    expect(s.local.admits).toBe(0);
    expect(s.local.requests).toHaveLength(0);
  });

  it('C03: the reply after a tool result is judged again on its own context', async () => {
    const s = await setup({ local: { answer: () => ({ choice: 'low' }) } });
    const first = await s.host().prepareModelRequest(record(1), {
      logicalRequestId: 'request_1',
      snapshot: snapshot('rename the field'),
    });
    await s.host().modelRequestDispatched?.(first.modelCallId);
    await s.observe(first.modelCallId);
    const next = await s.host().prepareModelRequest(record(2), {
      logicalRequestId: 'request_2',
      snapshot: snapshot('rename the field', {
        previousAssistant: { text: 'Reading the schema first.' },
        toolCalls: [
          {
            toolCallId: 'call_1',
            name: 'read',
            args: { text: '{"path":"schema.ts"}' },
            result: { text: 'export const field = 1;' },
            status: 'completed',
          },
        ],
      }),
    });
    expect(s.local.requests).toHaveLength(2);
    expect(s.local.requests[1]!.state).toContain('export const field = 1;');
    expect(s.local.requests[0]!.state).not.toContain('export const field');
    expect(first.reasoning?.preparationId).not.toBe(next.reasoning?.preparationId);
    expect(next.reasoning).toMatchObject({ source: 'router', resolved: 'low' });
  });

  it('C04: an explicit transport retry reuses the settled result with a new call', async () => {
    const s = await setup({ local: { answer: () => ({ choice: 'low' }) } });
    const first = await s.host().prepareModelRequest(record(), {
      logicalRequestId: 'request_1',
      snapshot: snapshot('fix it'),
    });
    await s.host().modelRequestDispatched?.(first.modelCallId);
    await s.observe(first.modelCallId);
    const retry = await s.host().prepareModelRequest(record(), {
      logicalRequestId: 'request_1',
      retryOfModelCallId: first.modelCallId,
      snapshot: snapshot('fix it'),
    });
    expect(s.local.requests).toHaveLength(1);
    expect(retry.modelCallId).not.toBe(first.modelCallId);
    expect(retry.reasoning).toMatchObject({
      resolved: 'low',
      source: 'reused',
      route: { reusedFrom: first.reasoning?.preparationId },
    });
    expect(retry.reasoning?.preparationId).not.toBe(first.reasoning?.preparationId);
  });

  it('C04: a retry keeps a timeout fallback instead of asking again', async () => {
    const s = await setup({
      local: { answer: 'hold' },
      settings: { ...LOCAL, fallback: { kind: 'fixed', effort: 'medium' } },
    });
    const pending = s.host().prepareModelRequest(record(), {
      logicalRequestId: 'request_1',
      snapshot: snapshot('fix it'),
    });
    await drain();
    s.clock.advance(5000);
    const first = await pending;
    expect(first.reasoning).toMatchObject({
      resolved: 'medium',
      source: 'fallback',
      route: { fallback: { reason: 'timeout' } },
    });
    await s.host().modelRequestDispatched?.(first.modelCallId);
    await s.observe(first.modelCallId);
    // The engine finishes late; the request has already settled on its fallback.
    s.local.flights[0]!.respond({ choice: 'high' });
    s.local.flights[0]!.settle();
    await drain();
    const retry = await s.host().prepareModelRequest(record(), {
      logicalRequestId: 'request_1',
      retryOfModelCallId: first.modelCallId,
      snapshot: snapshot('fix it'),
    });
    expect(retry.reasoning).toMatchObject({ resolved: 'medium', source: 'reused' });
    expect(s.local.requests).toHaveLength(1);
    const settled = s.events.find((e) => e.type === 'reasoning.settled');
    expect(settled?.payload).toMatchObject({
      basis: 'native-response-complete',
      lateResult: true,
      lateSelected: 'high',
    });
  });

  it('C05: the same logical request in a new preparation is judged again', async () => {
    const s = await setup();
    const first = await s.host().prepareModelRequest(record(), {
      logicalRequestId: 'request_1',
      snapshot: snapshot('fix it'),
    });
    await s.host().modelRequestDispatched?.(first.modelCallId);
    await s.observe(first.modelCallId);
    // Same logical ID, but the worker does not name a retry of that call.
    await s.host().prepareModelRequest(record(), {
      logicalRequestId: 'request_1',
      snapshot: snapshot('fix it'),
    });
    expect(s.local.requests).toHaveLength(2);
  });

  it('C06: a changed context, setting or engine is never reused', async () => {
    const s = await setup();
    let previous = await s.host().prepareModelRequest(record(1), {
      logicalRequestId: 'request_1',
      snapshot: snapshot('fix it'),
    });
    const changes: (() => { context: number })[] = [
      () => ({ context: 2 }),
      () => {
        s.settings.current = { ...LOCAL, fallback: { kind: 'fixed', effort: 'low' } };
        return { context: 2 };
      },
      () => {
        s.local.replaceIdentity('fake-local-2');
        return { context: 2 };
      },
    ];
    for (const [index, change] of changes.entries()) {
      await s.host().modelRequestDispatched?.(previous.modelCallId);
      await s.observe(previous.modelCallId);
      const { context } = change();
      previous = await s.host().prepareModelRequest(record(context), {
        logicalRequestId: 'request_1',
        retryOfModelCallId: previous.modelCallId,
        snapshot: snapshot('fix it'),
      });
      expect(previous.reasoning?.source).toBe('router');
      expect(s.local.requests).toHaveLength(index + 2);
    }
  });

  it('C07: a reused result still sends nothing once the run is cancelled', async () => {
    const s = await setup();
    const first = await s.host().prepareModelRequest(record(), {
      logicalRequestId: 'request_1',
      snapshot: snapshot('fix it'),
    });
    await s.host().modelRequestDispatched?.(first.modelCallId);
    await s.observe(first.modelCallId);
    const retry = await s.host().prepareModelRequest(record(), {
      logicalRequestId: 'request_1',
      retryOfModelCallId: first.modelCallId,
      snapshot: snapshot('fix it'),
    });
    expect(retry.reasoning?.source).toBe('reused');
    s.send('cancel', { scope: { kind: 'run' }, reason: 'stop' }, 'cancel');
    await drain();
    await expect(s.host().modelRequestDispatched?.(retry.modelCallId)).rejects.toThrow();
  });

  it('C07: a request cancelled while the engine works is not sent', async () => {
    const s = await setup({ local: { answer: 'hold' } });
    const pending = s.host().prepareModelRequest(record(), { snapshot: snapshot('fix it') });
    await drain();
    expect(s.local.flights).toHaveLength(1);
    s.send('cancel', { scope: { kind: 'run' }, reason: 'stop' }, 'cancel');
    await expect(pending).rejects.toThrow();
    expect(s.events.some((e) => e.type === 'model.request_prepared')).toBe(false);
    // The engine slot stays taken until the engine's own work ends.
    expect(s.local.busy).toBe(true);
    s.local.flights[0]!.respond();
    s.local.flights[0]!.settle();
    await drain();
    expect(s.local.busy).toBe(false);
  });

  it('C14: Shadow sends a fixed level at once and only observes the judgment', async () => {
    const s = await setup({
      reasoning: { mode: 'fixed', level: 'high' },
      settings: { ...LOCAL, application: 'shadow', fallback: { kind: 'fixed', effort: 'medium' } },
      local: { answer: () => ({ choice: 'low' }) },
    });
    const permit = await s.host().prepareModelRequest(record(), { snapshot: snapshot('fix it') });
    expect(permit.reasoning).toMatchObject({ resolved: 'high', source: 'fixed' });
    expect(s.local.admits).toBe(0);
    await s.host().modelRequestDispatched?.(permit.modelCallId);
    await drain();
    expect(s.local.requests).toHaveLength(1);
    const observed = s.events.find((e) => e.type === 'reasoning.observed');
    expect(observed?.payload).toMatchObject({
      modelCallId: permit.modelCallId,
      baseline: 'high',
      selected: 'low',
      skipped: null,
    });
  });

  it('C15: Shadow on the provider default adds no reasoning field', async () => {
    const s = await setup({
      reasoning: { mode: 'provider_default' },
      settings: { ...LOCAL, application: 'shadow' },
    });
    const permit = await s.host().prepareModelRequest(record(), { snapshot: snapshot('fix it') });
    expect(permit.reasoning).toMatchObject({ resolved: null, source: 'provider-default' });
    await s.host().modelRequestDispatched?.(permit.modelCallId);
    await drain();
    expect(s.events.find((e) => e.type === 'reasoning.observed')?.payload).toMatchObject({
      baseline: null,
    });
  });

  it('C15: Shadow skips an observation when the engine is busy and says so', async () => {
    const s = await setup({
      settings: { ...LOCAL, application: 'shadow' },
      local: { refuse: 'busy' },
    });
    const permit = await s.host().prepareModelRequest(record(), { snapshot: snapshot('fix it') });
    expect(permit.reasoning).toMatchObject({ resolved: null, source: 'fallback' });
    await s.host().modelRequestDispatched?.(permit.modelCallId);
    await drain();
    expect(s.events.find((e) => e.type === 'reasoning.observed')?.payload).toMatchObject({
      selected: null,
      skipped: 'busy',
    });
  });

  it('C16: an observation from Shadow never becomes an Active result', async () => {
    const s = await setup({
      settings: { ...LOCAL, application: 'shadow' },
      local: { answer: () => ({ choice: 'low' }) },
    });
    const first = await s.host().prepareModelRequest(record(), {
      logicalRequestId: 'request_1',
      snapshot: snapshot('fix it'),
    });
    await s.host().modelRequestDispatched?.(first.modelCallId);
    await drain();
    await s.observe(first.modelCallId);
    s.settings.current = LOCAL;
    const retry = await s.host().prepareModelRequest(record(), {
      logicalRequestId: 'request_1',
      retryOfModelCallId: first.modelCallId,
      snapshot: snapshot('fix it'),
    });
    expect(retry.reasoning?.source).toBe('router');
    expect(s.local.requests).toHaveLength(2);
  });

  it('C17: a short API deadline falls back like Local', async () => {
    const s = await setup({ settings: API, api: { answer: 'hold' } });
    const pending = s.host().prepareModelRequest(record(), { snapshot: snapshot('fix it') });
    await drain();
    expect(s.api.requests).toHaveLength(1);
    s.clock.advance(300);
    const permit = await pending;
    expect(permit.reasoning).toMatchObject({
      resolved: null,
      source: 'fallback',
      route: { engine: 'api', fallback: { reason: 'timeout' }, frame: { kind: 'api-bounded' } },
    });
  });

  it('C17: API under Shadow keeps the baseline and observes after dispatch', async () => {
    const s = await setup({ settings: { ...API, application: 'shadow' } });
    const permit = await s.host().prepareModelRequest(record(), { snapshot: snapshot('fix it') });
    expect(s.api.requests).toHaveLength(0);
    await s.host().modelRequestDispatched?.(permit.modelCallId);
    await drain();
    expect(s.api.requests).toHaveLength(1);
    expect(s.events.find((e) => e.type === 'reasoning.observed')?.payload).toMatchObject({
      probabilityMeaning: 'choice-distribution',
    });
  });

  it('C18: only the chosen engine is asked, even after it falls back', async () => {
    const s = await setup({ local: { refuse: 'not-ready' } });
    const permit = await s.host().prepareModelRequest(record(), { snapshot: snapshot('fix it') });
    expect(permit.reasoning).toMatchObject({ route: { fallback: { reason: 'not-ready' } } });
    expect(s.asked.every((kind) => kind === 'local')).toBe(true);
    expect(s.api.admits + s.api.refusals).toBe(0);
  });

  it('C19: a choice outside the candidates or a tampered distribution falls back', async () => {
    for (const answer of [
      { choice: 'max' },
      { choice: 'low', probabilities: { low: 0.2, medium: 0.5, high: 0.2, xhigh: 0.1 } },
      { choice: 'low', probabilities: { low: 0.5, medium: 0.5, high: 0, xhigh: 0 } },
      { choice: 'low', probabilities: { low: 0.9, medium: 0.9, high: 0, xhigh: 0 } },
    ]) {
      const s = await setup({ local: { answer: () => answer } });
      const permit = await s.host().prepareModelRequest(record(), { snapshot: snapshot('fix it') });
      expect(permit.reasoning).toMatchObject({
        resolved: null,
        source: 'fallback',
        route: { fallback: { reason: 'invalid-response' }, recommended: null },
      });
      expect(permit.maxOutputTokens).toBe(4096);
      expect(permit.profile).toBe('model-a');
    }
  });

  it('a fixed fallback the model lacks goes out as the provider default and says so', async () => {
    const s = await setup({
      levels: ['low', 'medium'],
      settings: { ...LOCAL, fallback: { kind: 'fixed', effort: 'xhigh' } },
      local: { refuse: 'busy' },
    });
    const permit = await s.host().prepareModelRequest(record(), { snapshot: snapshot('fix it') });
    expect(permit.reasoning).toMatchObject({
      resolved: null,
      route: { fallback: { reason: 'busy', targetUnsupported: true } },
    });
  });

  it('one supported level is used without asking the engine', async () => {
    const s = await setup({ levels: ['high'] });
    const permit = await s.host().prepareModelRequest(record(), { snapshot: snapshot('fix it') });
    expect(permit.reasoning).toMatchObject({ resolved: 'high', source: 'single-level' });
    expect(s.local.admits).toBe(0);
  });

  it('P07: a request too large to judge in full asks no engine and keeps the context', async () => {
    const s = await setup();
    const permit = await s.host().prepareModelRequest(record(), {
      snapshot: snapshot('x'.repeat(4000)),
    });
    expect(permit.reasoning).toMatchObject({
      source: 'fallback',
      route: {
        fallback: { reason: 'insufficient-context', insufficient: 'required-content-over-budget' },
      },
    });
    expect(s.local.requests).toHaveLength(0);
  });

  it('a request without a snapshot is insufficient context, not a judgment', async () => {
    const s = await setup();
    const permit = await s.host().prepareModelRequest(record());
    expect(permit.reasoning).toMatchObject({
      route: { fallback: { reason: 'insufficient-context', insufficient: 'missing-request' } },
    });
  });

  it('settings changed during a judgment make the preparation stale', async () => {
    const s = await setup({ local: { answer: 'hold' } });
    const pending = s.host().prepareModelRequest(record(), { snapshot: snapshot('fix it') });
    await drain();
    s.settings.current = { mode: 'off' };
    s.local.flights[0]!.respond();
    s.local.flights[0]!.settle();
    await expect(pending).rejects.toThrow('REASONING_STALE');
  });
});

describe('parent questions are fixed before the judgment (P05)', () => {
  it('judges the questions the request carries and appends only those missing', async () => {
    const clock = new FakeClock();
    const local = new FakeRoutingBackend({ kind: 'local' });
    const definition = linearCorral(['parent']);
    definition.roles[0]!.reasoning = { mode: 'auto' };
    definition.roles[0]!.allowedCollaborationTools.push('spawn_subagents', 'await_tasks', 'reply');
    definition.roles.push({
      ...definition.roles[0]!,
      id: 'child_role',
      name: 'Child',
      reasoning: { mode: 'fixed', level: 'low' },
      allowedCollaborationTools: ['ask', 'submit_result'],
    });
    definition.nodes.push({
      id: 'child',
      type: 'agent',
      label: 'Child',
      roleId: 'child_role',
      invocation: 'callable',
      inputBindings: [],
      outputName: 'text',
    });
    definition.capabilityLinks.push({
      id: 'delegate_child',
      kind: 'delegate',
      sourceNodeId: 'parent',
      targetNodeId: 'child',
      parentQuestions: true,
    });
    const checks: Promise<void>[] = [];
    const coordinator = new Coordinator({
      clock,
      timers: clock,
      ids: new SequentialIdFactory(),
      policy: SPEC_HARD_CAPS,
      effortRouting: { settings: () => LOCAL, backend: () => local },
      models: {
        resolve: (profile) => ({
          ok: true,
          snapshot: {
            profile,
            provider: 'openai-codex',
            modelId: 'gpt-6-luna',
            auth: 'oauth',
            reasoning: { levels: ['low', 'medium', 'high', 'xhigh'], providerDefault: true },
          },
        }),
      },
      agents: {
        async start(input, host) {
          let settle!: (value: AgentSettlement) => void;
          const done = new Promise<AgentSettlement>((resolve) => {
            settle = resolve;
          });
          if (input.nodeId === 'child') {
            void host.invokeTool({
              name: 'ask',
              args: { targetNodeId: 'parent', body: 'Which file owns the parser?' },
            });
          } else {
            checks.push(
              (async () => {
                const batch = await host.invokeTool({
                  name: 'spawn_subagents',
                  args: { tasks: [{ targetNodeId: 'child', brief: 'look' }] },
                });
                if (!batch.ok) throw new Error(batch.error.message);
                for (let i = 0; i < 5; i++) {
                  const awaited = await host.invokeTool({
                    name: 'await_tasks',
                    args: { taskIds: batch.result.taskIds },
                  });
                  if (awaited.ok && (awaited.result.parentQuestions as unknown[])?.length) break;
                }
                const first = await host.prepareModelRequest(record(1), {
                  snapshot: snapshot('Split the work.'),
                });
                const questionId = first.parentQuestions?.[0]?.questionId;
                expect(first.parentQuestions?.map((q) => q.body)).toEqual([
                  'Which file owns the parser?',
                ]);
                expect(local.requests[0]!.state).toContain('Which file owns the parser?');
                await host.modelRequestDispatched?.(first.modelCallId);
                await host.observe({
                  kind: 'model_completed',
                  modelCallId: first.modelCallId,
                  text: 'thinking',
                  usage: { inputTokens: 1, outputTokens: 1 },
                });
                // The context now holds the question: the request appends nothing, and the
                // judgment still reads it.
                const next = await host.prepareModelRequest(record(2), {
                  snapshot: snapshot('Split the work.', { presentQuestionIds: [questionId!] }),
                });
                expect(next.parentQuestions).toBeUndefined();
                expect(local.requests[1]!.state).toContain('Which file owns the parser?');
                settle({ outcome: 'cancelled' });
              })(),
            );
          }
          return {
            cancel: async () => settle({ outcome: 'cancelled' }),
            waitForSettlement: () => done,
          };
        },
      },
    });
    const start = coordinator.startRun({
      schemaVersion: '0.1',
      commandId: 'start',
      mode: 'live',
      definition,
    });
    if (!start.runId) throw new Error(JSON.stringify(start.receipt.error));
    for (let i = 0; i < 50 && checks.length === 0; i++) await drain();
    await checks[0];
    expect(local.requests).toHaveLength(2);
  });
});
