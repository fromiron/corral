import { fork } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { processChannel, recoverSdkWorkers, sdkProcessChannel } from '../src/index.ts';

it.skipIf(process.platform !== 'linux')(
  '[TC-HAR-016-N] killing an SDK owner reaps separately grouped MCP processes before reporting exit',
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'corral-sdk-mcp-'));
    const channel = sdkProcessChannel(join(import.meta.dirname, 'fixtures/mcp-owner.ts'), {
      leaseDirectory: directory,
    });
    const exited = new Promise<void>((resolve) => channel.onExit(() => resolve()));
    let pid: number | undefined;
    try {
      const info = await new Promise<{ pid: number }>((resolve) =>
        channel.onFrame((frame) => resolve(frame as { pid: number })),
      );
      pid = info.pid;
      expect(() => process.kill(pid!, 0)).not.toThrow();
      channel.kill();
      await exited;
      const state = () => {
        try {
          return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.[0];
        } catch {
          return null;
        }
      };
      expect([null, 'Z', 'X']).toContain(state());
      await recoverSdkWorkers(directory);
      expect(readdirSync(directory)).toEqual([]);
    } finally {
      channel.kill();
      if (pid)
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {}
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

import { recordWorkerLease } from '../src/worker-leases.ts';

it.skipIf(process.platform !== 'linux')(
  '[TC-HAR-016-N] recovers the server group after its recorded leader has already exited',
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'corral-mcp-recovery-'));
    const leader = fork(join(import.meta.dirname, 'fixtures/process-group.ts'), [], {
      detached: true,
      execArgv: [],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const info = await new Promise<{ port: number; pid: number }>((resolve) =>
      leader.once('message', resolve),
    );
    const pid = leader.pid!;
    try {
      recordWorkerLease(directory, pid);
      const exited = new Promise<void>((resolve) => leader.once('exit', () => resolve()));
      leader.send({ exit: true });
      await exited;
      expect(() => process.kill(info.pid, 0)).not.toThrow();
      await recoverSdkWorkers(directory);
      const state = () => {
        try {
          return readFileSync(`/proc/${info.pid}/stat`, 'utf8').split(') ')[1]?.[0];
        } catch {
          return null;
        }
      };
      expect([null, 'Z', 'X']).toContain(state());
      expect(readdirSync(directory)).toEqual([]);
    } finally {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {}
      leader.kill('SIGKILL');
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform !== 'linux')(
  '[TC-HAR-017-N] recovers an owned SDK process before new worker capacity is available',
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'corral-worker-recovery-'));
    const channel = processChannel(join(import.meta.dirname, 'fixtures/orphan-worker.ts'), {
      leaseDirectory: directory,
    });
    const exited = new Promise<void>((resolve) => channel.onExit(() => resolve()));
    try {
      await new Promise<void>((resolve) => channel.onFrame(() => resolve()));
      expect(readdirSync(directory).filter((n) => n.endsWith('.json'))).toHaveLength(1);
      await recoverSdkWorkers(directory);
      await exited;
      expect(readdirSync(directory)).toEqual([]);
    } finally {
      channel.kill();
      await exited;
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
it.skipIf(process.platform !== 'linux')(
  '[TC-HAR-017-N] a reused PID record never kills a different process',
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'corral-worker-recovery-'));
    const channel = processChannel(join(import.meta.dirname, 'fixtures/orphan-worker.ts'), {
      leaseDirectory: directory,
    });
    const exited = new Promise<void>((resolve) => channel.onExit(() => resolve()));
    let ended = false;
    channel.onExit(() => {
      ended = true;
    });
    try {
      await new Promise<void>((resolve) => channel.onFrame(() => resolve()));
      const path = join(directory, readdirSync(directory).find((n) => n.endsWith('.json'))!);
      const record = JSON.parse(readFileSync(path, 'utf8'));
      record.startTicks = '0';
      writeFileSync(path, JSON.stringify(record));
      await recoverSdkWorkers(directory);
      expect(ended).toBe(false);
      expect(() => process.kill(record.pid, 0)).not.toThrow();
    } finally {
      channel.kill();
      await exited;
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
