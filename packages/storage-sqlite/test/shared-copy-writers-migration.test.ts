import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { MIGRATIONS, migrate } from '../src/index.ts';

// A local host shares the Paddock (workbench.md 공유 개발 모드): several owners hold one copy as
// writers, and a database written before that takes them after its next start. The index still
// lists the held writers.
function holdsTwoWriters(db: Database.Database) {
  const hold = db.prepare(`INSERT INTO workspace_access
    (owner_kind,owner_id,session_id,worktree_key,copy_generation,writer,state,tree)
    VALUES(?,?,'session','/copy',1,1,'active',NULL)`);
  hold.run('run', 'writer');
  hold.run('user', 'task');
  expect(
    db
      .prepare(
        "SELECT owner_id FROM workspace_access INDEXED BY workspace_access_writer WHERE worktree_key='/copy' AND writer=1 AND state IN ('active','uncertain') ORDER BY owner_id",
      )
      .all(),
  ).toEqual([{ owner_id: 'task' }, { owner_id: 'writer' }]);
}

it('several owners hold one copy as writers', () => {
  const db = new Database(':memory:');
  try {
    migrate(db);
    holdsTwoWriters(db);
  } finally {
    db.close();
  }
});

it('a database that held a copy in the removed development mode comes up with the copy free', () => {
  const db = new Database(':memory:');
  try {
    // A local database that already ran the shared-copy index step.
    const before =
      MIGRATIONS.findIndex((migration) => migration.name === '0045_shared_copy_writers') + 1;
    expect(before).toBeGreaterThan(0);
    for (const migration of MIGRATIONS.slice(0, before)) {
      db.exec(migration.sql);
      migration.data?.(db);
    }
    db.pragma(`user_version = ${before}`);
    const operation = db.prepare(`INSERT INTO workbench_operations
      (operation_id,request_hash,target_json,kind,state,result_json,created_at,updated_at)
      VALUES(?,'h','{}',?,?,NULL,'x','x')`);
    const access = db.prepare(`INSERT INTO workspace_access
      (owner_kind,owner_id,session_id,worktree_key,copy_generation,writer,state,tree)
      VALUES('user',?,'session','/copy',1,1,?,NULL)`);
    operation.run('development_running', 'development', 'running');
    access.run('development_running', 'active');
    operation.run('development_uncertain', 'development', 'uncertain');
    access.run('development_uncertain', 'uncertain');
    operation.run('task', 'task', 'running');
    access.run('task', 'active');
    migrate(db);
    expect(db.prepare("SELECT 1 FROM workbench_operations WHERE kind='development'").all()).toEqual(
      [],
    );
    expect(db.prepare('SELECT owner_id FROM workspace_access').all()).toEqual([
      { owner_id: 'task' },
    ]);
  } finally {
    db.close();
  }
});

it('a database written before shared copies takes several writers after its next start', () => {
  const db = new Database(':memory:');
  try {
    const before = MIGRATIONS.findIndex(
      (migration) => migration.name === '0045_shared_copy_writers',
    );
    for (const migration of MIGRATIONS.slice(0, before)) {
      db.exec(migration.sql);
      migration.data?.(db);
    }
    db.pragma(`user_version = ${before}`);
    migrate(db);
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    holdsTwoWriters(db);
  } finally {
    db.close();
  }
});
