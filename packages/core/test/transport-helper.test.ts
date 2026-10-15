import type { RunEvent } from '@corral/contracts';
import { expect, it, vi } from 'vitest';
import { emptyProjection, type RuntimeTransport, waitForProjection } from '../src/index.ts';

const event: RunEvent = {
  schemaVersion: '0.1',
  eventId: 'event_1',
  runId: 'run_1',
  runSeq: 1,
  recordedAt: '2026-10-15T00:00:00.000Z',
  actor: { kind: 'runtime', id: 'runtime' },
  causedByEventIds: [],
  type: 'run.state_changed',
  payload: { from: 'running', to: 'succeeded', reasonCode: 'done' },
};

it('unsubscribes when the first matching event replays synchronously during subscribe', async () => {
  const unsubscribe = vi.fn();
  const transport: Pick<RuntimeTransport, 'getSnapshot' | 'subscribe'> = {
    getSnapshot: async () => ({ projection: emptyProjection('run_1'), seq: 0 }),
    subscribe: (_runId, _after, handlers) => {
      handlers.onEvent(event);
      return unsubscribe;
    },
  };
  await expect(
    waitForProjection(transport as RuntimeTransport, 'run_1', (p) => p.status === 'succeeded'),
  ).resolves.toMatchObject({ status: 'succeeded' });
  expect(unsubscribe).toHaveBeenCalledTimes(1);
});

it('unsubscribes when subscribe reports a synchronous error', async () => {
  const unsubscribe = vi.fn();
  const transport: Pick<RuntimeTransport, 'getSnapshot' | 'subscribe'> = {
    getSnapshot: async () => ({ projection: emptyProjection('run_1'), seq: 0 }),
    subscribe: (_runId, _after, handlers) => {
      handlers.onError?.(new Error('unavailable'));
      return unsubscribe;
    },
  };
  await expect(
    waitForProjection(transport as RuntimeTransport, 'run_1', (p) => p.status === 'succeeded'),
  ).rejects.toThrow('unavailable');
  expect(unsubscribe).toHaveBeenCalledTimes(1);
});
