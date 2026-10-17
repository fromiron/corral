import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ child: undefined as unknown }));
vi.mock('node:child_process', () => ({ fork: () => mocked.child }));

import { processChannel } from '../src/channel.ts';

afterEach(() => vi.restoreAllMocks());

it('[TC-HAR-017-N] an error with a live PID requests termination but waits for actual exit', () => {
  const child = Object.assign(new EventEmitter(), {
    pid: 4321,
    connected: true,
    stderr: new EventEmitter(),
    kill: vi.fn(),
    send: vi.fn(),
  });
  mocked.child = child;
  vi.spyOn(process, 'kill').mockReturnValue(true);
  const channel = processChannel('fixture');
  const exit = vi.fn();
  channel.onExit(exit);
  child.emit('error', new Error('IPC error'));
  expect(exit).not.toHaveBeenCalled();
  expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  child.emit('exit', null);
  child.emit('exit', null);
  expect(exit).toHaveBeenCalledTimes(1);
});
