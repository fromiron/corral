import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScheduleDraft } from '@corral/contracts';
import type { AutoStartResult, WorkSession } from '@corral/core';
import { openDatabase } from '@corral/storage-sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScheduleService } from '../src/schedules/service.ts';
import { ScheduleStore } from '../src/schedules/store.ts';
import { nextScheduleTime } from '../src/schedules/time.ts';
import { scheduleVaultAdapter } from '../src/schedules/vault.ts';

const roots: string[] = [];
const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const draft: ScheduleDraft = {
  title: 'Daily review',
  hostId: 'local',
  projectId: 'default',
  sessionId: 'session_test',
  timezone: 'Asia/Tokyo',
  rule: { kind: 'daily', time: '09:00' },
  enabled: true,
  request: {
    brief: 'Review the current changes.',
    choice: { modelProfile: 'simulated' },
    mode: 'mock',
    permissionMode: 'ask',
    configRevision: 1,
  },
};
const started = (commandId: string): AutoStartResult => ({
  runId: `run_${commandId}`,
  autoRoute: null,
  receipt: {
    commandId,
    runId: `run_${commandId}`,
    status: 'accepted',
    acceptedSeq: 1,
    target: `run:run_${commandId}`,
    requestedBoundary: 'immediate',
    relatedEventIds: [],
  },
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'corral-schedule-'));
  roots.push(root);
  const dbPath = join(root, 'test.sqlite');
  const db = openDatabase(dbPath);
  closers.push(() => {
    if (db.open) db.close();
  });
  let now = '2026-10-19T23:59:00.000Z';
  let ids = 0;
  const results = new Map<string, AutoStartResult>();
  const active = new Set<string>();
  const session = {
    sessionId: 'session_test',
    projectId: 'default',
    corralId: null,
    archivedAt: null,
  } as WorkSession;
  const addSessionEntry = vi.fn(async () => ({ ok: true as const, session }));
  const getSession = vi.fn(async () => session);
  const start = vi.fn(async (request: { commandId: string }) => {
    const result = started(request.commandId);
    results.set(request.commandId, result);
    if (result.runId) active.add(result.runId);
    return result;
  });
  const deps = {
    now: () => now,
    id: () => `schedule_${++ids}`,
    repository: { getSession, addSessionEntry },
    start,
    previous: (id: string) => results.get(id) ?? null,
    isRunActive: (id: string) => active.has(id),
  };
  const store = new ScheduleStore(db);
  const service = new ScheduleService(store, deps);
  return {
    db,
    dbPath,
    store,
    service,
    deps,
    start,
    addSessionEntry,
    getSession,
    active,
    results,
    setNow: (value: string) => {
      now = value;
    },
  };
}

