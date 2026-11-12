import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpSseTransport, RestCorralRepository } from '@corral/client';
import {
  type NewSessionEntry,
  queuedSessionCommandId,
  type SessionEntryStart,
  waitForProjection,
} from '@corral/core';
import { openDatabase, SqliteCorralRepository } from '@corral/storage-sqlite';
import { FakeClock, Gate, ScriptedAgentAdapter } from '@corral/testkit';
import { afterEach, expect, it, vi } from 'vitest';
import { type CorralServer, startCorralServer } from '../src/index.ts';

// The server starts a work session's first queued request when this process sees a run of
// that session end (features/composer-flow.md, "대기 요청과 넘겨받기").

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

const START: SessionEntryStart = {
  choice: { modelProfile: 'model-a' },
  mode: 'mock',
  team: 'none',
};
const TOKEN = 'test-session-queue-0123456789abcdef0';

async function boot(root: string) {
  let hold: Gate | null = null;
  // A run named here waits on its own gate after the shared one opens.
  const runGates = new Map<string, Gate>();
  const server: CorralServer = await startCorralServer({
    workspace: join(root, 'workspace'),
    worktreeRoot: join(root, 'copies'),
    port: 0,
    bootstrapToken: TOKEN,
    agents: new ScriptedAgentAdapter({
      turns: 1,
      collaborate: false,
      appendNotes: false,
      beforeReply: async (_turn, input) => {
        await hold?.wait();
        await runGates.get(input.runId)?.wait();
      },
      reply: () => 'Done.',
    }),
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await server.close();
  };
  cleanup.push(() => {
    hold?.open();
    for (const gate of runGates.values()) gate.open();
    return close();
  });
  const login = await fetch(`${server.url}/api/v1/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: server.url },
    body: JSON.stringify({ token: TOKEN }),
  });
  const headers = {
    cookie: (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '',
    'x-corral-csrf': login.headers.get('x-corral-csrf') ?? '',
    origin: server.url,
  };
  const call: typeof fetch = (input, init = {}) => {
    const merged = new Headers(init.headers);
    for (const [key, value] of Object.entries(headers)) merged.set(key, value);
    if (init.body) merged.set('content-type', 'application/json');
    return fetch(input, { ...init, headers: merged });
  };
  const send = async (method: string, path: string, body?: unknown) => {
    const response = await call(`${server.url}/api/v1${path}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  const repository = new RestCorralRepository({ baseUrl: server.url, fetch: call });
  const transport = new HttpSseTransport({ baseUrl: server.url, fetch: call });
  return {
    server,
    close,
    send,
    repository,
    transport,
    hold() {
      const gate = new Gate();
      hold = gate;
      return gate;
    },
    holdRun(runId: string) {
      const gate = new Gate();
      runGates.set(runId, gate);
      return gate;
    },
  };
}

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'corral-session-queue-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const s = await boot(root);
  const session = async () => {
    const created = await s.repository.createSession({ projectId: 'default', title: 'Queue' });
    if (!created.ok) throw new Error(created.message);
    return created.session;
  };
  const ask = (sessionId: string, commandId: string, brief = 'First request.') =>
    s.transport.startAuto({ commandId, sessionId, brief, ...START });
  const queue = async (sessionId: string, text: string, extra: Partial<NewSessionEntry> = {}) => {
    const added = await s.repository.addSessionEntry(sessionId, {
      intent: 'queue',
      text,
      state: 'queued',
      ...extra,
    });
    if (!added.ok) throw new Error(added.message);
    const entry = added.session.entries.at(-1);
    if (!entry) throw new Error('no entry');
    return entry;
  };
  const ended = (runId: string | null) =>
    waitForProjection(s.transport, runId ?? '', (p) =>
      ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(p.status),
    );
  const entryOf = async (sessionId: string, entryId: string) =>
    (await s.repository.getSession(sessionId))?.entries.find((e) => e.entryId === entryId);
  /** Polls until the entry leaves `queued`, or returns it still queued after the wait. */
  const settledEntry = async (sessionId: string, entryId: string, ms = 2_000) => {
    const until = Date.now() + ms;
    for (;;) {
      const entry = await entryOf(sessionId, entryId);
      if (entry?.state !== 'queued' || Date.now() > until) return entry;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const runsOf = (sessionId: string) =>
    s.server.coordinator.listRuns().filter((run) => run.sessionId === sessionId);
  return { ...s, root, session, ask, queue, ended, entryOf, settledEntry, runsOf };
}

it('saves autoStart with the session, true by default, under its revision', async () => {
  const s = await setup();
  const session = await s.session();
  expect(session.autoStart).toBe(true);
  const off = await s.send('PATCH', `/sessions/${session.sessionId}`, {
    autoStart: false,
    expectedRevision: 1,
  });
  expect(off.status).toBe(200);
  expect(off.body.session).toMatchObject({ autoStart: false, revision: 2 });
  expect(await s.repository.getSession(session.sessionId)).toMatchObject({ autoStart: false });
  const stale = await s.send('PATCH', `/sessions/${session.sessionId}`, {
    autoStart: true,
    expectedRevision: 1,
  });
  expect(stale.status).toBe(409);
  const invalid = await s.send('PATCH', `/sessions/${session.sessionId}`, {
    autoStart: 'yes',
    expectedRevision: 2,
  });
  expect(invalid.status).toBe(400);
  const on = await s.repository.updateSession(session.sessionId, {
    autoStart: true,
    expectedRevision: 2,
  });
  expect(on).toMatchObject({ ok: true, session: { autoStart: true, revision: 3 } });
});

it('starts the first queued request once when the run ends, and records its run', async () => {
  const s = await setup();
  const session = await s.session();
  const gate = s.hold();
  const first = await s.ask(session.sessionId, 'cmd_first');
  const next = await s.queue(session.sessionId, 'Second request.', { start: START });
  const later = await s.queue(session.sessionId, 'Third request.', { start: START });
  // A queued request whose start was not saved stays for a person.
  gate.open();
  await s.ended(first.runId);
  const started = await s.settledEntry(session.sessionId, next.entryId);
  expect(started).toMatchObject({ state: 'started', detail: null });
  expect(started?.runId).toBeTruthy();
  expect(started?.runId).not.toBe(first.runId);
  const second = await s.transport.getRunDefinition(started?.runId ?? '');
  expect(second?.input.brief).toContain('Second request.');
  await s.ended(started?.runId ?? null);
  // The third starts after the second ends, not before.
  const third = await s.settledEntry(session.sessionId, later.entryId);
  expect(third).toMatchObject({ state: 'started' });
  await s.ended(third?.runId ?? null);
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(s.runsOf(session.sessionId)).toHaveLength(3);
});

it('a screen starting the same entry reaches the same single run', async () => {
  const s = await setup();
  const session = await s.session();
  const gate = s.hold();
  const first = await s.ask(session.sessionId, 'cmd_first');
  const entry = await s.queue(session.sessionId, 'Second request.', { start: START });
  gate.open();
  await s.ended(first.runId);
  const started = await s.settledEntry(session.sessionId, entry.entryId);
  expect(started?.state).toBe('started');
  const commandId = queuedSessionCommandId(session.sessionId, entry);
  const same = await s.transport.startAuto({
    ...START,
    commandId,
    sessionId: session.sessionId,
    brief: 'Second request.',
    conversation: { throughRunId: first.runId ?? '' },
  });
  expect(same.runId).toBe(started?.runId);
  const other = await s.send('POST', '/runs/auto', {
    schemaVersion: '0.1',
    ...START,
    choice: { modelProfile: 'model-b' },
    commandId,
    sessionId: session.sessionId,
    brief: 'Second request.',
  });
  expect(other.body.receipt.error.code).toBe('IDEMPOTENCY_CONFLICT');
  expect(await s.entryOf(session.sessionId, entry.entryId)).toEqual(started);
  await s.ended(started?.runId ?? null);
  expect(s.runsOf(session.sessionId)).toHaveLength(2);
});

it('leaves the entry alone when another start of its command owns the outcome', async () => {
  const s = await setup();
  const session = await s.session();
  const gate = s.hold();
  const first = await s.ask(session.sessionId, 'cmd_first');
  const entry = await s.queue(session.sessionId, 'Second request.', { start: START });
  // Another tab started this entry with a different snapshot and has not saved it yet.
  const screen = await s.send('POST', '/runs/auto', {
    schemaVersion: '0.1',
    ...START,
    choice: { modelProfile: 'model-b' },
    commandId: queuedSessionCommandId(session.sessionId, entry),
    sessionId: session.sessionId,
    brief: 'Second request.',
  });
  expect(screen.status).toBe(201);
  gate.open();
  await s.ended(first.runId);
  await s.ended(screen.body.runId);
  expect(await s.settledEntry(session.sessionId, entry.entryId, 400)).toMatchObject({
    state: 'queued',
    runId: null,
  });
  expect(s.runsOf(session.sessionId)).toHaveLength(2);
});

it('does not start with autoStart off, unless the entry was carried over', async () => {
  const s = await setup();
  const session = await s.session();
  const off = await s.repository.updateSession(session.sessionId, {
    autoStart: false,
    expectedRevision: 1,
  });
  if (!off.ok) throw new Error(off.message);
  const gate = s.hold();
  const first = await s.ask(session.sessionId, 'cmd_first');
  const plain = await s.queue(session.sessionId, 'Wait for me.', { start: START });
  gate.open();
  await s.ended(first.runId);
  expect(await s.settledEntry(session.sessionId, plain.entryId, 400)).toMatchObject({
    state: 'queued',
    runId: null,
  });
  expect(s.runsOf(session.sessionId)).toHaveLength(1);

  // A carried entry starts even with autoStart off. Only the server writes carriedFrom.
  const other = await s.session();
  const off2 = await s.repository.updateSession(other.sessionId, {
    autoStart: false,
    expectedRevision: 1,
  });
  if (!off2.ok) throw new Error(off2.message);
  const db = openDatabase(join(s.root, 'workspace', '.corral', 'corral.db'));
  cleanup.push(() => {
    db.close();
  });
  const direct = new SqliteCorralRepository(db, { clock: new FakeClock(), newCorralId: () => 'x' });
  const held = s.hold();
  const run = await s.ask(other.sessionId, 'cmd_carried_first');
  const carried = await direct.addSessionEntry(other.sessionId, {
    intent: 'queue',
    text: 'Read this after all.',
    state: 'queued',
    start: START,
    carriedFrom: 'dir_original',
  });
  if (!carried.ok) throw new Error(carried.message);
  const carriedEntry = carried.session.entries.at(-1);
  held.open();
  await s.ended(run.runId);
  expect(await s.settledEntry(other.sessionId, carriedEntry?.entryId ?? '')).toMatchObject({
    state: 'started',
    carriedFrom: 'dir_original',
  });
});

it('leaves an entry without a start snapshot queued, and does not skip past it', async () => {
  const s = await setup();
  const session = await s.session();
  const gate = s.hold();
  const first = await s.ask(session.sessionId, 'cmd_first');
  const bare = await s.queue(session.sessionId, 'No snapshot.');
  const behind = await s.queue(session.sessionId, 'Behind it.', { start: START });
  gate.open();
  await s.ended(first.runId);
  expect(await s.settledEntry(session.sessionId, bare.entryId, 400)).toMatchObject({
    state: 'queued',
  });
  expect(await s.entryOf(session.sessionId, behind.entryId)).toMatchObject({ state: 'queued' });
  expect(s.runsOf(session.sessionId)).toHaveLength(1);
});

it('waits while another run of the session is still open', async () => {
  const s = await setup();
  const session = await s.session();
  const gate = s.hold();
  const a = await s.ask(session.sessionId, 'cmd_a', 'Run A.');
  const b = await s.ask(session.sessionId, 'cmd_b', 'Run B.');
  const holdB = s.holdRun(b.runId ?? '');
  const entry = await s.queue(session.sessionId, 'After both.', { start: START });
  gate.open();
  await s.ended(a.runId);
  expect(await s.settledEntry(session.sessionId, entry.entryId, 400)).toMatchObject({
    state: 'queued',
  });
  expect(s.runsOf(session.sessionId)).toHaveLength(2);
  holdB.open();
  await s.ended(b.runId);
  const started = await s.settledEntry(session.sessionId, entry.entryId);
  expect(started).toMatchObject({ state: 'started' });
  expect(s.runsOf(session.sessionId)).toHaveLength(3);
});

it('records a refused start on the entry with its reason', async () => {
  const s = await setup();
  const session = await s.session();
  const gate = s.hold();
  const first = await s.ask(session.sessionId, 'cmd_first');
  const entry = await s.queue(session.sessionId, 'Use a missing team.', {
    start: { ...START, team: { corralId: 'corral_missing' } },
  });
  gate.open();
  await s.ended(first.runId);
  const refused = await s.settledEntry(session.sessionId, entry.entryId);
  expect(refused).toMatchObject({ state: 'refused', runId: null });
  expect(refused?.detail).toBeTruthy();
  expect(refused?.refusal?.code).toBeTruthy();
});

it('does not start the queue on restart behind runs that already ended', async () => {
  const s = await setup();
  const session = await s.session();
  const gate = s.hold();
  const first = await s.ask(session.sessionId, 'cmd_first');
  const entry = await s.queue(session.sessionId, 'After a restart.', { start: START });
  // The run is still open when the server stops; the next process finds it ended.
  await Promise.all([s.close(), Promise.resolve().then(() => gate.open())]);
  const again = await boot(s.root);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const after = await again.repository.getSession(session.sessionId);
  expect(after?.entries.find((e) => e.entryId === entry.entryId)).toMatchObject({
    state: 'queued',
    runId: null,
  });
  expect(
    again.server.coordinator.listRuns().filter((run) => run.sessionId === session.sessionId),
  ).toHaveLength(1);
  expect(first.runId).toBeTruthy();
});
