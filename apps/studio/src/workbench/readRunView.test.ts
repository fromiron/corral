import { emptyProjection } from '@corral/core';
import { linearCorral } from '@corral/testkit';
import { expect, it, vi } from 'vitest';
import { readRunView } from './readRunView.ts';

it('[DW-03] reading more than sixteen finished turns opens no event streams or commands', async () => {
  const transport = {
    getSnapshot: vi.fn(async (id: string) => ({
      projection: { ...emptyProjection(id), status: 'succeeded' as const },
      seq: 0,
    })),
    getRunDefinition: vi.fn(async () => linearCorral(['writer'])),
    subscribe: vi.fn(() => {
      throw new Error('history must not subscribe');
    }),
    sendCommand: vi.fn(() => {
      throw new Error('history must not command');
    }),
  };
  const history = vi.fn(async () => {
    throw new Error('closed work log must not load transcript');
  });
  const views = await Promise.all(
    Array.from({ length: 24 }, (_, i) => readRunView(transport, history, `run_${i}`, false)),
  );
  expect(views.map((v) => v.runId)).toEqual(Array.from({ length: 24 }, (_, i) => `run_${i}`));
  expect(transport.subscribe).not.toHaveBeenCalled();
  expect(transport.sendCommand).not.toHaveBeenCalled();
  expect(history).not.toHaveBeenCalled();
});

it('PERF-01 shares in-flight reads within the same transport and history boundary', async () => {
  const transport = {
    getSnapshot: vi.fn(async (id: string) => ({
      projection: { ...emptyProjection(id), status: 'succeeded' as const },
      seq: 0,
    })),
    getRunDefinition: vi.fn(async () => linearCorral(['writer'])),
  };
  const history = vi.fn(async () => null);
  await Promise.all([
    readRunView(transport, history, 'run_same', false),
    readRunView(transport, history, 'run_same', false),
  ]);
  expect(transport.getSnapshot).toHaveBeenCalledTimes(1);
  expect(transport.getRunDefinition).toHaveBeenCalledTimes(1);
  await readRunView(transport, history, 'run_same', false);
  expect(transport.getSnapshot).toHaveBeenCalledTimes(2);
  await readRunView({ ...transport }, history, 'run_same', false);
  expect(transport.getSnapshot).toHaveBeenCalledTimes(3);
  await readRunView(
    transport,
    vi.fn(async () => null),
    'run_same',
    false,
  );
  expect(transport.getSnapshot).toHaveBeenCalledTimes(4);
});

it('PERF-01 rereads late settlement facts after terminal status', async () => {
  let lastSeq = 10;
  const transport = {
    getSnapshot: vi.fn(async (id: string) => ({
      projection: { ...emptyProjection(id), lastSeq, status: 'succeeded' as const },
      seq: lastSeq,
    })),
    getRunDefinition: vi.fn(async () => linearCorral(['writer'])),
  };
  const history = vi.fn(async () => null);
  expect((await readRunView(transport, history, 'run_late', false)).projection.lastSeq).toBe(10);
  lastSeq = 12;
  expect((await readRunView(transport, history, 'run_late', false)).projection.lastSeq).toBe(12);
});

it('PLAN-04 retries failed reads and never caches an active run as final', async () => {
  const transport = {
    getSnapshot: vi
      .fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockImplementation(async (id: string) => ({
        projection: { ...emptyProjection(id), status: 'running' as const },
        seq: 0,
      })),
    getRunDefinition: vi.fn(async () => linearCorral(['writer'])),
  };
  const history = vi.fn(async () => null);
  await expect(readRunView(transport, history, 'run_retry', false)).rejects.toThrow('transient');
  await readRunView(transport, history, 'run_retry', false);
  await readRunView(transport, history, 'run_retry', false);
  expect(transport.getSnapshot).toHaveBeenCalledTimes(3);
});
