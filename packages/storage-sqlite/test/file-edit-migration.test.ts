import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { MIGRATIONS, migrate } from '../src/index.ts';

it('[TC-WBD-021-H] adds human proposals without changing existing agent proposals', () => {
  const db = new Database(':memory:');
  try {
    for (const migration of MIGRATIONS.slice(0, 29)) {
      db.exec(migration.sql);
      migration.data?.(db);
    }
    db.pragma('user_version = 29');
    db.exec(`INSERT INTO lsp_proposals
      VALUES ('legacy', 'session_one', '{}', '{}', 'hash', 'pending', '[]', 'before', 'before')`);
    const before = db.prepare('SELECT * FROM lsp_proposals').all();

    migrate(db);

    expect(db.prepare('SELECT * FROM lsp_proposals').all()).toEqual(before);
    expect(db.prepare('SELECT * FROM file_edit_proposals').all()).toEqual([]);
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
  } finally {
    db.close();
  }
});
