import { FakeClock } from '@corral/testkit';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { MIGRATIONS, migrate, SqliteCorralRepository } from '../src/index.ts';

it('reads a session saved before the advisor setting as having it off', async () => {
  const db = new Database(':memory:');
  try {
    const before = MIGRATIONS.findIndex((migration) => migration.name === '0044_session_advisor');
    for (const migration of MIGRATIONS.slice(0, before)) {
      db.exec(migration.sql);
      migration.data?.(db);
    }
    db.pragma(`user_version = ${before}`);
    db.prepare(
      "INSERT INTO work_sessions (id,project_id,corral_id,title,objective,pinned,revision,created_at,updated_at,archived_at,entries_json) VALUES ('session_older','default',NULL,'Older','',0,1,'x','x',NULL,'[]')",
    ).run();
    migrate(db);
    const repo = new SqliteCorralRepository(db, {
      clock: new FakeClock(),
      newCorralId: () => 'corral_x',
    });
    expect((await repo.getSession('session_older'))?.advisor).toBeNull();
    // Running the step again changes nothing; the column holds an object or nothing.
    MIGRATIONS[before]?.data?.(db);
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    expect(() =>
      db
        .prepare("UPDATE work_sessions SET advisor_json = '\"model-b\"' WHERE id = 'session_older'")
        .run(),
    ).toThrow();
  } finally {
    db.close();
  }
});
