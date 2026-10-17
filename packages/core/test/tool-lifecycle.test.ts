import type { AgentSettlement, ToolOutcome } from '@corral/contracts';
import { FakeClock, Gate, linearCorral, SequentialIdFactory } from '@corral/testkit';
import { expect, it } from 'vitest';
import {
  Coordinator,
  InMemoryRunStore,
  InProcessTransport,
  waitForProjection,
  ToolTerminationUnconfirmed,
} from '../src/index.ts';

async function setup(termination: 'normal' | 'error', response: 'success' | 'error' | 'unconfirmed' = 'success') {
  const clock = new FakeClock(),
    entered = new Gate(),
    finish = new Gate(),
    release = new Gate();
  const store = new InMemoryRunStore();
  let cancelled = false;
  let pending!: Promise<ToolOutcome>;
  const coordinator = new Coordinator({
    clock,
    timers: clock,
    ids: new SequentialIdFactory(),
    store,
    files: {
      available: () => true,
      execute: async (_input, cancellation) => {
        const off = cancellation.onCancel(() => {
          cancelled = true;
        });
        entered.open();
        await release.wait();
        off();
        if (response === 'error') throw new Error('late backend failure');
        if (response === 'unconfirmed') throw new ToolTerminationUnconfirmed();
        return { text: 'late file body' };
      },
    },
    agents: {
      start: async (_input, host) => {
        pending = host.invokeTool({ name: 'read_file', args: { path: 'file.txt' } });
        return {
          cancel: async () => finish.open(),
          waitForSettlement: async (): Promise<AgentSettlement> => {
            await finish.wait();
            if (termination === 'error') throw new Error('worker disconnected');
            return { outcome: 'failed' };
          },
        };
      },
    },
  });
  const definition = linearCorral(['writer']);
  const role = definition.roles[0];
  if (!role) throw new Error('missing role');
  role.allowedWorkTools = ['read_file'];
  const { runId } = coordinator.startRun({
    schemaVersion: '0.1',
    commandId: 'start',
    definition,
    mode: 'mock',
  });
  if (!runId) throw new Error('run did not start');
  await entered.wait();
  return {
    clock,
    coordinator,
    store,
    runId,
    entered,
    finish,
    release,
    pending: () => pending,
    cancelled: () => cancelled,
    transport: new InProcessTransport(coordinator),
  };
}
const drain = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

it('[TC-HAR-012-N] unconfirmed tool process termination settles unknown and prevents another Run', async()=>{
  const s=await setup('normal','unconfirmed');s.release.open();
  expect((await s.pending()).ok).toBe(false);
  s.finish.open();
  await waitForProjection(s.transport,s.runId,p=>p.status==='failed');
  const events=s.store.readEvents(s.runId,0);
  const started=events.find(e=>e.type==='tool.started');if(!started||started.type!=='tool.started')throw new Error('missing tool effect');
  expect(events.find(e=>e.type==='effect.settled'&&e.payload.effectId===started.payload.effectId)?.payload).toMatchObject({outcome:'unknown'});
  expect(s.coordinator.startRun({schemaVersion:'0.1',commandId:'another',definition:linearCorral(['writer']),mode:'mock'}).runId).toBeNull();
});

it('[TC-HAR-012-N] normal and exceptional worker endings cancel and drain an owned tool before settling the execution', async () => {
  for (const termination of ['normal', 'error'] as const) {
    const s = await setup(termination);
    s.finish.open();
    await drain();
    expect(s.cancelled()).toBe(true);
    expect(
      s.store.readEvents(s.runId, 0).filter((e) => e.type === 'execution.settled'),
    ).toHaveLength(0);
    s.release.open();
    expect((await s.pending()).ok).toBe(false);
    await waitForProjection(s.transport, s.runId, (p) => p.status === 'failed');
    expect(
      s.store
        .readEvents(s.runId, 0)
        .some((e) => e.type === 'tool.finished' && e.payload.resultRef !== null),
    ).toBe(false);
  }
});
it('[TC-HAR-012-N] late success and error cannot settle an already unknown effect a second time', async () => {
  for (const response of ['success', 'error'] as const) {
    const s = await setup('normal', response);
    const started = s.store.readEvents(s.runId, 0).find((e) => e.type === 'tool.started');
    if (!started || started.type !== 'tool.started') throw new Error('missing effect');
    s.coordinator.submit({
      schemaVersion: '0.1',
      commandId: 'cancel',
      runId: s.runId,
      type: 'cancel',
      payload: { scope: { kind: 'run' }, reason: 'stop' },
    });
    await drain();
    s.clock.advance(10001);
    await drain();
    s.release.open();
    await s.pending();
    await drain();
    const settlements = s.store
      .readEvents(s.runId, 0)
      .filter(
        (e) => e.type === 'effect.settled' && e.payload.effectId === started.payload.effectId,
      );
    expect(settlements).toHaveLength(1);
    expect(settlements[0]?.payload).toMatchObject({ outcome: 'unknown' });
  }
});