describe('[TC-ABS-008-H] [TC-ABS-008-N] schedules', () => {
  it('claims one due occurrence across duplicate pollers and saves the normal session entry', async () => {
    const f = setup();
    const schedule = await f.service.create(draft);
    f.setNow('2026-10-20T00:00:00.000Z');
    const other = new ScheduleService(new ScheduleStore(f.db), f.deps);
    await Promise.all([f.service.tick(), other.tick(), f.service.tick()]);
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(f.start).toHaveBeenCalledWith(
      expect.objectContaining({
        brief: draft.request.brief,
        permissionMode: 'ask',
        sessionId: 'session_test',
      }),
      expect.any(AbortSignal),
    );
    expect(f.store.occurrences(schedule.id)).toMatchObject([{ status: 'started' }]);
    expect(f.addSessionEntry).toHaveBeenCalledWith(
      'session_test',
      expect.objectContaining({ state: 'started' }),
    );
  });
  it('records missed startup intervals and overlaps without catch-up or duplicate manual requests', async () => {
    const f = setup();
    const schedule = await f.service.create(draft);
    f.setNow('2026-10-23T01:00:00.000Z');
    await f.service.recover();
    expect(f.store.occurrences(schedule.id)).toMatchObject([{ status: 'missed' }]);
    expect(f.start).not.toHaveBeenCalled();
    await f.service.runNow(schedule.id, 1, 'manual_one');
    await f.service.runNow(schedule.id, 1, 'manual_one');
    await f.service.runNow(schedule.id, 1, 'manual_two');
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(f.store.occurrences(schedule.id)[0]?.status).toBe('overlap');
    f.setNow('2026-10-24T00:00:00.000Z');
    await f.service.tick();
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(f.store.occurrences(schedule.id)[0]?.status).toBe('overlap');
  });
  it('disabling during target lookup prevents a late start', async () => {
    const f = setup();
    const schedule = await f.service.create(draft);
    const session = await f.getSession();
    let release = () => {};
    f.getSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(session);
        }),
    );
    f.setNow('2026-10-20T00:00:00.000Z');
    const ticking = f.service.tick();
    await f.service.update(schedule.id, { ...draft, enabled: false }, 1);
    release();
    await ticking;
    expect(f.start).not.toHaveBeenCalled();
    expect(f.store.occurrences(schedule.id)[0]?.status).toBe('interrupted');
  });
  it('reconciles a recorded command after restart using its original request snapshot', async () => {
    const f = setup();
    const schedule = await f.service.create(draft);
    const occurrence = f.store.claim(schedule, '2026-10-20T00:00:00.000Z', f.deps.now());
    expect(occurrence).not.toBeNull();
    if (!occurrence) return;
    f.results.set(occurrence.commandId, started(occurrence.commandId));
    await f.service.update(
      schedule.id,
      { ...draft, request: { ...draft.request, brief: 'Changed prompt' } },
      1,
    );
    await new ScheduleService(f.store, f.deps).recover();
    expect(f.start).not.toHaveBeenCalled();
    expect(f.addSessionEntry).toHaveBeenCalledWith(
      'session_test',
      expect.objectContaining({ text: draft.request.brief }),
    );
    expect(f.store.occurrences(schedule.id)[0]?.status).toBe('started');
  });
  it('never replays a claim with no authoritative start receipt', async () => {
    const f = setup();
    const schedule = await f.service.create(draft);
    f.store.claim(schedule, '2026-10-20T00:00:00.000Z', f.deps.now());
    await new ScheduleService(f.store, f.deps).recover();
    expect(f.start).not.toHaveBeenCalled();
    expect(f.store.occurrences(schedule.id)[0]?.status).toBe('interrupted');
  });
  it('rejects stale updates and target changes and retains disabled state after reopening the DB', async () => {
    const f = setup();
    const schedule = await f.service.create({ ...draft, enabled: false });
    await f.service.update(schedule.id, { ...draft, enabled: false }, 1);
    await expect(f.service.update(schedule.id, draft, 1)).rejects.toThrow('Schedule changed');
    await expect(f.service.create({ ...draft, projectId: 'another' })).rejects.toThrow('existing');
    const reopened = openDatabase(f.db.name);
    try {
      expect(new ScheduleStore(reopened).get(schedule.id)?.enabled).toBe(false);
    } finally {
      reopened.close();
    }
  });
  it('skips nonexistent DST time and uses the first repeated wall time only', () => {
    expect(
      nextScheduleTime(
        { kind: 'daily', time: '02:30' },
        'America/New_York',
        '2026-03-08T05:00:00.000Z',
      ),
    ).toBe('2026-03-09T06:30:00.000Z');
    expect(
      nextScheduleTime(
        { kind: 'daily', time: '01:30' },
        'America/New_York',
        '2026-11-01T04:00:00.000Z',
      ),
    ).toBe('2026-11-01T05:30:00.000Z');
    expect(
      nextScheduleTime(
        { kind: 'daily', time: '01:30' },
        'America/New_York',
        '2026-11-01T05:30:00.000Z',
      ),
    ).toBe('2026-11-02T06:30:00.000Z');
    expect(
      nextScheduleTime(
        { kind: 'weekly', time: '09:00', weekdays: [1] },
        'Asia/Kathmandu',
        '2026-10-20T00:00:00.000Z',
      ),
    ).toBe('2026-10-26T03:15:00.000Z');
  });
  it('[TC-ABS-013-N] vault import needs explicit bindings, stays disabled and guards duplicate operations and rollback', async () => {
    const f = setup();
    const schedule = await f.service.create(draft);
    const vault = scheduleVaultAdapter(f.service);
    const original = await vault.capture();
    await expect(vault.preview(original.value, {})).rejects.toThrow('explicit local');
    const preview = await vault.preview(original.value, {
      [`${schedule.id}:projectId`]: 'default',
      [`${schedule.id}:sessionId`]: 'session_test',
    });
    const first = await vault.apply(preview.value, original.revision, 'vault_one');
    expect(f.store.get(schedule.id)).toMatchObject({ enabled: false, revision: 2 });
    expect(await vault.apply(preview.value, original.revision, 'vault_one')).toEqual(first);
    expect(f.store.get(schedule.id)?.revision).toBe(2);
    await expect(vault.apply(preview.value, original.revision, 'vault_two')).rejects.toThrow(
      'changed since',
    );
    await vault.restore(original, first.revision, 'restore_one');
    expect(f.store.get(schedule.id)).toMatchObject({ enabled: true, revision: 3 });
    expect(f.start).not.toHaveBeenCalled();
  });
  it('[TC-ABS-013-H] fresh owner recovers committed import and rollback receipts before the vault journal was updated', async () => {
    const f = setup();
    const schedule = await f.service.create(draft);
    const adapter = scheduleVaultAdapter(f.service);
    const before = await adapter.capture();
    const preview = await adapter.preview(before.value, {
      [`${schedule.id}:projectId`]: 'default',
      [`${schedule.id}:sessionId`]: 'session_test',
    });
    // Commit the domain, then lose the process before any vault journal acknowledgement.
    const applied = await adapter.apply(preview.value, before.revision, 'gap_apply');
    f.db.close();
    const reopened = openDatabase(f.dbPath);
    closers.push(() => {
      if (reopened.open) reopened.close();
    });
    const fresh = scheduleVaultAdapter(new ScheduleService(new ScheduleStore(reopened), f.deps));
    expect(await fresh.receipt?.('gap_apply')).toEqual(applied);
    expect(await fresh.receipt?.('not_committed')).toBeNull();
    const receipt = await fresh.receipt?.('gap_apply');
    if (!receipt) throw new Error('Committed owner receipt is required for recovery.');
    const restored = await fresh.restore(before, receipt.revision, 'gap_restore');
    reopened.close();
    const afterRollback = openDatabase(f.dbPath);
    closers.push(() => afterRollback.close());
    const final = scheduleVaultAdapter(
      new ScheduleService(new ScheduleStore(afterRollback), f.deps),
    );
    expect(await final.receipt?.('gap_restore')).toEqual(restored);
    expect(await final.restore(before, receipt.revision, 'gap_restore')).toEqual(restored);
    expect(new ScheduleStore(afterRollback).get(schedule.id)).toMatchObject({
      enabled: true,
      revision: 3,
    });
    expect(f.start).not.toHaveBeenCalled();
  });
});
