import type {
  AgentAdapter,
  AgentHost,
  AgentSettlement,
  AutoReasoning,
  CallSnapshotInput,
  EffortRoutingSettings,
  ModelRequestRecord,
  RoutingBackend,
  RunEvent,
} from '@corral/contracts';
import { FakeClock, FakeRoutingBackend, SequentialIdFactory } from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import { Coordinator, createAutoStarter, InProcessTransport } from '../src/index.ts';

// models-and-resources.md: a team-none conversation judges per-request reasoning on each
// lead request. The engine is injected; these tests make no provider call.

async function drain() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

const LOCAL: EffortRoutingSettings = {
  mode: 'manual',
  engine: { kind: 'local', device: { kind: 'cpu', threads: 4 }, callerTimeoutMs: 5000 },
  fallback: { kind: 'provider-default' },
};

const record = (context: number): ModelRequestRecord => ({
  purpose: 'turn',
  runtime: 'pi-core',
  directiveIds: [],
  contextHash: context.toString(16).padStart(64, '0'),
  contextBytes: 10,
  sections: [],
});

const snapshot = (text: string): CallSnapshotInput => ({
  request: { text },
  requestImages: 0,
  previousAssistant: null,
  toolCalls: [],
  earlierReplies: [],
  presentQuestionIds: [],
});

async function startConversation(options: {
  reasoning: AutoReasoning;
  backend: RoutingBackend | null;
  clock: FakeClock;
}) {
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
  const coordinator = new Coordinator({
    clock: options.clock,
    timers: options.clock,
    ids: new SequentialIdFactory(),
    agents,
    effortRouting: {
      settings: () => LOCAL,
      backend: () => options.backend,
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
            levels: ['low', 'medium', 'high', 'xhigh'],
            providerDefault: true,
          },
        },
      }),
    },
  });
  const transport = new InProcessTransport(coordinator);
  const starter = createAutoStarter({
    startRun: (request) => coordinator.startRun(request),
  });
  const started = await starter.start(
    {
      commandId: 'cmd_conversation_route',
      sessionId: 'session_conversation',
      brief: 'Rename the field and explain the change.',
      mode: 'live',
      choice: { modelProfile: 'model-a', reasoning: options.reasoning },
      team: 'none',
    },
    { fileTools: false },
  );
  if (!started.runId) throw new Error(JSON.stringify(started.receipt.error));
  const events: RunEvent[] = [];
  transport.subscribe(started.runId, 0, { onEvent: (event) => events.push(event) });
  for (let i = 0; i < 50 && hosts.length === 0; i++) await drain();
  const host = hosts[0];
  if (!host) throw new Error('the conversation lead did not start');
  const roles = coordinator.getRunSnapshot(started.runId)?.definition.roles ?? [];
  const prepare = (context: number, text: string) =>
    host.prepareModelRequest(record(context), { snapshot: snapshot(text) });
  return { host, lead: roles[0], helper: roles[1], prepare, settle, events, runId: started.runId };
}

describe('team-none per-request reasoning', () => {
  it('records a judged level for each of the lead requests', async () => {
    const clock = new FakeClock();
    const choices = ['low', 'high'] as const;
    let calls = 0;
    const judge = new FakeRoutingBackend({
      kind: 'local',
      now: () => clock.monotonicMs(),
      answer: () => ({ choice: choices[calls++] ?? 'medium' }),
    });
    const conversation = await startConversation({
      reasoning: { mode: 'route' },
      backend: judge,
      clock,
    });
    const first = await conversation.prepare(1, 'Rename the field.');
    await conversation.host.modelRequestDispatched?.(first.modelCallId);
    await conversation.host.observe({
      kind: 'model_completed',
      modelCallId: first.modelCallId,
      text: 'Reading the schema.',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const second = await conversation.prepare(2, 'Apply the rename.');
    await drain();
    expect(first.reasoning).toMatchObject({
      source: 'router',
      resolved: 'low',
      requested: { mode: 'auto' },
    });
    expect(second.reasoning).toMatchObject({ source: 'router', resolved: 'high' });
    expect(conversation.lead?.reasoning).toEqual({ mode: 'auto' });
    expect(conversation.helper?.reasoning).toEqual({ mode: 'auto' });
    expect(judge.requests).toHaveLength(2);
    expect(first.reasoning?.preparationId).not.toBe(second.reasoning?.preparationId);
    expect(
      conversation.events
        .filter((event) => event.type === 'model.request_prepared')
        .map((event) => event.payload.reasoning?.resolved),
    ).toEqual(['low', 'high']);
  });

  it('falls back when the judge is unavailable', async () => {
    const clock = new FakeClock();
    const conversation = await startConversation({
      reasoning: { mode: 'route' },
      backend: null,
      clock,
    });
    const permit = await conversation.prepare(1, 'Rename the field.');
    expect(permit.reasoning).toMatchObject({
      source: 'fallback',
      resolved: null,
      requested: { mode: 'auto' },
      route: { fallback: { reason: 'unavailable', target: { kind: 'provider-default' } } },
    });
  });

  it('keeps a fixed level and does not call the judge', async () => {
    const clock = new FakeClock();
    const judge = new FakeRoutingBackend({
      kind: 'local',
      now: () => clock.monotonicMs(),
      answer: () => ({ choice: 'low' }),
    });
    const conversation = await startConversation({
      reasoning: { mode: 'fixed', level: 'high' },
      backend: judge,
      clock,
    });
    const permit = await conversation.prepare(1, 'Rename the field.');
    expect(conversation.lead?.reasoning).toEqual({ mode: 'fixed', level: 'high' });
    expect(permit.reasoning).toMatchObject({ source: 'fixed', resolved: 'high' });
    expect(judge.admits).toBe(0);
    expect(judge.requests).toHaveLength(0);
  });
});
