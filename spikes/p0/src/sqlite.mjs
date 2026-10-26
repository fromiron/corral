// SQLite spike: driver load, pragmas, atomic rollback, busy timeout across connections.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const dir = mkdtempSync(join(tmpdir(), 'corral-sqlite-'));
const file = join(dir, 'corral.db');
const result = { node: process.version, platform: `${process.platform}-${process.arch}` };
try {
  const a = new Database(file);
  result.sqliteVersion = a.prepare('select sqlite_version() as v').get().v;
  result.journalMode = a.pragma('journal_mode = WAL', { simple: true });
  a.pragma('foreign_keys = ON');
  a.pragma('synchronous = FULL');
  a.pragma('busy_timeout = 250');
  result.foreignKeys = a.pragma('foreign_keys', { simple: true });
  a.exec(`create table runs(id text primary key);
          create table events(run_id text not null references runs(id), seq integer not null, unique(run_id, seq));`);
  a.prepare('insert into runs values (?)').run('run_1');

  // Event + projection must commit together: a failing statement rolls back the whole batch.
  const commit = a.transaction((rows) => {
    for (const [run, seq] of rows) a.prepare('insert into events values (?, ?)').run(run, seq);
  });
  try {
    commit([['run_1', 1], ['run_1', 1]]);
  } catch (e) {
    result.duplicateSeqError = e.code;
  }
  result.eventsAfterRollback = a.prepare('select count(*) n from events').get().n;
  try {
    a.prepare('insert into events values (?, ?)').run('missing_run', 1);
  } catch (e) {
    result.foreignKeyError = e.code;
  }

  // A second connection waits up to busy_timeout for a writer, then reports SQLITE_BUSY.
  const b = new Database(file);
  b.pragma('busy_timeout = 250');
  a.exec('begin immediate');
  const started = Date.now();
  try {
    b.prepare('insert into runs values (?)').run('run_2');
  } catch (e) {
    result.secondWriterError = e.code;
    result.secondWriterWaitedMs = Date.now() - started;
  }
  a.exec('rollback');
  b.close();
  a.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}

try {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  result.nodeSqliteAvailable = db.prepare('select sqlite_version() as v').get().v;
} catch (e) {
  result.nodeSqliteAvailable = `unavailable: ${e.message}`;
}
console.log(JSON.stringify(result, null, 2));
