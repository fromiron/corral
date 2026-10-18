import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

// Model kernel PID reuse without changing the host PID allocator or signalling real processes.
const state = vi.hoisted(() => ({
  zombie: false,
  missing: false,
  start: '100',
  killed: false,
  pid: 43210,
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      const path = String(args[0]);
      if (path === `/proc/${state.pid}/stat` || path === `/proc/${state.pid + 1}/stat`) {
        const leader = path === `/proc/${state.pid}/stat`;
        if (leader && state.missing) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
        const fields = Array(20).fill('0');
        fields[0] = leader && state.zombie ? 'Z' : 'S';
        fields[2] = String(state.pid);
        fields[19] = leader ? state.start : '300';
        return `${leader ? state.pid : state.pid + 1} (fixture) ${fields.join(' ')}`;
      }
      return actual.readFileSync(...args);
    },
    readdirSync: (...args: Parameters<typeof actual.readdirSync>) =>
      String(args[0]) === '/proc'
        ? [String(state.pid), String(state.pid + 1)]
        : actual.readdirSync(...args),
  };
});

import { recordWorkerLease, recoverSdkWorkers } from '../src/worker-leases.ts';

it.skipIf(process.platform !== 'linux').each([false, true])(
  '[TC-HAR-017-N] keeps zombie leader identity when checking reused PID (reused=%s)',
  async (reused) => {
    Object.assign(state, { zombie: false, missing: false, start: '100', killed: false });
    const directory = mkdtempSync(join(tmpdir(), 'corral-pid-identity-'));
    const kill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (state.killed) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      if (signal === 'SIGKILL') state.killed = true;
      return true;
    });
    try {
      recordWorkerLease(directory, state.pid);
      state.zombie = true;
      if (reused) state.start = '200';
      await recoverSdkWorkers(directory);
      expect(state.killed).toBe(!reused);
    } finally {
      kill.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform !== 'linux')(
  '[TC-HAR-017-N] a leaderless group without ownership evidence is never killed by an old PID record',
  async () => {
    Object.assign(state, { zombie: false, missing: false, start: '100', killed: false });
    const directory = mkdtempSync(join(tmpdir(), 'corral-unproven-group-'));
    const kill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (state.killed) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      if (signal === 'SIGKILL') state.killed = true;
      return true;
    });
    try {
      recordWorkerLease(directory, state.pid);
      state.missing = true;
      await expect(recoverSdkWorkers(directory)).rejects.toThrow(/unconfirmed/);
      expect(state.killed).toBe(false);
    } finally {
      kill.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
