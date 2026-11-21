import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type LinuxProcessIdentity, linuxBootId } from '@corral/adapter-pi/processes';
import { spawn } from 'node-pty';
import { expect, it } from 'vitest';
import { ptyForeground } from '../src/processes/pty-foreground.ts';
import {
  cleanupPtyLaunch,
  cleanupPtySession,
  observePtyLaunch,
  type PtySessionIdentity,
  waitForPtySession,
} from '../src/processes/pty-session.ts';

const shell: PtySessionIdentity = {
  pid: 123,
  bootId: 'boot',
  startTicks: '42',
  sessionId: 123,
  owner: 'owner',
};
const stat =
  (overrides: Partial<LinuxProcessIdentity> = {}) =>
  () => ({
    startTicks: '42',
    group: 123,
    session: 123,
    terminalGroup: 123,
    state: 'S',
    ...overrides,
  });

it('is idle while the terminal’s foreground group is the shell’s own', () => {
  expect(ptyForeground(shell, stat())).toBe('idle');
});

it('is busy while another process group the shell started holds the foreground', () => {
  expect(ptyForeground(shell, stat({ terminalGroup: 456 }))).toBe('busy');
});

it('is unknown when the shell cannot be read, is gone, or is another process by now', () => {
  expect(ptyForeground(shell, () => null)).toBe('unknown');
  expect(
    ptyForeground(shell, () => {
      throw new Error('Process identity unavailable');
    }),
  ).toBe('unknown');
  // The PID was reused: another process's terminal says nothing about this shell.
  expect(ptyForeground(shell, stat({ startTicks: '43' }))).toBe('unknown');
  // No controlling terminal, or a field that did not parse.
  expect(ptyForeground(shell, stat({ terminalGroup: -1 }))).toBe('unknown');
  expect(ptyForeground(shell, stat({ terminalGroup: Number.NaN }))).toBe('unknown');
  expect(ptyForeground(shell, stat({ state: 'Z' }))).toBe('unknown');
});

it('is unknown off Linux, where the default reader cannot read the process table', () => {
  if (process.platform === 'linux') return;
  expect(ptyForeground(shell)).toBe('unknown');
});

it.skipIf(process.platform !== 'linux')(
  'reads a real PTY: idle at the prompt and with a background job, busy while a command runs',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'corral-pty-foreground-'));
    const owner = randomUUID();
    const bootId = linuxBootId();
    if (!bootId) throw new Error('Linux boot identity unavailable');
    const child = spawn('/bin/bash', ['--noprofile', '--norc', '-i'], {
      cwd: directory,
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: directory,
        PS1: 'PTY_READY> ',
        CORRAL_PROCESS_OWNER: owner,
      },
    });
    let output = '';
    child.onData((chunk) => {
      output += chunk;
    });
    const exited = new Promise<void>((resolve) => child.onExit(() => resolve()));
    const launch = observePtyLaunch(child.pid, owner, bootId);
    const until = async (done: () => boolean) => {
      const end = Date.now() + 10_000;
      while (!done()) {
        if (Date.now() > end) throw new Error('PTY fixture did not reach its state');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    let identity: PtySessionIdentity | null = null;
    try {
      identity = await waitForPtySession(launch);
      const shellIdentity = identity;
      const prompts = () => output.split('PTY_READY> ').length - 1;
      await until(() => prompts() >= 1);
      expect(ptyForeground(shellIdentity)).toBe('idle');
      // A background job does not take the foreground.
      child.write('sleep 300 &\r');
      await until(() => prompts() >= 2);
      expect(ptyForeground(shellIdentity)).toBe('idle');
      // A command in the foreground does.
      child.write('sleep 300\r');
      await until(() => ptyForeground(shellIdentity) === 'busy');
      child.write('\u0003');
      await until(() => ptyForeground(shellIdentity) === 'idle');
    } finally {
      const cleaned = identity ? await cleanupPtySession(identity) : await cleanupPtyLaunch(launch);
      if (!cleaned) child.kill('SIGKILL');
      await exited;
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);
