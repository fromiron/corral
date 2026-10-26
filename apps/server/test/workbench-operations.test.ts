import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '@corral/storage-sqlite';
import { FakeClock } from '@corral/testkit';
import { afterEach, expect, it } from 'vitest';
import { WorkbenchOperations } from '../src/files/workbench-operations.ts';
import { WorkspaceAccessStore } from '../src/files/workspace-access.ts';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
});
function setup() {
  const path = mkdtempSync(join(tmpdir(), 'corral-user-operation-'));
  const db = openDatabase(':memory:');
  cleanup.push(() => {
    db.close();
    rmSync(path, { recursive: true, force: true });
  });
  const access = new WorkspaceAccessStore(db);
  const operations = new WorkbenchOperations(db, new FakeClock());
  const request = {
    operationId: 'save-1',
    requestHash: 'full-request-hash',
    kind: 'file_save',
    target: {
      hostId: 'host-1',
      projectId: 'default',
      bindingId: 'binding-1',
      sessionId: 'session-1',
      copyGeneration: 1,
    },
  };
  return { path, db, access, operations, request };
}

it('returns the original receipt and admits only one user writer', () => {
  const s = setup();
  const first = s.operations.admit(s.request, s.path);
  expect(first.admitted).toBe(true);
  expect(first.receipt.state).toBe('running');
  expect(s.operations.hasPending()).toBe(true);
  expect(s.operations.admit(s.request, s.path)).toEqual({
    admitted: false,
    receipt: first.receipt,
  });
  expect(() =>
    s.access.acquire({ kind: 'run', id: 'run-1' }, 'session-1', s.path, true, 1),
  ).toThrow(/writer/);
  const finished = s.operations.finish('save-1', 'succeeded', {
    hash: 'saved-hash',
    editVersion: 2,
  });
  expect(finished.state).toBe('succeeded');
  expect(s.operations.hasPending()).toBe(false);
  expect(s.operations.admit(s.request, s.path)).toEqual({ admitted: false, receipt: finished });
  expect(() =>
    s.access.acquire({ kind: 'run', id: 'run-1' }, 'session-1', s.path, true, 1),
  ).not.toThrow();
});

it('rejects changed request identity and releases failed or cancelled effects only once', () => {
  const s = setup();
  s.operations.admit(s.request, s.path);
  for (const patch of [
    { requestHash: 'other' },
    { kind: 'file_delete' },
    { target: { ...s.request.target, copyGeneration: 2 } },
  ])
    expect(() => s.operations.admit({ ...s.request, ...patch }, s.path)).toThrow(/changed/);
  const failed = s.operations.finish('save-1', 'failed', { code: 'REVISION_CONFLICT' });
  expect(s.operations.finish('save-1', 'succeeded', { hash: 'late' })).toEqual(failed);
  s.operations.admit({ ...s.request, operationId: 'save-2' }, s.path);
  expect(s.operations.finish('save-2', 'cancelled', null).state).toBe('cancelled');
  expect(s.access.ownersAt(s.path)).toHaveLength(0);
});

it('admission and completion failures leave reservation and receipt atomic', () => {
  const s = setup();
  s.db.exec(
    "CREATE TRIGGER fail_admission BEFORE INSERT ON workbench_operations BEGIN SELECT RAISE(ABORT, 'receipt disk failure'); END",
  );
  expect(() => s.operations.admit(s.request, s.path)).toThrow('receipt disk failure');
  expect(s.access.ownersAt(s.path)).toHaveLength(0);
  expect(s.operations.get('save-1')).toBeUndefined();
  s.db.exec('DROP TRIGGER fail_admission');
  s.operations.admit(s.request, s.path);
  s.db.exec(
    "CREATE TRIGGER fail_completion BEFORE UPDATE ON workbench_operations BEGIN SELECT RAISE(ABORT, 'receipt disk failure'); END",
  );
  expect(() => s.operations.finish('save-1', 'succeeded', { hash: 'saved' })).toThrow(
    'receipt disk failure',
  );
  expect(s.operations.get('save-1')?.state).toBe('running');
  expect(s.access.get({ kind: 'user', id: 'save-1' })?.state).toBe('active');
  s.db.exec('DROP TRIGGER fail_completion');
  s.operations.recover();
  expect(s.operations.get('save-1')?.state).toBe('uncertain');
  expect(s.operations.finish('save-1', 'succeeded', { hash: 'late' })?.state).toBe('uncertain');
  expect(s.access.get({ kind: 'user', id: 'save-1' })?.state).toBe('uncertain');
  expect(s.operations.hasPending()).toBe(true);
});

it('passive language ownership preserves saves and shared-mode exit but retains uncertain cleanup', () => {
  const s = setup();
  s.operations.admit({ ...s.request, operationId: 'language-1', kind: 'language' }, s.path);
  expect(s.access.get({ kind: 'user', id: 'language-1' })?.writer).toBe(0);
  s.operations.admit(s.request, s.path);
  s.operations.finish(s.request.operationId, 'succeeded', null);
  s.operations.admit({ ...s.request, operationId: 'development-1', kind: 'development' }, s.path);
  s.operations.finishDevelopment('development-1', s.request.target, s.path);
  expect(s.operations.get('development-1')?.state).toBe('succeeded');
  s.operations.admit({ ...s.request, operationId: 'development-2', kind: 'development' }, s.path);
  s.access.release({ kind: 'user', id: 'language-1' }, false);
  expect(() => s.operations.finishDevelopment('development-2', s.request.target, s.path)).toThrow(
    /pending effects/,
  );
});
