import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { MIGRATIONS, migrate } from '../src/index.ts';

it('rebuilds only the derived search cache while retaining sessions and original text', () => {
  const db = new Database(':memory:');
  try {
    for (const migration of MIGRATIONS.slice(0, 35)) {
      db.exec(migration.sql);
      migration.data?.(db);
    }
    db.pragma('user_version = 35');
    db.prepare(
      "INSERT INTO work_sessions (id,project_id,corral_id,title,objective,pinned,revision,created_at,updated_at,archived_at,entries_json) VALUES ('session_search','default',NULL,'Original CASE','',0,1,'x','x',NULL,?)",
    ).run(JSON.stringify([{ entryId: 'entry_one', text: 'Private Original CASE' }]));
    db.exec(
      "INSERT INTO session_search_v1 VALUES ('entry:session_search:entry_one','session_search',NULL,'entry_one',NULL,NULL,'entry','private original case'); INSERT INTO session_search_state_v1 VALUES ('entries:session_search','1');",
    );
    const before = db.prepare('SELECT * FROM work_sessions').all();
    migrate(db);
    expect(db.prepare('SELECT * FROM work_sessions').all()).toEqual(before);
    expect(db.prepare('SELECT * FROM session_search_v1').all()).toEqual([]);
    expect(db.prepare('SELECT * FROM session_search_state_v1').all()).toEqual([]);
    expect(db.prepare('SELECT source_text, source_hash FROM session_search_v1').all()).toEqual([]);
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
  } finally {
    db.close();
  }
});
