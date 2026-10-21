import type { Receipt, RunCommand } from '@corral/contracts';
import { emptyProjection } from '@corral/core';
import { linearCorral } from '@corral/testkit';
import { expect, it, vi } from 'vitest';
import { createRunRecovery } from '../src/run/recovery.ts';
import { createRunSession } from '../src/run/session.ts';

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}
function receipt(command: RunCommand): Receipt {
  return {
    commandId: command.commandId,
    runId: command.runId,
    status: 'applied',
    target: `run:${command.runId}`,
    requestedBoundary: 'immediate',
    acceptedSeq: 1,
    relatedEventIds: [],
  };
}

it('[TC-ABS-014-H] reopening recovers the authoritative receipt without resending a lost command', async () => {
  const disk = storage();
  const journal = createRunRecovery(disk, 'host_one');
  let committed: Receipt | null = null;
  const sendCommand = vi.fn(async (command: RunCommand) => {
    committed = receipt(command);
    throw new Error('Lost response');
  });
  const transport = {
    sendCommand,
    getReceipt: vi.fn(async () => committed),
    getRunDefinition: async () => linearCorral(['writer']),
    subscribe: vi.fn(() => () => {}),
  };
  const first = createRunSession(transport as never, () => 'cmd_lost', journal);
  first.setState({ runId: 'run_one', projection: emptyProjection('run_one') });
  await expect(
    first.getState().sendCommand({ type: 'pause', payload: { scope: 'run' } }),
  ).rejects.toThrow('Lost response');
  first.getState().dispose();
  const restored = createRunSession(
    transport as never,
    undefined,
    createRunRecovery(disk, 'host_one'),
  );
  await restored.getState().open('run_one');
  expect(restored.getState().receipts.cmd_lost).toEqual(committed);
  expect(restored.getState().unconfirmedCommands).toEqual({});
  expect(sendCommand).toHaveBeenCalledTimes(1);
  restored.getState().dispose();
});

it('[TC-ABS-014-N] an unreceived command waits for explicit retry with the same ID and excludes other hosts', async () => {
  const disk = storage();
  let offline = true;
  const sent: RunCommand[] = [];
  const transport = {
    sendCommand: vi.fn(async (command: RunCommand) => {
      sent.push(command);
      if (offline) throw new Error('offline');
      return receipt(command);
    }),
    getReceipt: vi.fn(async () => null),
    getRunDefinition: async () => linearCorral(['writer']),
    subscribe: () => () => {},
  };
  const first = createRunSession(
    transport as never,
    () => 'cmd_same',
    createRunRecovery(disk, 'host_one'),
  );
  first.setState({ runId: 'run_one' });
  await expect(first.getState().steer('execution_one', 'Keep this scope')).rejects.toThrow(
    'offline',
  );
  first.getState().dispose();
  offline = false;
  const other = createRunSession(
    transport as never,
    undefined,
    createRunRecovery(disk, 'host_two'),
  );
  await other.getState().open('run_one');
  expect(other.getState().unconfirmedCommands).toEqual({});
  const restored = createRunSession(
    transport as never,
    undefined,
    createRunRecovery(disk, 'host_one'),
  );
  await restored.getState().open('run_one');
  expect(sent).toHaveLength(1);
  await restored.getState().retryCommand('cmd_same');
  expect(sent).toEqual([sent[0], sent[0]]);
  expect(transport.getReceipt).toHaveBeenCalledWith('run_one', 'cmd_same');
  other.getState().dispose();
  restored.getState().dispose();
});

it('[TC-ABS-014-N] unavailable durable storage prevents sending a command that could not be recovered', async () => {
  const disk = storage();
  disk.setItem = () => {
    throw new Error('quota');
  };
  const sendCommand = vi.fn();
  const first = createRunSession(
    { sendCommand } as never,
    () => 'cmd_quota',
    createRunRecovery(disk, 'host_one'),
  );
  first.setState({ runId: 'run_one' });
  await expect(first.getState().steer('execution_one', 'Text')).rejects.toThrow('recovery');
  expect(sendCommand).not.toHaveBeenCalled();
});
