import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Db, MIGRATIONS, openDatabase } from '@corral/storage-sqlite';
import { expect, it } from 'vitest';
import { SessionSearch } from '../src/session-search.ts';

function setup(path = ':memory:') {
  const db = openDatabase(path);
  db.prepare(
    "INSERT INTO work_sessions (id,project_id,corral_id,title,objective,pinned,revision,created_at,updated_at,archived_at,entries_json) VALUES ('session_search','default',NULL,'Search fixture','',0,1,'x','x',NULL,'[]')",
  ).run();
  return db;
}

function addRun(db: Db, id: string, texts: string[]) {
  db.prepare(
    "INSERT INTO runs (id,corral_id,definition_hash,snapshot_json,status,last_seq,projection_json,started_at,project_id,session_id) VALUES (?, 'team','hash','{}','succeeded',?,'{}','2026-10-28T00:00:00Z','default','session_search')",
  ).run(id, texts.length);
  texts.forEach((text, index) => {
    const sequence = index + 1;
    const artifactId = `${id}_source_${sequence}`;
    const type = index === texts.length - 1 ? 'artifact.version_created' : 'model.finished';
    const payload =
      type === 'artifact.version_created'
        ? { artifactVersionId: artifactId }
        : { responseRef: artifactId };
    db.prepare('INSERT INTO artifact_texts VALUES (?,?,?)').run(id, artifactId, text);
    db.prepare('INSERT INTO run_events VALUES (?,?,?,?,?)').run(
      id,
      sequence,
      `${id}_event_${sequence}`,
      type,
      JSON.stringify({ type, payload, runSeq: sequence }),
    );
  });
}

it('folds identical whole bodies before pagination and retains every exact source target', () => {
  const db = setup();
  try {
    for (let i = 1; i <= 51; i++) addRun(db, `run_${i}`, Array(3).fill('The Needle Result'));
    const search = new SessionSearch(db);
    const first = search.search({ query: 'needle', includeTranscript: true });
    const last = search.search({ query: 'needle', includeTranscript: true, offset: 50 });
    expect(first.total).toBe(51);
    expect(first.hits).toHaveLength(50);
    expect(last.hits).toHaveLength(1);
    expect(new Set([...first.hits, ...last.hits].map((hit) => hit.runId)).size).toBe(51);
    const hit = [...first.hits, ...last.hits].find((item) => item.runId === 'run_1');
    expect(hit?.runNumber).toBe(1);
    expect(hit?.sources).toEqual([
      { kind: 'response', runId: 'run_1', entryId: null, artifactVersionId: null, sequence: 1 },
      { kind: 'response', runId: 'run_1', entryId: null, artifactVersionId: null, sequence: 2 },
      {
        kind: 'artifact',
        runId: 'run_1',
        entryId: null,
        artifactVersionId: 'run_1_source_3',
        sequence: 3,
      },
    ]);
  } finally {
    db.close();
  }
});

