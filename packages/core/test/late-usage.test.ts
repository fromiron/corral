import type { AgentHost, AgentObservation, AgentSettlement } from '@corral/contracts';
import { FakeClock, linearCorral, SequentialIdFactory } from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import { applyEvent, Coordinator, emptyProjection, InMemoryRunStore } from '../src/index.ts';

async function setup() {
  const clock = new FakeClock();
  const store = new InMemoryRunStore();
  let host!: AgentHost;
  const coordinator = new Coordinator({
    clock,
    timers: clock,
    store,
    ids: new SequentialIdFactory(),
    agents: {
      async start(_input, bound) {
        host = bound;
        let finish!: (result: AgentSettlement) => void;
        const done = new Promise<AgentSettlement>((resolve) => {
          finish = resolve;
        });
        return {
          cancel: async () => finish({ outcome: 'cancelled' }),
          waitForSettlement: () => done,
        };
      },
    },
  });
  const { runId } = coordinator.startRun({
    schemaVersion: '0.1',
    commandId: 'start',
    mode: 'mock',
    definition: linearCorral(['writer']),
  });
  if (!runId) throw new Error('run did not start');
  const drain = async () => {
    for (let i = 0; i < 100; i++) await Promise.resolve();
  };
  await drain();
  const permit = await host.prepareModelRequest();
  await host.modelRequestDispatched?.(permit.modelCallId);
  const projection = () => coordinator.getSnapshot(runId).projection;
  const events = () => store.readEvents(runId, 0);
  const observe = (
    usage: AgentObservation['usage'],
    rawUsage: Record<string, unknown> | null,
    text = 'late response must not be saved',
  ) =>
    host.observe({
      kind: 'model_completed',
      modelCallId: permit.modelCallId,
      text,
      usage,
      ...(rawUsage === null ? {} : { rawUsage }),
    });
  const cancel = async () => {
    coordinator.submit({
      schemaVersion: '0.1',
      commandId: 'cancel',
      runId,
      type: 'cancel',
      payload: { scope: { kind: 'run' }, reason: 'stop' },
    });
    await drain();
  };
  return { runId, store, permit, projection, events, observe, cancel };
}

describe('late usage accounting', () => {
  it('stores unknown then full late usage once without changing cancelled state or progress', async () => {
    const s = await setup();
    await s.cancel();
    const before = s.projection();
    const unknown = { inputTokens: null, outputTokens: null };
    const emptyRaw = { input: 0, output: 0, cacheRead: 0, reasoning: 0 };
    await s.observe(unknown, emptyRaw);
    await s.observe(unknown, emptyRaw);
    const usage = { inputTokens: 100, outputTokens: 37, cachedInputTokens: 50, reasoningTokens: 7 };
    const rawUsage = { input: 50, output: 37, cacheRead: 50, reasoning: 7, totalTokens: 137 };
    await s.observe(usage, rawUsage);
    await s.observe(usage, rawUsage);
    const after = s.projection();
    expect(after.modelCalls[s.permit.modelCallId]).toMatchObject({
      finished: false,
      responseRef: null,
      usage,
      rawUsage,
      certainty: 'reported',
    });
    const accounting = s.events().filter((event) => event.type === 'model.usage_reconciled');
    expect(accounting).toHaveLength(2);
    expect(accounting[1]?.payload).toMatchObject({ normalizedUsage: usage, rawUsage });
    expect(after.budget).toMatchObject({ spent: 37, reserved: 0, unknownOutstanding: 0 });
    expect(after.status).toBe('cancelled');
    expect(after.tasks).toEqual(before.tasks);
    expect(after.executions).toEqual(before.executions);
    expect(after.progress).toEqual(before.progress);
    expect(s.store.getArtifactText(s.runId, `response_${s.permit.modelCallId}`)).toBeNull();
    expect(s.events().reduce(applyEvent, emptyProjection(s.runId))).toEqual(after);
  });

  it.each([
    {
      initial: { inputTokens: 100, outputTokens: null },
      late: { inputTokens: null, outputTokens: 37 },
    },
    {
      initial: { inputTokens: null, outputTokens: 37 },
      late: { inputTokens: 100, outputTokens: null },
    },
  ])(
    'fills missing categories without replacing confirmed counts or response text: $initial',
    async ({ initial, late }) => {
      const s = await setup();
      await s.observe(initial, null, 'original response');
      const progress = s.projection().progress;
      const usage = { ...late, cachedInputTokens: 50, reasoningTokens: 7 };
      const rawUsage = { input: 50, output: 37, cacheRead: 50, reasoning: 7, totalTokens: 137 };
      await s.observe(usage, rawUsage);
      await s.observe(usage, rawUsage);
      await s.observe({ inputTokens: 999, outputTokens: 999 }, { input: 999, output: 999 });
      expect(s.projection().modelCalls[s.permit.modelCallId]).toMatchObject({
        finished: true,
        responseRef: `response_${s.permit.modelCallId}`,
        usage: { inputTokens: 100, outputTokens: 37, cachedInputTokens: 50, reasoningTokens: 7 },
        rawUsage,
        certainty: 'reported',
      });
      expect(s.events().filter((event) => event.type === 'model.usage_reconciled')).toHaveLength(1);
      expect(s.projection().budget.spent).toBe(37);
      expect(s.projection().progress).toEqual(progress);
      expect(s.store.getArtifactText(s.runId, `response_${s.permit.modelCallId}`)).toBe(
        'original response',
      );
      await s.cancel();
    },
  );
});
