import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type CanvasLayout, CorralDefinition } from '@corral/contracts';
import {
  Coordinator,
  InProcessTransport,
  type RunProjection,
  waitForProjection,
} from '@corral/core';
import {
  describeCorralRepositoryContract,
  describeRunStoreContract,
  describeTransportContract,
} from '@corral/core/testing';
import {
  FakeClock,
  Gate,
  linearCorral,
  ScriptedAgentAdapter,
  SequentialIdFactory,
} from '@corral/testkit';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import researchTeam from '../../../examples/research-team.corral.json' with { type: 'json' };
import researchLayout from '../../../examples/research-team.layout.json' with { type: 'json' };
import {
  MIGRATIONS,
  openDatabase as openSqliteDatabase,
  SqliteCorralRepository,
  SqliteRunStore,
} from '../src/index.ts';

const dirs: string[] = [];
const databases: Database.Database[] = [];
function trackDatabase(db: Database.Database) {
  databases.push(db);
  return db;
}
function openDatabase(path: string) {
  return trackDatabase(openSqliteDatabase(path));
}
function tempFile(name = 'corral.db') {
  const dir = mkdtempSync(join(tmpdir(), 'corral-sqlite-'));
  dirs.push(dir);
  return join(dir, name);
}
afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repository(db: Database.Database) {
  const ids = new SequentialIdFactory();
  return new SqliteCorralRepository(db, {
    clock: new FakeClock(),
    newCorralId: () => ids.next('run').replace('run', 'corral'),
  });
}

describeRunStoreContract('sqlite', () => new SqliteRunStore(openDatabase(':memory:')), {
  recordsProject: true,
});
describeCorralRepositoryContract('sqlite', () => repository(openDatabase(':memory:')));
describeTransportContract(
  'in-process over SQLite',
  (agents) =>
    new InProcessTransport(
      new Coordinator({
        clock: new FakeClock(),
        ids: new SequentialIdFactory(),
        agents,
        store: new SqliteRunStore(openDatabase(':memory:')),
      }),
    ),
);

const settled = (p: RunProjection) =>
  ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(p.status);

describe('SQLite database', () => {
  it('migrates old session titles without guessing and keeps pending automatic titles across restart', async () => {
    const file = tempFile();
    const old = trackDatabase(new Database(file));
    for (const migration of MIGRATIONS.slice(0, 27)) {
      old.exec(migration.sql);
      migration.data?.(old);
    }
    old.pragma('user_version = 27');
    old
      .prepare(`INSERT INTO work_sessions
      (id, project_id, corral_id, title, objective, pinned, revision, created_at, updated_at, archived_at, entries_json)
      VALUES ('session_legacy', 'default', NULL, 'New session', '', 0, 1, 'x', 'x', NULL, '[]')`)
      .run();
    old.close();
    const upgraded = openDatabase(file);
    const repo = repository(upgraded);
    expect(await repo.getSession('session_legacy')).toMatchObject({
      title: 'New session',
      autoTitle: false,
    });
    await repo.addSessionEntry('session_legacy', {
      intent: 'next',
      text: 'Keep the legacy name',
      state: 'started',
    });
    expect((await repo.getSession('session_legacy'))?.title).toBe('New session');
    const created = await repo.createSession({
      projectId: 'default',
      title: 'New session',
      autoTitle: true,
    });
    if (!created.ok) throw new Error(created.message);
    upgraded.close();
    const reopened = repository(openDatabase(file));
    expect((await reopened.getSession(created.session.sessionId))?.autoTitle).toBe(true);
    const named = await reopened.addSessionEntry(created.session.sessionId, {
      intent: 'next',
      text: 'A title after restart',
      state: 'started',
    });
    expect(named.ok && named.session.title).toBe('A title after restart');
  });

  it('migrates a new file to the latest schema with durable settings', () => {
    const db = openDatabase(tempFile());
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('synchronous', { simple: true })).toBe(2);
    db.close();
  });

  it('reopens an existing file without migrating again', () => {
    const file = tempFile();
    openDatabase(file).close();
    const db = openDatabase(file);
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    db.close();
  });

  it('refuses a database written by a newer Corral instead of guessing', () => {
    const file = tempFile();
    const raw = trackDatabase(new Database(file));
    raw.pragma(`user_version = ${MIGRATIONS.length + 1}`);
    raw.close();
    expect(() => openDatabase(file)).toThrow(/newer/);
  });

  it('rejects edits to committed events and artifact bodies at the database level', () => {
    const db = openDatabase(':memory:');
    const store = new SqliteRunStore(db);
    describeOnce(store);
    expect(() => db.prepare("UPDATE run_events SET type = 'x'").run()).toThrow(/immutable/);
    expect(() => db.prepare('DELETE FROM run_events').run()).toThrow(/immutable/);
    expect(() => db.prepare("UPDATE artifact_texts SET text_body = 'x'").run()).toThrow(
      /immutable/,
    );
  });
});

