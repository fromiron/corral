import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Coordinator,
  createAutoStarter,
  InProcessTransport,
  waitForProjection,
} from '@corral/core';
import { FakeClock, ScriptedAgentAdapter, SequentialIdFactory } from '@corral/testkit';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, openDatabase, SqliteRunStore } from '../src/index.ts';

const dirs: string[] = [];
function path() {
  const dir = mkdtempSync(join(tmpdir(), 'corral-auto-identity-'));
  dirs.push(dir);
  return join(dir, 'workspace.db');
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('durable auto command identity', () => {
  it('adds the optional identity without rewriting legacy commands', () => {
    const file = path();
    const legacy = new Database(file);
    const before = MIGRATIONS.findIndex(
      (migration) => migration.name === '0014_auto_command_identity',
    );
    for (const migration of MIGRATIONS.slice(0, before)) {
      legacy.exec(migration.sql);
      migration.data?.(legacy);
    }
    legacy.pragma(`user_version = ${before}`);
    const receipt = {
      commandId: 'cmd_legacy',
      status: 'rejected',
      error: { code: 'TARGET_NOT_FOUND' },
    };
    legacy
      .prepare(
        'INSERT INTO commands (scope, command_id, payload_hash, receipt_json) VALUES (?, ?, ?, ?)',
      )
      .run('*', 'cmd_legacy', 'legacy_hash', JSON.stringify(receipt));
    legacy.close();
    const migrated = openDatabase(file);
    expect(new SqliteRunStore(migrated).getCommand('*', 'cmd_legacy')).toMatchObject({
      commandId: 'cmd_legacy',
      payloadHash: 'legacy_hash',
      receipt,
    });
    expect(
      new SqliteRunStore(migrated).getCommand('*', 'cmd_legacy')?.originalRequestHash,
    ).toBeUndefined();
    migrated.close();
  });

  it('preserves successful and refused request fingerprints across a backend restart', async () => {
    const file = path();
    let calls = 0;
    const open = () => {
      const db = openDatabase(file);
      const coordinator = new Coordinator({
        clock: new FakeClock(),
        ids: new SequentialIdFactory(),
        store: new SqliteRunStore(db),
        agents: new ScriptedAgentAdapter({ turns: 1 }),
      });
      const starter = createAutoStarter({
        startRun: (request) => coordinator.startRun(request),
        previousStart: (commandId, requestHash) => {
          const result = coordinator.startResult(commandId, requestHash);
          return result
            ? {
                ...result,
                autoRoute: result.runId
                  ? (coordinator.getRunSnapshot(result.runId)?.autoRoute ?? null)
                  : null,
              }
            : null;
        },
        route: async () => {
          calls++;
          return {
            ok: true,
            text: '{"template":"single","reason":"Short."}',
            usage: { inputTokens: 10, outputTokens: 20 },
          };
        },
      });
      return { db, coordinator, starter };
    };
    const request = {
      commandId: 'cmd_success',
      brief: 'A short request',
      mode: 'mock' as const,
      choice: { modelProfile: 'model-a' },
    };
    const refused = {
      ...request,
      commandId: 'cmd_refused',
      references: [{ kind: 'run' as const, runId: 'run_missing' }],
    };
    const first = open();
    const success = await first.starter.start(request, { fileTools: false });
    await waitForProjection(
      new InProcessTransport(first.coordinator),
      success.runId ?? '',
      (p) => p.status === 'succeeded',
    );
    const failure = await first.starter.start(refused, { fileTools: false });
    expect(failure.receipt.error?.code).toBe('TARGET_NOT_FOUND');
    const budget = first.coordinator.getSnapshot(success.runId ?? '').projection.budget;
    expect(budget.modelCalls).toBe(2);
    first.db.close();

    const restarted = open();
    expect(await restarted.starter.start(request, { fileTools: true })).toEqual(success);
    expect(await restarted.starter.start(refused, { fileTools: false })).toEqual(failure);
    for (const original of [request, refused]) {
      const changed = await restarted.starter.start(
        { ...original, brief: 'A different request' },
        { fileTools: false },
      );
      expect(changed.receipt.error?.code).toBe('IDEMPOTENCY_CONFLICT');
      expect(changed.runId).toBeNull();
    }
    expect(calls).toBe(2);
    expect(restarted.coordinator.getSnapshot(success.runId ?? '').projection.budget).toEqual(
      budget,
    );
    restarted.db.close();
  });
});
