import type { AgentHost, AgentStartInput } from '@corral/contracts';
import { FakeClock, Gate, linearCorral, SequentialIdFactory } from '@corral/testkit';
import { expect, it, vi } from 'vitest';
import { Coordinator } from '../src/index.ts';

it('[TC-PROMPT-002-H] [TC-PROMPT-002-N] a review-only brief narrows real file permissions without changing the saved definition', async () => {
  const ready = new Gate(),
    done = new Gate();
  let host!: AgentHost, input!: AgentStartInput;
  const execute = vi.fn(async () => ({ text: 'existing file' }));
  const definition = linearCorral(['writer']);
  definition.roles[0]!.allowedWorkTools = ['read_file', 'write_file', 'write_artifact'];
  definition.input.taskScope = 'review_only';
  definition.input.verificationScope = 'release';
  const coordinator = new Coordinator({
    clock: new FakeClock(),
    ids: new SequentialIdFactory(),
    files: { available: () => true, execute },
    agents: {
      start: async (i, h) => {
        input = i;
        host = h;
        ready.open();
        return {
          cancel: async () => done.open(),
          waitForSettlement: async () => {
            await done.wait();
            return { outcome: 'cancelled' as const };
          },
        };
      },
    },
  });
  const started = coordinator.startRun({
    schemaVersion: '0.1',
    commandId: 'review',
    definition,
    mode: 'mock',
  });
  expect(started.runId).not.toBeNull();
  await ready.wait();
  try {
    expect(input.taskBrief).toMatchObject({
      version: 1,
      taskScope: 'review_only',
      verificationScope: 'release',
      canModifyFiles: false,
      criteriaVersionId: input.criteriaVersionId,
    });
    expect(
      await host.invokeTool({ name: 'write_file', args: { path: 'file.txt', text: 'overwrite' } }),
    ).toMatchObject({ ok: false });
    expect(await host.invokeTool({ name: 'read_file', args: { path: 'file.txt' } })).toMatchObject({
      ok: true,
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(definition.roles[0]!.allowedWorkTools).toContain('write_file');
  } finally {
    done.open();
  }
});