it('reindexes original sources after reopening a database with the old derived cache', () => {
  const folder = mkdtempSync(join(tmpdir(), 'corral-search-migration-'));
  const path = join(folder, 'state.sqlite');
  let db = setup(path);
  try {
    addRun(db, 'run_existing', ['Original Needle CASE']);
    const source = db.prepare('SELECT * FROM run_events').all();
    db.exec('DROP TABLE session_search_v1; DROP TABLE session_search_state_v1;');
    const legacy = MIGRATIONS.find((migration) => migration.name === '0018_private_session_search');
    if (!legacy) throw new Error('Missing legacy search schema');
    db.exec(legacy.sql);
    db.exec(`INSERT INTO session_search_v1 VALUES ('old','session_search','run_existing',NULL,'run_existing_source_1',1,'artifact','original needle case');
      INSERT INTO session_search_state_v1 VALUES ('run:run_existing','1');`);
    db.pragma('user_version = 35');
    db.close();
    db = openDatabase(path);
    const search = new SessionSearch(db);
    expect(search.search({ query: 'needle' }).hits).toEqual([]);
    expect(
      db.prepare("SELECT count(*) AS n FROM session_search_v1 WHERE kind!='session'").get(),
    ).toEqual({ n: 0 });
    expect(search.search({ query: 'needle', includeTranscript: true }).hits[0]?.excerpt).toBe(
      'Original Needle CASE',
    );
    expect(db.prepare('SELECT * FROM run_events').all()).toEqual(source);
  } finally {
    db.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

it('preserves source case and grapheme boundaries when normalization expands or composes text', () => {
  const db = setup();
  try {
    const body = `${'ﬃ'.repeat(100)} 😀 Original ＮｅＥｄＬｅ CASE e\u0301`;
    addRun(db, 'run_original', [body]);
    const search = new SessionSearch(db);
    for (const [query, original] of [
      ['needle', 'ＮｅＥｄＬｅ'],
      ['é', 'e\u0301'],
    ] as const) {
      const hit = search.search({ query, includeTranscript: true }).hits[0];
      expect(hit?.excerpt).toContain('Original ＮｅＥｄＬｅ CASE');
      expect(hit?.excerptMatches?.map(({ start, end }) => hit.excerpt.slice(start, end))).toContain(
        original,
      );
      expect(body).toContain(hit?.excerpt);
    }
  } finally {
    db.close();
  }
});

it('does not fold different source bodies with an identical excerpt or differing case', () => {
  const db = setup();
  try {
    addRun(db, 'run_distinct', [
      `Needle ${'x'.repeat(300)}A`,
      `Needle ${'x'.repeat(300)}B`,
      'NEEDLE',
      'needle',
    ]);
    const result = new SessionSearch(db).search({ query: 'needle', includeTranscript: true });
    expect(result.hits).toHaveLength(4);
  } finally {
    db.close();
  }
});

it('does not build or expose private source text without explicit opt-in, including after rebuild', () => {
  const db = setup();
  try {
    addRun(db, 'run_private', ['Private Needle']);
    const search = new SessionSearch(db);
    expect(search.search({ query: 'needle' }).hits).toEqual([]);
    expect(
      db.prepare("SELECT count(*) AS n FROM session_search_v1 WHERE kind!='session'").get(),
    ).toEqual({ n: 0 });
    expect(search.search({ query: 'needle', includeTranscript: true }).hits[0]?.excerpt).toBe(
      'Private Needle',
    );
    search.rebuild();
    expect(search.search({ query: 'needle' }).hits).toEqual([]);
    expect(
      db.prepare("SELECT count(*) AS n FROM session_search_v1 WHERE kind!='session'").get(),
    ).toEqual({ n: 0 });
  } finally {
    db.close();
  }
});

it('uses the same normalized literal match for FTS candidates and source ranges', () => {
  const db = setup();
  try {
    addRun(db, 'run_sigma', [`PREFIX${'x'.repeat(300)} ΟΑΣ`]);
    const search = new SessionSearch(db);
    expect(search.search({ query: 'οασ', includeTranscript: true }).hits).toEqual([]);
    const hit = search.search({ query: 'οας', includeTranscript: true }).hits[0];
    expect(hit?.excerpt).toContain('ΟΑΣ');
    expect(hit?.excerptMatches?.map(({ start, end }) => hit.excerpt.slice(start, end))).toEqual([
      'ΟΑΣ',
    ]);
  } finally {
    db.close();
  }
});

it('maps compatibility Hangul composition across raw grapheme boundaries', () => {
  const db = setup();
  try {
    addRun(db, 'run_jamo', [`${'ㄱㅏ'.repeat(32700)} Needle`, 'ㄱㅏㄱㅏ']);
    const search = new SessionSearch(db);
    const hit = search.search({ query: 'needle', includeTranscript: true }).hits[0];
    expect(hit?.excerpt).toContain('Needle');
    expect(hit?.excerptMatches?.map(({ start, end }) => hit.excerpt.slice(start, end))).toEqual([
      'Needle',
    ]);
    const composed = search
      .search({ query: '가', includeTranscript: true })
      .hits.find((item) => item.excerpt === 'ㄱㅏㄱㅏ');
    expect(
      composed?.excerptMatches
        ?.map(({ start, end }) => composed.excerpt.slice(start, end))
        .join(''),
    ).toBe('ㄱㅏㄱㅏ');
  } finally {
    db.close();
  }
});