/** Commits one small run through a real coordinator. */
function describeOnce(store: SqliteRunStore) {
  const coordinator = new Coordinator({
    clock: new FakeClock(),
    ids: new SequentialIdFactory(),
    agents: new ScriptedAgentAdapter({ turns: 1 }),
    store,
  });
  coordinator.startRun({
    schemaVersion: '0.1',
    commandId: 'cmd_once',
    definition: linearCorral(['writer']),
    mode: 'mock',
  });
}

describe('SQLite Corral repository', () => {
  const layout = () => ({
    nodes: JSON.parse(JSON.stringify((researchLayout as unknown as CanvasLayout).nodes)),
    viewport: { x: 0, y: 0, zoom: 1 },
  });

  it('keeps every saved definition revision for runs to start from', async () => {
    const repo = repository(openDatabase(':memory:'));
    const created = await repo.save({
      definition: CorralDefinition.parse(researchTeam),
      layout: layout(),
      expectedDefinitionRevision: null,
    });
    if (!created.ok) throw new Error(created.message);
    const id = created.record.corralId;
    const edited = JSON.parse(JSON.stringify(created.record.definition)) as CorralDefinition;
    const role = edited.roles[0];
    if (role) role.prompt = 'Changed.';
    const saved = await repo.save({
      definition: edited,
      layout: layout(),
      expectedDefinitionRevision: 1,
    });
    expect(saved.ok && saved.record.definitionRevision).toBe(2);

    expect(repo.getDefinition(id, 1)?.roles[0]?.prompt).toBe(
      created.record.definition.roles[0]?.prompt,
    );
    expect(repo.getDefinition(id, 2)?.roles[0]?.prompt).toBe('Changed.');
    expect(repo.getDefinition(id, 3)).toBeNull();
  });

  it('refuses a stored row it cannot read instead of guessing', async () => {
    const db = openDatabase(':memory:');
    const repo = repository(db);
    const created = await repo.save({
      definition: CorralDefinition.parse(researchTeam),
      layout: layout(),
      expectedDefinitionRevision: null,
    });
    if (!created.ok) throw new Error(created.message);
    db.prepare('UPDATE layouts SET layout_json = \'{"broken":\'').run();
    await expect(repo.get(created.record.corralId)).rejects.toThrow(/cannot be read/);
  });
});

