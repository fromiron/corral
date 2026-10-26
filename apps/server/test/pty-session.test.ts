import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linuxProcessIdentity } from '@corral/adapter-pi/processes';
import { spawn } from 'node-pty';
import { expect, it } from 'vitest';
import {
  capturePtySession,
  cleanupPtySession,
  type PtySessionIdentity,
} from '../src/processes/pty-session.ts';

it.skipIf(process.platform !== 'linux')(
  'actual PTY Git writes and leaderless job groups clean up together',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'corral-pty-session-'));
    execFileSync('git', ['init', '--quiet', directory]);
    const owner = randomUUID();
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
    let identity: PtySessionIdentity;
    try {
      identity = capturePtySession(child.pid, owner);
    } catch (error) {
      child.kill('SIGKILL');
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    let output = '';
    let changed = () => {};
    const data = child.onData((chunk) => {
      output += chunk;
      changed();
    });
    const exited = new Promise<void>((resolve) => child.onExit(() => resolve()));
    const seen = (pattern: RegExp) =>
      new Promise<RegExpMatchArray>((resolve, reject) => {
        const watchdog = setTimeout(
          () => reject(new Error('PTY fixture did not report its state')),
          30000,
        );
        changed = () => {
          const match = output.match(pattern);
          if (match) {
            clearTimeout(watchdog);
            resolve(match);
          }
        };
        changed();
      });
    const jobs: { pid: number; startTicks: string }[] = [];
    try {
      await seen(/PTY_READY> /);
      child.write(
        'stty -echo; printf \'from terminal\\n\' > terminal.txt; sleep 300 & a=$!; sleep 300 & b=$!; printf \'\\nJOBS=%s,%s\\n\' "$a" "$b"\r',
      );
      const match = await seen(/\r\nJOBS=(\d+),(\d+)\r\n/);
      for (const pid of match.slice(1).map(Number)) {
        const job = linuxProcessIdentity(pid);
        if (!job) throw new Error('PTY background job disappeared');
        expect(job?.session).toBe(identity.sessionId);
        expect(job?.group).not.toBe(identity.pid);
        jobs.push({ pid, startTicks: job.startTicks });
      }
      expect(await readFile(join(directory, 'terminal.txt'), 'utf8')).toBe('from terminal\n');
      expect(
        execFileSync('git', ['-C', directory, 'status', '--porcelain'], { encoding: 'utf8' }),
      ).toContain('?? terminal.txt');
      process.kill(child.pid, 'SIGKILL');
      await exited;
      expect(
        jobs.every(({ pid }) => !['Z', 'X'].includes(linuxProcessIdentity(pid)?.state ?? 'X')),
      ).toBe(true);
      expect(await cleanupPtySession(identity)).toBe(true);
      for (const job of jobs) {
        const current = linuxProcessIdentity(job.pid);
        expect(
          !current || current.startTicks !== job.startTicks || ['Z', 'X'].includes(current.state),
        ).toBe(true);
      }
      expect(await cleanupPtySession(identity)).toBe(true);
    } finally {
      data.dispose();
      for (const job of [...jobs, identity]) {
        const current = linuxProcessIdentity(job.pid);
        if (current?.startTicks === job.startTicks && current.session === identity.sessionId) {
          try {
            process.kill(job.pid, 'SIGKILL');
          } catch {}
        }
      }
      await cleanupPtySession(identity);
      await rm(directory, { recursive: true, force: true });
    }
  },
  45000,
);
