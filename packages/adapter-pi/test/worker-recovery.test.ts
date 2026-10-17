import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { processChannel, recoverSdkWorkers } from '../src/index.ts';

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