describe('Coordinator over a SQLite file', () => {
  it('a new process marks the run interrupted and calls no agent', async () => {
    const file = tempFile();
    const gate = new Gate();
    const dbA = openDatabase(file);
    const first = new Coordinator({
      clock: new FakeClock(),
      ids: new SequentialIdFactory('a'),
      agents: new ScriptedAgentAdapter({ turns: 1, beforeReply: () => gate.wait() }),
      store: new SqliteRunStore(dbA),
      sessionId: 'backend_a',
    });
    const transportA = new InProcessTransport(first);
    const { runId } = await transportA.startRun({
      schemaVersion: '0.1',
      commandId: 'cmd_start',
      definition: linearCorral(['writer']),
      mode: 'mock',
    });
    await waitForProjection(transportA, runId ?? '', (p) =>
      Object.values(p.effects).some((e) => e.kind === 'model_request'),
    );
    const cached = new SqliteRunStore(dbA).getRun(runId ?? '')?.projection;
    if (!cached) throw new Error('expected running projection');
    const oldProjection: Partial<RunProjection> = { ...cached };
    delete oldProjection.budget;
    dbA
      .prepare('UPDATE runs SET projection_json = ? WHERE id = ?')
      .run(JSON.stringify(oldProjection), runId);
    // The process dies: its connection is gone; the late reply cannot record anything.
    dbA.close();
    gate.open();
    for (let i = 0; i < 100; i++) await Promise.resolve();

    let starts = 0;
    const second = new Coordinator({
      clock: new FakeClock(),
      ids: new SequentialIdFactory('b'),
      agents: {
        start: async (...args) => {
          starts += 1;
          return new ScriptedAgentAdapter({ turns: 1 }).start(...args);
        },
      },
      store: new SqliteRunStore(openDatabase(file)),
      sessionId: 'backend_b',
    });
    const projection = second.getSnapshot(runId ?? '').projection;
    expect(projection.status).toBe('interrupted');
    expect(projection.interruptedBy).toBe('backend_b');
    expect(starts).toBe(0);
    expect(first.admitting).toBe(false);
  });

  it('rebuilds a P5 cached projection from events without changing persisted history', async () => {
    const file = tempFile();
    const db = openDatabase(file);
    const store = new SqliteRunStore(db);
    const transport = new InProcessTransport(
      new Coordinator({
        clock: new FakeClock(),
        ids: new SequentialIdFactory(),
        agents: new ScriptedAgentAdapter({ turns: 1 }),
        store,
      }),
    );
    const { runId } = await transport.startRun({
      schemaVersion: '0.1',
      commandId: 'cmd_legacy',
      definition: linearCorral(['writer']),
      mode: 'mock',
    });
    if (!runId) throw new Error('expected run');
    const done = await waitForProjection(transport, runId, settled);
    const legacy: Partial<RunProjection> = { ...done };
    delete legacy.budget;
    const cached = JSON.stringify(legacy);
    db.prepare('UPDATE runs SET projection_json = ? WHERE id = ?').run(cached, runId);
    const events = store.readEvents(runId, 0);
    expect(store.getRun(runId)?.projection).toEqual(done);
    expect(db.prepare('SELECT projection_json FROM runs WHERE id = ?').get(runId)).toEqual({
      projection_json: cached,
    });
    expect(store.readEvents(runId, 0)).toEqual(events);
    db.close();
  });

  it('reads a finished run from a new process without any agent', async () => {
    const file = tempFile();
    const dbA = openDatabase(file);
    const transportA = new InProcessTransport(
      new Coordinator({
        clock: new FakeClock(),
        ids: new SequentialIdFactory('a'),
        agents: new ScriptedAgentAdapter({ turns: 1 }),
        store: new SqliteRunStore(dbA),
      }),
    );
    const { runId } = await transportA.startRun({
      schemaVersion: '0.1',
      commandId: 'cmd_start',
      definition: linearCorral(['research', 'writer']),
      mode: 'mock',
    });
    const done = await waitForProjection(transportA, runId ?? '', settled);
    dbA.close();

    const reader = new Coordinator({
      clock: new FakeClock(),
      ids: new SequentialIdFactory('b'),
      agents: {
        start: () => Promise.reject(new Error('no agent may run while reading')),
      },
      store: new SqliteRunStore(openDatabase(file)),
    });
    expect(reader.getSnapshot(runId ?? '').projection).toEqual(done);
    const output = done.output?.artifactVersionIds[0] ?? '';
    expect(reader.getArtifactText(runId ?? '', output)).toContain('writer (writer) turn 1');
    expect(reader.listRuns().map((r) => [r.runId, r.status])).toEqual([[runId, 'succeeded']]);
  });
});

describe('read-only history', () => {
  it('opens records without migration or modifying a running run', async () => {
    const { openReadOnlyDatabase } = await import('../src/database.ts');
    const file = tempFile();
    const writable = openDatabase(file);
    describeOnce(new SqliteRunStore(writable));
    const before = writable.prepare('SELECT status, last_seq FROM runs').all();
    const reader = trackDatabase(openReadOnlyDatabase(file));
    expect(new SqliteRunStore(reader).listRuns()).toHaveLength(1);
    expect(() => reader.prepare("UPDATE runs SET status = 'interrupted'").run()).toThrow();
    expect(writable.prepare('SELECT status, last_seq FROM runs').all()).toEqual(before);
    reader.close();
    writable.close();
  });
});

