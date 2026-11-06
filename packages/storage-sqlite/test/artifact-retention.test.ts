import { emptyProjection, type StoredRun } from '@corral/core';
import { linearCorral } from '@corral/testkit';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import ultraRuns from '../../core/test/fixtures/ultra-runs.json' with { type: 'json' };
import { MIGRATIONS, migrate, openDatabase, SqliteRunStore } from '../src/index.ts';

it('migrates existing immutable bodies and releases text and media atomically without resurrection', () => {
  const db = new Database(':memory:');
  try {
    for (const [index, migration] of MIGRATIONS.slice(
      0,
      MIGRATIONS.findIndex((m) => m.name === '0036_artifact_body_lifetime'),
    ).entries()) {
      db.exec(migration.sql);
      migration.data?.(db);
      db.pragma(`user_version = ${index + 1}`);
    }
    const old = new SqliteRunStore(db);
    const runId = 'run_retention';
    old.insertRun({
      runId,
      projection: emptyProjection(runId),
      snapshot: {
        definition: linearCorral(['writer']),
        definitionHash: 'a'.repeat(64),
        criteriaVersionId: 'crit_1',
        source: null,
        mode: 'mock',
        models: {},
        startedAt: '2026-11-06T00:00:00Z',
      },
    });
    old.putArtifactText(runId, 'artv_old', 'old');
    old.putArtifactText(runId, 'artv_final', 'final');
    db.prepare('INSERT INTO generated_media VALUES (?,?,?,?,?,?,?)').run(
      runId,
      'artv_old',
      'effect_1',
      '{}',
      '{}',
      Buffer.from([1, 2, 3]),
      '2026-11-06T00:00:00Z',
    );
    expect(() => db.prepare('DELETE FROM artifact_texts').run()).toThrow(/immutable/);
    migrate(db);
    const store = new SqliteRunStore(db);
    const addSearch = db.prepare(
      'INSERT INTO session_search_v1(id,session_id,run_id,entry_id,artifact_id,sequence,kind,normalized) VALUES (?,?,?,?,?,?,?,?)',
    );
    addSearch.run(
      'event:run_retention:1',
      'session_one',
      runId,
      null,
      'artv_old',
      1,
      'artifact',
      'retired private body',
    );
    addSearch.run(
      'conversation:run_retention',
      'session_one',
      runId,
      null,
      null,
      null,
      'response',
      'ordinary primary answer',
    );
    addSearch.run(
      'entry:session_one:entry_one',
      'session_one',
      runId,
      'entry_one',
      null,
      null,
      'entry',
      'ordinary request',
    );
    db.prepare('INSERT INTO session_search_state_v1 VALUES (?,?)').run(`run:${runId}`, '1');
    expect(store.getArtifactText(runId, 'artv_old')).toBe('old');
    expect(() =>
      store.transaction(() => {
        store.retainArtifactBodies(runId, ['artv_final']);
        throw new Error('rollback');
      }),
    ).toThrow('rollback');
    expect(store.getArtifactBinary(runId, 'artv_old')).toEqual(Buffer.from([1, 2, 3]));
    expect(
      db.prepare("SELECT id FROM session_search_v1 WHERE substr(id,1,6)='event:'").all(),
    ).toHaveLength(1);
    store.retainArtifactBodies(runId, ['artv_final']);
    expect(store.getArtifactText(runId, 'artv_old')).toBeNull();
    expect(
      db.prepare("SELECT id FROM session_search_v1 WHERE substr(id,1,6)='event:'").all(),
    ).toHaveLength(0);
    expect(db.prepare('SELECT id FROM session_search_v1').all()).toHaveLength(2);
    expect(
      db.prepare('SELECT cursor FROM session_search_state_v1 WHERE id=?').get(`run:${runId}`),
    ).toBeUndefined();
    expect(store.getArtifactBinary(runId, 'artv_old')).toBeNull();
    expect(store.getArtifactText(runId, 'artv_final')).toBe('final');
    expect(() => store.putArtifactText(runId, 'artv_old', 'late')).toThrow(/released/);
    expect(() =>
      db
        .prepare('INSERT INTO generated_media VALUES (?,?,?,?,?,?,?)')
        .run(runId, 'artv_old', 'effect_2', '{}', '{}', Buffer.from([4]), '2026-11-06T00:00:00Z'),
    ).toThrow(/released/);
    expect(() => db.prepare("UPDATE artifact_texts SET text_body='changed'").run()).toThrow(
      /immutable/,
    );
  } finally {
    db.close();
  }
});

it('hydrates additive metadata without replaying retired event types in old databases', () => {
  const db = openDatabase(':memory:');
  try {
    const store = new SqliteRunStore(db);
    for (const record of Object.values(ultraRuns)) {
      const runId = record.projection.runId;
      store.insertRun({
        runId,
        snapshot: record.snapshot,
        projection: record.projection,
      } as unknown as StoredRun);
      store.appendEvents(runId, record.events as unknown as import('@corral/contracts').RunEvent[]);
      expect(store.getRun(runId)?.projection.executionOrder).toEqual(
        record.projection.executionOrder,
      );
      expect(store.getRun(runId)?.projection.workflowBranches).toEqual({});
    }
  } finally {
    db.close();
  }
});

it('drops legacy copied event search bodies on migration while preserving ordinary conversation search', () => {
  const db = new Database(':memory:');
  try {
    const boundary = MIGRATIONS.findIndex((m) => m.name === '0037_artifact_search_lifetime');
    const previous = boundary < 0 ? MIGRATIONS : MIGRATIONS.slice(0, boundary);
    for (const [index, migration] of previous.entries()) {
      db.exec(migration.sql);
      migration.data?.(db);
      db.pragma(`user_version = ${index + 1}`);
    }
    const add = db.prepare(
      'INSERT INTO session_search_v1(id,session_id,run_id,entry_id,artifact_id,sequence,kind,normalized) VALUES (?,?,?,?,?,?,?,?)',
    );
    add.run(
      'event:run_one:1',
      'session_one',
      'run_one',
      null,
      'old_body',
      1,
      'artifact',
      'past private artifact body',
    );
    add.run(
      'entry:session_one:one',
      'session_one',
      'run_one',
      'one',
      null,
      null,
      'entry',
      'ordinary request',
    );
    db.prepare('INSERT INTO session_search_state_v1 VALUES (?,?)').run('run:run_one', '1');
    db.prepare('INSERT INTO session_search_state_v1 VALUES (?,?)').run('entries:session_one', '1');
    migrate(db);
    expect(
      db.prepare("SELECT id FROM session_search_v1 WHERE substr(id,1,6)='event:'").all(),
    ).toEqual([]);
    expect(db.prepare('SELECT id FROM session_search_v1').all()).toEqual([
      { id: 'entry:session_one:one' },
    ]);
    expect(db.prepare('SELECT id FROM session_search_state_v1').all()).toEqual([
      { id: 'entries:session_one' },
    ]);
  } finally {
    db.close();
  }
});
