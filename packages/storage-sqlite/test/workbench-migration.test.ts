import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { MIGRATIONS, openDatabase } from '../src/index.ts';

it('upgrades legacy copy ownership without losing uncertain reservations or its rollback backup', () => {
  const directory = mkdtempSync(join(tmpdir(), 'corral-workbench-migration-'));
  const file = join(directory, 'workspace.db');
  const backup = join(directory, 'before-upgrade.db');
  const legacy = new Database(file);
  let upgraded: Database.Database | undefined;
  let restored: Database.Database | undefined;
  try {
    for (const migration of MIGRATIONS.slice(0, 28)) {
      legacy.exec(migration.sql);
      migration.data?.(legacy);
    }
    legacy.pragma('user_version = 28');
    legacy.exec(`
      INSERT INTO work_sessions
        (id, project_id, corral_id, title, objective, pinned, revision, created_at, updated_at, entries_json)
        VALUES ('session_one', 'default', NULL, 'Example', '', 0, 1, 'x', 'x', '[]');
      INSERT INTO workspace_bindings
        (id, project_id, root_path, is_git, trusted, verify_json, created_at, updated_at)
        VALUES ('binding_one', 'default', '/example/original', 1, 1, '[]', 'x', 'x');
      INSERT INTO session_worktrees
        (session_id, binding_id, worktree_path, base_commit, base_tree, created_at)
        VALUES ('session_one', 'binding_one', '/example/copy', 'commit', 'base', 'x');
      INSERT INTO run_access (run_id, session_id, worktree_key, writer, state, tree) VALUES
        ('run_active', 'session_one', '/example/copy', 1, 'active', 'active_tree'),
        ('run_reader', 'session_one', '/example/copy', 0, 'active', 'reader_tree'),
        ('run_released', 'session_one', '/example/copy', 1, 'released', 'finished_tree'),
        ('run_uncertain', 'session_gone', '/example/gone', 1, 'uncertain', 'uncertain_tree');
    `);
    const before = legacy.prepare('SELECT * FROM run_access ORDER BY run_id').all();
    legacy.close();
    copyFileSync(file, backup);

    const db = openDatabase(file);
    upgraded = db;
    expect(upgraded.prepare('SELECT copy_generation FROM session_worktrees').get()).toEqual({
      copy_generation: 1,
    });
    expect(
      upgraded
        .prepare(`SELECT owner_id AS run_id, session_id, worktree_key, writer, state, tree
          FROM workspace_access WHERE owner_kind='run' ORDER BY owner_id`)
        .all(),
    ).toEqual(before);
    expect(upgraded.prepare('SELECT DISTINCT copy_generation FROM workspace_access').all()).toEqual(
      [{ copy_generation: 1 }],
    );
    expect(() =>
      db
        .prepare(`INSERT INTO workspace_access
        (owner_kind, owner_id, session_id, worktree_key, copy_generation, writer, state, tree)
        VALUES ('user', 'human_new', 'session_gone', '/example/gone', 2, 1, 'active', NULL)`)
        .run(),
    ).toThrow(/UNIQUE/);
    expect(upgraded.prepare('SELECT COUNT(*) AS count FROM workbench_operations').get()).toEqual({
      count: 0,
    });

    restored = new Database(backup, { readonly: true });
    expect(restored.pragma('user_version', { simple: true })).toBe(28);
    expect(restored.prepare('SELECT * FROM run_access ORDER BY run_id').all()).toEqual(before);
    expect(
      restored.prepare("SELECT name FROM sqlite_master WHERE name='workspace_access'").get(),
    ).toBeUndefined();
  } finally {
    if (legacy.open) legacy.close();
    upgraded?.close();
    restored?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