describe('projects in SQLite', () => {
  // One agent: runs end on their own, with no person to approve anything.
  const layout = () => ({ nodes: {}, viewport: { x: 0, y: 0, zoom: 1 } });

  async function runOf(db: Database.Database, corralId: string, commandId: string) {
    const repo = repository(db);
    const transport = new InProcessTransport(
      new Coordinator({
        clock: new FakeClock(),
        ids: new SequentialIdFactory(commandId),
        agents: new ScriptedAgentAdapter({ turns: 1 }),
        store: new SqliteRunStore(db),
        corrals: repo,
      }),
    );
    const { runId } = await transport.startRun({
      schemaVersion: '0.1',
      commandId,
      corralId,
      definitionRevision: 1,
      mode: 'mock',
    });
    if (!runId) throw new Error('run refused');
    await waitForProjection(transport, runId, (p) => p.status === 'succeeded');
    return runId;
  }

  it('records the project a run started in; a moved Corral leaves old runs where they were', async () => {
    const db = openDatabase(':memory:');
    const repo = repository(db);
    const project = await repo.createProject({ name: 'Research' });
    if (!project.ok) throw new Error(project.message);
    const created = await repo.save({
      definition: linearCorral(['writer']),
      layout: layout(),
      expectedDefinitionRevision: null,
      projectId: project.project.projectId,
    });
    if (!created.ok) throw new Error(created.message);
    const first = await runOf(db, created.record.corralId, 'cmd_a');
    await repo.moveCorral(created.record.corralId, 'default');
    const second = await runOf(db, created.record.corralId, 'cmd_b');
    const store = new SqliteRunStore(db);
    const projectOf = (runId: string) => store.listRuns().find((r) => r.runId === runId)?.projectId;
    expect(projectOf(first)).toBe(project.project.projectId);
    expect(projectOf(second)).toBe('default');
  });

  it('an older file gains the default project; runs and events keep their ids', async () => {
    // A finished run and a saved Corral, copied into a file at schema 2 (before projects).
    const source = openDatabase(':memory:');
    const repo = repository(source);
    const created = await repo.save({
      definition: linearCorral(['writer']),
      layout: layout(),
      expectedDefinitionRevision: null,
    });
    if (!created.ok) throw new Error(created.message);
    const runId = await runOf(source, created.record.corralId, 'cmd_old');
    const path = tempFile();
    const old = trackDatabase(new Database(path));
    old.exec((MIGRATIONS[0] as { sql: string }).sql);
    old.exec((MIGRATIONS[1] as { sql: string }).sql);
    old.pragma('user_version = 2');
    old.close();
    source.exec(`ATTACH DATABASE '${path}' AS old`);
    const copy = (table: string, columns: string) =>
      source.exec(`INSERT INTO old.${table} (${columns}) SELECT ${columns} FROM main.${table}`);
    copy('corrals', 'id, name, definition_revision, layout_revision, updated_at');
    copy(
      'definition_versions',
      'corral_id, revision, definition_hash, definition_json, created_at',
    );
    copy('layouts', 'corral_id, layout_revision, definition_revision, layout_json');
    copy(
      'runs',
      'id, corral_id, definition_hash, snapshot_json, status, last_seq, projection_json, started_at',
    );
    copy('run_events', 'run_id, seq, event_id, type, event_json');
    copy('artifact_texts', 'run_id, artifact_version_id, text_body');
    const eventIds = (db: Database.Database, schema = 'main') =>
      (
        db.prepare(`SELECT event_id FROM ${schema}.run_events ORDER BY seq`).all() as {
          event_id: string;
        }[]
      ).map((row) => row.event_id);
    const before = eventIds(source, 'old');
    source.exec('DETACH DATABASE old');

    const migrated = openDatabase(path);
    expect(migrated.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    const reopened = repository(migrated);
    expect((await reopened.listProjects()).map((p) => p.projectId)).toEqual(['default']);
    expect((await reopened.list()).map((c) => [c.corralId, c.projectId])).toEqual([
      [created.record.corralId, 'default'],
    ]);
    const runs = new SqliteRunStore(migrated).listRuns();
    expect(runs.map((r) => [r.runId, r.projectId])).toEqual([[runId, 'default']]);
    expect(eventIds(migrated)).toEqual(before);
    expect(before.length).toBeGreaterThan(0);
  });

  it('a session saved before auto mode opens as auto with no model chosen', async () => {
    const path = tempFile();
    const old = trackDatabase(new Database(path));
    const before = MIGRATIONS.findIndex((migration) => migration.name === '0013_session_auto');
    expect(before).toBe(12);
    for (const migration of MIGRATIONS.slice(0, before))
      old.exec((migration as { sql: string }).sql);
    old.pragma(`user_version = ${before}`);
    old
      .prepare(
        `INSERT INTO work_sessions (id, project_id, corral_id, title, objective, pinned, revision,
           created_at, updated_at, archived_at, entries_json)
         VALUES ('session_old', 'default', NULL, 'Old', '', 0, 3, '2026-10-01T00:00:00.000Z',
           '2026-10-01T00:00:00.000Z', NULL, '[]')`,
      )
      .run();
    old.close();
    const repo = repository(openDatabase(path));
    expect(await repo.getSession('session_old')).toMatchObject({
      corralId: null,
      auto: null,
      revision: 3,
    });
  });

  it('puts runs of inline definitions in the default project', async () => {
    const db = openDatabase(':memory:');
    const transport = new InProcessTransport(
      new Coordinator({
        clock: new FakeClock(),
        ids: new SequentialIdFactory(),
        agents: new ScriptedAgentAdapter({ turns: 1 }),
        store: new SqliteRunStore(db),
      }),
    );
    const { runId } = await transport.startRun({
      schemaVersion: '0.1',
      commandId: 'cmd_inline',
      definition: linearCorral(['writer']),
      mode: 'mock',
    });
    await waitForProjection(transport, runId ?? '', (p) => p.status === 'succeeded');
    expect(new SqliteRunStore(db).listRuns()[0]?.projectId).toBe('default');
  });
});

it('preserves the private incomplete prefix across a process restart without creating a result', async () => {
  const file = tempFile();
  const dbA = openDatabase(file);
  let host!: import('@corral/contracts').AgentHost;
  const writer = new Coordinator({
    clock: new FakeClock(),
    ids: new SequentialIdFactory('prefix-a'),
    store: new SqliteRunStore(dbA),
    agents: {
      async start(_input, bound) {
        host = bound;
        return { cancel: async () => {}, waitForSettlement: () => new Promise(() => {}) };
      },
    },
  });
  const { runId } = writer.startRun({
    schemaVersion: '0.1',
    commandId: 'prefix-start',
    mode: 'mock',
    definition: linearCorral(['writer']),
  });
  if (!runId) throw new Error('missing run');
  for (let i = 0; i < 100; i++) await Promise.resolve();
  const permit = await host.prepareModelRequest();
  host.streamText({
    modelCallId: permit.modelCallId,
    chunkIndex: 0,
    text: '**Saved before restart**',
  });
  dbA.close();
  const reader = new Coordinator({
    clock: new FakeClock(),
    ids: new SequentialIdFactory('prefix-b'),
    store: new SqliteRunStore(openDatabase(file)),
    agents: {
      start: async () => {
        throw new Error('no replayed agent');
      },
    },
  });
  const snapshot = reader.getSnapshot(runId);
  expect(snapshot.projection.status).toBe('interrupted');
  expect(snapshot.partialOutputs?.[permit.modelCallId]).toEqual({
    text: '**Saved before restart**',
    next: 1,
    truncated: false,
  });
  expect(snapshot.projection.output).toBeNull();
  expect(snapshot.projection.modelCalls[permit.modelCallId]?.responseRef).toBeNull();
  expect(Object.values(snapshot.projection.artifacts)).toHaveLength(0);
});
