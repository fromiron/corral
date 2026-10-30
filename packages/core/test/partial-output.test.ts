import type { AgentHost, AgentSettlement } from '@corral/contracts';
import { FakeClock, linearCorral, SequentialIdFactory } from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import { Coordinator, exportRunArchive, InMemoryRunStore } from '../src/index.ts';

async function fixture() {
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
        let finish!: (value: AgentSettlement) => void;
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
  if (!runId) throw new Error('missing run');
  const drain = async () => {
    for (let i = 0; i < 100; i++) await Promise.resolve();
  };
  await drain();
  const permit = await host.prepareModelRequest();
  const stream = (chunkIndex: number, text: string) =>
    host.streamText({ modelCallId: permit.modelCallId, chunkIndex, text });
  const cancel = async () => {
    coordinator.submit({
      schemaVersion: '0.1',
      commandId: 'stop',
      runId,
      type: 'cancel',
      payload: { scope: { kind: 'run' }, reason: 'stop' },
    });
    await drain();
  };
  return { store, coordinator, host, runId, permit, stream, cancel };
}

describe('private partial model output', () => {
  it('retains ordered output after cancellation without finalizing it or accepting late chunks', async () => {
    const f = await fixture();
    f.stream(0, 'Received ');
    f.stream(0, 'duplicate');
    f.stream(1, '**prefix**');
    await f.cancel();
    const before = f.coordinator.getSnapshot(f.runId).projection;
    f.stream(2, ' late text');
    const snapshot = f.coordinator.getSnapshot(f.runId);
    expect(snapshot.partialOutputs?.[f.permit.modelCallId]).toEqual({
      text: 'Received **prefix**',
      next: 2,
      truncated: false,
    });
    expect(snapshot.projection).toEqual(before);
    expect(snapshot.projection.status).toBe('cancelled');
    expect(snapshot.projection.modelCalls[f.permit.modelCallId]?.responseRef).toBeNull();
    expect(snapshot.projection.output).toBeNull();
    expect(JSON.stringify(exportRunArchive(f.store, f.runId))).not.toContain('Received');
    expect(
      JSON.stringify(exportRunArchive(f.store, f.runId, { privateTranscript: true })),
    ).not.toContain('Received');
  });
  it('does not join a missing chunk or publish an unknown call', async () => {
    const f = await fixture();
    f.stream(0, 'prefix');
    f.stream(2, 'gap');
    f.stream(1, 'out of order');
    f.host.streamText({ modelCallId: 'unknown', chunkIndex: 0, text: 'wrong call' });
    await f.cancel();
    expect(f.coordinator.getSnapshot(f.runId).partialOutputs).toEqual({
      [f.permit.modelCallId]: { text: 'prefix', next: 1, truncated: true },
    });
  });
  it('bounds stored output and clearly marks the retained prefix', async () => {
    const f = await fixture();
    f.stream(0, 'x'.repeat(1_048_577));
    await f.cancel();
    const output = f.coordinator.getSnapshot(f.runId).partialOutputs?.[f.permit.modelCallId];
    expect(output?.text.length).toBe(1_048_576);
    expect(output?.truncated).toBe(true);
  });
  it('a confirmed response replaces the partial display without changing immutable records', async () => {
    const f = await fixture();
    f.stream(0, 'draft');
    f.host.observe({
      kind: 'model_completed',
      modelCallId: f.permit.modelCallId,
      text: 'confirmed',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    await f.cancel();
    expect(
      f.coordinator.getSnapshot(f.runId).partialOutputs?.[f.permit.modelCallId],
    ).toBeUndefined();
    expect(f.store.getArtifactText(f.runId, `response_${f.permit.modelCallId}`)).toBe('confirmed');
  });
});

it('bounds the number of persisted chunks even when every delta is empty', async () => {
  const f = await fixture();
  for (let index = 0; index <= 16_384; index++) f.stream(index, '');
  await f.cancel();
  expect(f.coordinator.getSnapshot(f.runId).partialOutputs?.[f.permit.modelCallId]).toEqual({
    text: '',
    next: 16_384,
    truncated: true,
  });
});
