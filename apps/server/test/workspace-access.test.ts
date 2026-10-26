import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Db, openDatabase } from '@corral/storage-sqlite';
import { afterEach, expect, it } from 'vitest';
import { RunAccessStore } from '../src/files/run-access.ts';
import { WorkspaceAccessStore } from '../src/files/workspace-access.ts';

const databases: Db[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function setup() {
  const db = openDatabase(':memory:');
  databases.push(db);
  const path = mkdtempSync(join(tmpdir(), 'corral-workspace-access-'));
  directories.push(path);
  return { db, path };
}

it('run admission cannot reuse its identity for a different copy generation', () => {
  const { db, path } = setup();
  const runs = new RunAccessStore(db);
  runs.acquire('run_one', 'session_one', path, true, 1);
  expect(() => runs.acquire('run_one', 'session_one', path, true, 2)).toThrow(/changed/);
});

it('run and user owners share one writer while other copies and pinned readers remain available', () => {
  const { db, path } = setup();
  const other = setup().path;
  const access = new WorkspaceAccessStore(db);
  const runs = new RunAccessStore(db);
  const human = { kind: 'user', id: 'same_id' } as const;
  access.acquire(human, 'session_one', path, true, 1);
  access.pin(human, 'input_tree');
  expect(() => access.acquire(human, 'session_one', path, true, 1)).not.toThrow();
  expect(() => runs.acquire('same_id', 'session_one', path, true, 1)).toThrow(/writer/);
  runs.acquire('reader', 'session_one', path, false, 1);
  const owned = access.get(human);
  assert(owned);
  const writer = access.writerAt(owned.worktree_key);
  assert(writer?.tree);
  runs.pin('reader', writer.tree);
  expect(runs.get('reader')).toMatchObject({ writer: 0, tree: 'input_tree' });
  expect(() => access.pin(human, 'different_tree')).toThrow(/already pinned/);
  expect(access.ownersAt(owned.worktree_key)).toHaveLength(2);
  expect(() => runs.acquire('other', 'session_two', other, true, 1)).not.toThrow();

  access.release(human, true);
  runs.acquire('same_id', 'session_one', path, true, 1);
  expect(() => access.acquire({ kind: 'user', id: 'next' }, 'session_one', path, true, 1)).toThrow(
    /writer/,
  );
  expect(access.get(human)?.state).toBe('released');
  expect(runs.get('same_id')?.state).toBe('active');
});

it('recovery retains uncertain ownership against a new generation and late completion', () => {
  const { db, path } = setup();
  const access = new WorkspaceAccessStore(db);
  const human = { kind: 'user', id: 'human_one' } as const;
  const runs = new RunAccessStore(db);
  access.acquire(human, 'session_one', path, true, 1);
  access.pin(human, 'input_tree');
  runs.acquire('reader', 'session_one', path, false, 1);
  runs.pin('reader', 'input_tree');

  const recovered = new WorkspaceAccessStore(db);
  recovered.recover();
  access.release(human, true);
  runs.release('reader', true);
  expect(recovered.get(human)).toMatchObject({ state: 'uncertain', tree: 'input_tree' });
  expect(runs.get('reader')).toMatchObject({ state: 'uncertain', tree: 'input_tree' });
  expect(() =>
    recovered.acquire({ kind: 'user', id: 'new_generation' }, 'session_one', path, true, 2),
  ).toThrow(/writer/);
  expect(() => runs.acquire('new_reader', 'session_one', path, false, 1)).toThrow(/unconfirmed/);
  expect(() => recovered.pin(human, 'input_tree')).toThrow(/no longer active/);
});

it('admission and release join an enclosing receipt transaction', () => {
  const { db, path } = setup();
  const access = new WorkspaceAccessStore(db);
  const human = { kind: 'user', id: 'human_one' } as const;
  expect(() =>
    db
      .transaction(() => {
        access.acquire(human, 'session_one', path, true, 1);
        throw new Error('receipt failed');
      })
      .immediate(),
  ).toThrow('receipt failed');
  expect(access.get(human)).toBeUndefined();
  access.acquire(human, 'session_one', path, true, 1);
  expect(() =>
    db
      .transaction(() => {
        access.release(human, true);
        throw new Error('receipt failed');
      })
      .immediate(),
  ).toThrow('receipt failed');
  expect(access.get(human)?.state).toBe('active');
});

it.each(['before', 'after'] as const)(
  'a reader admitted %s writer pin retains its input after writer release',
  (timing) => {
    const { db, path } = setup();
    const access = new WorkspaceAccessStore(db);
    const writer = { kind: 'user', id: 'save' } as const;
    const reader = { kind: 'run', id: 'reader' } as const;
    access.acquire(writer, 'session_one', path, true, 1);
    if (timing === 'after') access.pin(writer, 'before_tree');
    access.acquire(reader, 'session_one', path, false, 1);
    if (timing === 'before') access.pin(writer, 'before_tree');
    access.release(writer, true);
    expect(access.get(reader)?.tree).toBe('before_tree');

    const next = { kind: 'user', id: 'next_save' } as const;
    access.acquire(next, 'session_one', path, true, 1);
    access.pin(next, 'after_tree');
    expect(access.get(reader)?.tree).toBe('before_tree');
  },
);
