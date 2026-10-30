import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linuxBootId, linuxProcessIdentity } from '@corral/adapter-pi/processes';
import type { TerminalCreate } from '@corral/contracts';
import { openDatabase } from '@corral/storage-sqlite';
import { FakeClock, Gate } from '@corral/testkit';
import { expect, it } from 'vitest';
import { WorkbenchOperations } from '../src/files/workbench-operations.ts';
import { WorkspaceAccessStore } from '../src/files/workspace-access.ts';
import { PtyRuntime } from '../src/processes/pty.ts';
import {
  cleanupPtyLaunch,
  PtyIdentityError,
  type PtyLaunchEvidence,
  waitForPtySession,
} from '../src/processes/pty-session.ts';

it.skipIf(process.platform !== 'linux')(
  'a real spawned PTY with interrupted identity capture recovers from persisted proof after an app restart',
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'corral-pty-startup-'));
    const db = openDatabase(':memory:');
    const operations = new WorkbenchOperations(db, new FakeClock());
    const access = new WorkspaceAccessStore(db);
    const request: TerminalCreate = {
      operationId: 'terminal_startup_recovery',
      target: {
        hostId: 'fixture-host',
        projectId: 'default',
        bindingId: 'binding',
        sessionId: 'session',
        copyGeneration: 1,
      },
      shellId: 'bash',
      cols: 80,
      rows: 24,
    };
    let allowCleanup = false;
    const options = {
      operations,
      target: () => ({ target: request.target, path: directory, writable: true }),
      prepare: async () => directory,
      shells: async () => [{ id: 'bash' as const, label: 'Bash', executable: '/bin/bash' }],
    };
    const original = new PtyRuntime({
      ...options,
      capture: () => {
        throw new PtyIdentityError('identity_unavailable');
      },
      cleanupLaunch: async (evidence) => allowCleanup && cleanupPtyLaunch(evidence),
    });
    let restarted: PtyRuntime | undefined;
    let generation = '';
    try {
      const created = await original.create('session', request);
      generation = created.generation;
      const uncertain = new Gate();
      const subscription = original.subscribe(
        'session',
        created.terminalId,
        { generation, afterSeq: 0 },
        (event) => {
          if (event.type === 'status' && event.terminal.state === 'uncertain') uncertain.open();
        },
      );
      await uncertain.wait();
      subscription.close();
      const stored = operations.get(created.terminalId)?.result as { launch: PtyLaunchEvidence };
      expect(stored.launch.bootId).toBe(linuxBootId());
      expect(stored.launch.pid).toBeGreaterThan(0);
      expect(stored.launch.owner).toBe(generation);
      const live = await waitForPtySession(stored.launch);
      expect(live.sessionId).toBe(live.pid);
      expect(access.ownersAt(directory)).toHaveLength(1);
      operations.recover();
      restarted = new PtyRuntime(options);
      const stopped = await restarted.stop('session', created.terminalId, {
        target: request.target,
        generation,
      });
      expect(stopped.state).toBe('exited');
      expect(access.ownersAt(directory)).toHaveLength(0);
      expect(operations.get(created.terminalId)).toMatchObject({
        state: 'cancelled',
        result: { startupDiagnostic: { phase: 'startup', code: 'identity_unavailable' } },
      });
      const current = linuxProcessIdentity(live.pid);
      expect(
        !current || current.startTicks !== live.startTicks || ['Z', 'X'].includes(current.state),
      ).toBe(true);
    } finally {
      allowCleanup = true;
      if (generation) {
        const identity = { target: request.target, generation };
        await original.stop('session', request.operationId, identity);
        await restarted?.stop('session', request.operationId, identity);
      }
      await original.close();
      await restarted?.close();
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
  30_000,
);
