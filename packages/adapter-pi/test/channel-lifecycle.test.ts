import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ child: undefined as unknown }));
vi.mock('node:child_process', () => ({ fork: () => mocked.child }));

import { processChannel } from '../src/channel.ts';
import { hasOwnedProcessReservations } from '../src/processes/capacity.ts';

afterEach(() => vi.restoreAllMocks());

it('an error with a live PID waits for OS cleanup confirmation before returning capacity', async () => {
  const child = Object.assign(new EventEmitter(), {
    pid: 4321,
    connected: true,
    stderr: new EventEmitter(),
    kill: vi.fn(),
    send: vi.fn(),
  });
  mocked.child = child;
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  const channel = processChannel('fixture');
  const exit = vi.fn();
  channel.onExit(exit);
  child.emit('error', new Error('IPC error'));
  expect(exit).not.toHaveBeenCalled();
  expect(hasOwnedProcessReservations()).toBe(true);
  expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  kill.mockImplementation(() => {
    throw Object.assign(new Error('gone'), { code: 'ESRCH' });
  });
  child.emit('exit', null);
  child.emit('exit', null);
  await expect.poll(() => exit.mock.calls.length).toBe(1);
  expect(exit).toHaveBeenCalledWith(null, true);
  expect(hasOwnedProcessReservations()).toBe(false);
});

it('an exited leader with unreadable group state retains host capacity', async () => {
  const child = Object.assign(new EventEmitter(), {
    pid: 4322,
    connected: true,
    stderr: new EventEmitter(),
    kill: vi.fn(),
    send: vi.fn(),
  });
  mocked.child = child;
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('unavailable'), { code: 'EPERM' });
  });
  const channel = processChannel('fixture');
  const exit = vi.fn();
  channel.onExit(exit);
  child.emit('exit', null);
  await expect.poll(() => exit.mock.calls.length, { timeout: 5000 }).toBe(1);
  expect(exit).toHaveBeenCalledWith(null, false);
  expect(hasOwnedProcessReservations()).toBe(true);
});
