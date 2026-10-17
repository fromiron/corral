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
