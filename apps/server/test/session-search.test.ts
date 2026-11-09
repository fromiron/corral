import { emptyProjection } from '@corral/core';
import { openDatabase, SqliteRunStore } from '@corral/storage-sqlite';
import { expect, it } from 'vitest';
import { SessionSearch } from '../src/session-search.ts';

it('searches private multilingual entries literally and rebuilds without reviving archived or removed sessions', () => {
  const db = openDatabase(':memory:');
  try {
    const entries = [
      { entryId: 'entry_one', text: '설정 확인 日本語 src/work_plan.ts token_identifier' },
    ];
    db.prepare(
      "INSERT INTO work_sessions (id,project_id,corral_id,title,objective,pinned,revision,created_at,updated_at,archived_at,entries_json) VALUES ('session_search','default',NULL,'Metadata title','Objective',0,1,'x','x',NULL,?)",
    ).run(JSON.stringify(entries));
    const search = new SessionSearch(db);
    expect(search.search({ query: '설정', includeTranscript: false }).hits).toHaveLength(0);
    expect(search.search({ query: 'Metadata', includeTranscript: false }).hits[0]?.kind).toBe(
      'session',
    );
    for (const query of ['설정', '日本語', 'src/work_plan.ts', 'token_identifier']) {
      expect(search.search({ query, includeTranscript: true }).hits).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sessionId: 'session_search',
            entryId: 'entry_one',
            kind: 'entry',
          }),
        ]),
      );
    }
    expect(search.search({ query: '" OR *', includeTranscript: true }).hits).toHaveLength(0);
    db.prepare("UPDATE work_sessions SET archived_at='x' WHERE id='session_search'").run();
    expect(search.search({ query: '설정', includeTranscript: true }).hits).toHaveLength(0);
    expect(
      search.search({ query: '설정', includeTranscript: true, includeArchived: true }).hits,
    ).toHaveLength(1);
    search.rebuild();
    expect(
      search.search({ query: '日本語', includeTranscript: true, includeArchived: true })
        .indexVersion,
    ).toBe(1);
    db.prepare("DELETE FROM work_sessions WHERE id='session_search'").run();
    expect(
      search.search({ query: '日本語', includeTranscript: true, includeArchived: true }).hits,
    ).toHaveLength(0);
  } finally {
    db.close();
  }
});

function transcriptFixture() {
  const db = openDatabase(':memory:');
  db.prepare(
    "INSERT INTO work_sessions (id,project_id,corral_id,title,objective,pinned,revision,created_at,updated_at,archived_at,entries_json) VALUES ('session','default',NULL,'Metadata','Objective',0,1,'x','x',NULL,?)",
  ).run(JSON.stringify([{ entryId: 'entry', text: 'ordinaryrequest' }]));
  const projection = emptyProjection('run');
  projection.status = 'succeeded';
  for (const id of ['retired', 'current'])
    projection.artifacts[id] = {
      artifactVersionId: id,
      artifactId: id,
      name: id,
      version: 1,
      parentVersionId: null,
      contract: 'text',
      contentHash: 'a'.repeat(64),
      byteLength: 1,
      authorExecutionId: 'exec',
      modelCallId: null,
      contextSnapshotId: null,
      submitted: true,
      configRevision: 0,
      criteriaVersionId: null,
      inputArtifactVersionIds: [],
    };
  projection.output = { nodeId: 'output', artifactVersionIds: ['retired', 'current'] };
  db.prepare(
    "INSERT INTO runs (id,corral_id,definition_hash,snapshot_json,status,last_seq,projection_json,started_at,session_id) VALUES ('run','corral','hash','{}','succeeded',2,?,'x','session')",
  ).run(JSON.stringify(projection));
  for (const [index, id] of ['retired', 'current'].entries()) {
    db.prepare('INSERT INTO artifact_texts VALUES (?,?,?)').run('run', id, `${id}bodytoken`);
    const event = {
      type: 'artifact.version_created',
      runSeq: index + 1,
      payload: { artifactVersionId: id },
    };
    db.prepare('INSERT INTO run_events VALUES (?,?,?,?,?)').run(
      'run',
      index + 1,
      `event_${id}`,
      event.type,
      JSON.stringify(event),
    );
  }
  const store = new SqliteRunStore(db);
  store.putConversationTurn('run', {
    runId: 'run',
    request: 'ordinaryrequest',
    answer: 'ordinaryanswertoken',
    artifactVersionId: 'retired',
    status: 'succeeded',
  });
  const retire = () => {
    store.retainArtifactBodies('run', ['current']);
    const retired = projection.artifacts.retired;
    if (!retired) throw new Error('fixture artifact missing');
    retired.bodyAvailable = false;
    db.prepare('UPDATE runs SET projection_json=? WHERE id=?').run(
      JSON.stringify(projection),
      'run',
    );
  };
  return { db, retire, search: new SessionSearch(db) };
}

it('does not rebuild released bodies while keeping current results and ordinary conversation searchable', () => {
  const { db, retire, search } = transcriptFixture();
  try {
    expect(search.search({ query: 'retiredbodytoken', includeTranscript: true }).hits).toHaveLength(
      1,
    );
    retire();
    expect(search.search({ query: 'retiredbodytoken', includeTranscript: true }).hits).toEqual([]);
    expect(search.search({ query: 'currentbodytoken', includeTranscript: true }).hits).toHaveLength(
      1,
    );
    expect(search.search({ query: 'ordinaryanswertoken', includeTranscript: true }).hits).toEqual([
      expect.objectContaining({ runId: 'run', artifactVersionId: null, kind: 'response' }),
    ]);
    expect(
      search.search({ query: 'ordinaryrequest', includeTranscript: true }).hits.length,
    ).toBeGreaterThan(0);
    expect(search.search({ query: 'ordinaryanswertoken', includeTranscript: false }).hits).toEqual(
      [],
    );
    search.rebuild();
    expect(search.search({ query: 'retiredbodytoken', includeTranscript: true }).hits).toEqual([]);
    expect(
      search.search({ query: 'ordinaryanswertoken', includeTranscript: true }).hits,
    ).toHaveLength(1);
  } finally {
    db.close();
  }
});

it('does not hide a missing body that remains readable', () => {
  const { db, search } = transcriptFixture();
  try {
    db.prepare('DELETE FROM artifact_texts WHERE artifact_version_id=?').run('current');
    expect(() => search.search({ query: 'currentbodytoken', includeTranscript: true })).toThrow(
      'private search source is incomplete',
    );
  } finally {
    db.close();
  }
});
