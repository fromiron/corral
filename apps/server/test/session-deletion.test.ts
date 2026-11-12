import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RestCorralRepository, WorkspacesApi } from '@corral/client';
import type { WorkSession } from '@corral/core';
import { openDatabase } from '@corral/storage-sqlite';
import { ScriptedAgentAdapter } from '@corral/testkit';
import { afterEach, expect, it, vi } from 'vitest';
import { startCorralServer } from '../src/index.ts';
import { ScheduleService } from '../src/schedules/service.ts';
import { ScheduleStore } from '../src/schedules/store.ts';

// Lets a test make the final record delete refuse, as a run that started after the checks would.
const storage = vi.hoisted(() => ({ refuseOnce: false }));
vi.mock('@corral/storage-sqlite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@corral/storage-sqlite')>();
  return {
    ...actual,
    deleteSessionRecords: (...args: Parameters<typeof actual.deleteSessionRecords>) => {
      if (!storage.refuseOnce) return actual.deleteSessionRecords(...args);
      storage.refuseOnce = false;
      return { ok: false, error: 'unfinished', runIds: ['run_late'] };
    },
  };
});

const require = createRequire(
  new URL('../../../packages/storage-sqlite/package.json', import.meta.url),
);
const Database = require('better-sqlite3') as new (
  path: string,
) => {
  prepare(sql: string): { run(...args: unknown[]): unknown };
  close(): void;
};

vi.setConfig({ testTimeout: 40_000 });
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
  vi.restoreAllMocks();
  storage.refuseOnce = false;
});

async function signedIn(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const token = `${prefix}fixture-0123456789abcdef0123`;
  const server = await startCorralServer({
    workspace: join(root, 'workspace'),
    worktreeRoot: join(root, 'copies'),
    bootstrapToken: token,
    agents: new ScriptedAgentAdapter({ turns: 1 }),
    port: 0,
  });
  cleanups.push(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });
  const login = await fetch(`${server.url}/api/v1/session`, {
    method: 'POST',
    headers: { origin: server.url, 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const call: typeof fetch = (url, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set('origin', server.url);
    headers.set('cookie', cookie);
    headers.set('x-corral-csrf', login.headers.get('x-corral-csrf') ?? '');
    return fetch(url, { ...init, headers });
  };
  return {
    root,
    server,
    call,
    repository: new RestCorralRepository({ baseUrl: server.url, fetch: call }),
  };
}

it('deletes a session only after the confirmed copy generation, and a repeat is done', async () => {
  const root = mkdtempSync(join(tmpdir(), 'corral-session-delete-'));
  const original = join(root, 'original');
  execFileSync('git', ['init', '-q', original]);
  writeFileSync(join(original, 'a.txt'), 'one\n');
  execFileSync('git', ['add', '.'], { cwd: original });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'first'], {
    cwd: original,
  });
  const token = 'session-deletion-http-fixture-0123456789ab';
  const server = await startCorralServer({
    workspace: join(root, 'workspace'),
    worktreeRoot: join(root, 'copies'),
    bootstrapToken: token,
    agents: new ScriptedAgentAdapter({ turns: 1 }),
    port: 0,
  });
  cleanups.push(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });
  const login = await fetch(`${server.url}/api/v1/session`, {
    method: 'POST',
    headers: { origin: server.url, 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const call: typeof fetch = (url, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set('origin', server.url);
    headers.set('cookie', cookie);
    headers.set('x-corral-csrf', login.headers.get('x-corral-csrf') ?? '');
    return fetch(url, { ...init, headers });
  };
  const options = { baseUrl: server.url, fetch: call };
  const repository = new RestCorralRepository(options);
  const workspaces = new WorkspacesApi(options);
  await workspaces.bind('default', original);
  await workspaces.configure('default', { trusted: true });
  const created = await repository.createSession({ projectId: 'default', title: 'Gone' });
  const other = await repository.createSession({ projectId: 'default', title: 'Stays' });
  assert(created.ok && other.ok);
  const sessionId = created.session.sessionId;
  await workspaces.createWorktree(sessionId);
  const binding = readdirSync(join(root, 'copies')).find((name) => name !== 'checks');
  assert(binding);
  const copy = join(root, 'copies', binding, sessionId);
  writeFileSync(join(copy, 'dirty.txt'), 'dirty\n');
  const preview = await call(`${server.url}/api/v1/sessions/${sessionId}/deletion`);
  expect(preview.status).toBe(200);
  const body = (await preview.json()) as {
    revision: number;
    runs: number;
    workingCopy: { copyGeneration: number; git: { untracked: number } | null } | null;
  };
  expect(body.revision).toBe(created.session.revision);
  expect(body.workingCopy?.copyGeneration).toBe(1);
  expect(body.workingCopy?.git?.untracked).toBeGreaterThan(0);
  const remove = (payload: unknown) =>
    call(`${server.url}/api/v1/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  const missingGeneration = await remove({ expectedRevision: body.revision });
  expect(missingGeneration.status).toBe(409);
  expect(((await missingGeneration.json()) as { error: { code: string } }).error.code).toBe(
    'REVISION_CONFLICT',
  );
  expect(existsSync(join(copy, 'dirty.txt'))).toBe(true);
  const wrongGeneration = await remove({ expectedRevision: body.revision, copyGeneration: 9 });
  expect(wrongGeneration.status).toBe(409);
  expect(existsSync(join(copy, 'dirty.txt'))).toBe(true);
  const db = new Database(join(root, 'workspace', '.corral', 'corral.db'));
  db.prepare(
    `INSERT INTO workspace_access
       (owner_kind, owner_id, session_id, worktree_key, copy_generation, writer, state, tree)
     VALUES ('user', 'op_hold', ?, ?, 1, 0, 'active', NULL)`,
  ).run(sessionId, realpathSync(copy));
  db.close();
  const held = await remove({ expectedRevision: body.revision, copyGeneration: 1 });
  expect(held.status, await held.clone().text()).toBe(409);
  expect((await repository.getSession(sessionId))?.sessionId).toBe(sessionId);
  expect(existsSync(join(copy, 'dirty.txt'))).toBe(true);
  const release = new Database(join(root, 'workspace', '.corral', 'corral.db'));
  release.prepare("DELETE FROM workspace_access WHERE owner_id='op_hold'").run();
  release.close();
  const removed = await remove({ expectedRevision: body.revision, copyGeneration: 1 });
  expect(removed.status, await removed.text()).toBe(204);
  expect(existsSync(copy)).toBe(false);
  expect(await repository.getSession(sessionId)).toBeNull();
  expect((await repository.getSession(other.session.sessionId))?.title).toBe('Stays');
  const again = await remove({ expectedRevision: body.revision, copyGeneration: 1 });
  expect(again.status).toBe(404);
  await repository.deleteSession(sessionId, { expectedRevision: body.revision, copyGeneration: 1 });
  await expect(
    repository.deleteSession(other.session.sessionId, { expectedRevision: body.revision + 1 }),
  ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  expect((await repository.getSession(other.session.sessionId))?.title).toBe('Stays');
});

it('refuses to delete a session while one of its runs is unfinished', async () => {
  const root = mkdtempSync(join(tmpdir(), 'corral-session-open-'));
  const token = 'session-deletion-open-run-fixture-0123456789';
  const server = await startCorralServer({
    workspace: join(root, 'workspace'),
    worktreeRoot: join(root, 'copies'),
    bootstrapToken: token,
    agents: new ScriptedAgentAdapter({ turns: 1 }),
    port: 0,
  });
  cleanups.push(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });
  const login = await fetch(`${server.url}/api/v1/session`, {
    method: 'POST',
    headers: { origin: server.url, 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const call: typeof fetch = (url, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set('origin', server.url);
    headers.set('cookie', cookie);
    headers.set('x-corral-csrf', login.headers.get('x-corral-csrf') ?? '');
    return fetch(url, { ...init, headers });
  };
  const repository = new RestCorralRepository({ baseUrl: server.url, fetch: call });
  const created = await repository.createSession({ projectId: 'default', title: 'Busy' });
  assert(created.ok);
  const db = new Database(join(root, 'workspace', '.corral', 'corral.db'));
  db.prepare(
    `INSERT INTO runs
       (id, corral_id, definition_hash, snapshot_json, status, last_seq, projection_json,
        started_at, project_id, session_id)
     VALUES ('run_open', 'corral', 'hash', '{}', 'running', 0, '{}', ?, 'default', ?)`,
  ).run('2026-11-12T00:00:00.000Z', created.session.sessionId);
  db.close();
  const refused = await call(`${server.url}/api/v1/sessions/${created.session.sessionId}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: created.session.revision }),
  });
  expect(refused.status).toBe(409);
  expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
    'RUN_ALREADY_ACTIVE',
  );
  expect((await repository.getSession(created.session.sessionId))?.title).toBe('Busy');
});

it('a delete refused at the record step leaves the session’s schedule dispatches alone', async () => {
  const released: string[] = [];
  const original = ScheduleService.prototype.sessionDispatches;
  vi.spyOn(ScheduleService.prototype, 'sessionDispatches').mockImplementation(function (
    this: ScheduleService,
    sessionId: string,
  ) {
    const release = original.call(this, sessionId);
    return () => {
      released.push(sessionId);
      release();
    };
  });
  const { server, call, repository } = await signedIn('corral-session-late-');
  const created = await repository.createSession({ projectId: 'default', title: 'Scheduled' });
  assert(created.ok);
  const { sessionId, revision } = created.session;
  const remove = () =>
    call(`${server.url}/api/v1/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: revision }),
    });
  storage.refuseOnce = true;
  const refused = await remove();
  expect(refused.status).toBe(409);
  expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
    'RUN_ALREADY_ACTIVE',
  );
  expect(released).toEqual([]);
  expect((await repository.getSession(sessionId))?.title).toBe('Scheduled');
  expect((await remove()).status).toBe(204);
  expect(released).toEqual([sessionId]);
});

it('releasing a session aborts only its schedules’ in-flight dispatches', async () => {
  const root = mkdtempSync(join(tmpdir(), 'corral-session-dispatch-'));
  const db = openDatabase(join(root, 'corral.db'));
  cleanups.push(async () => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const session = (sessionId: string) =>
    ({ sessionId, projectId: 'default', corralId: null, archivedAt: null }) as WorkSession;
  const signals = new Map<string, AbortSignal>();
  let ids = 0;
  const service = new ScheduleService(new ScheduleStore(db), {
    now: () => '2026-11-12T00:00:00.000Z',
    id: () => `schedule_${++ids}`,
    repository: {
      getSession: async (sessionId: string) => session(sessionId),
      addSessionEntry: async (sessionId: string) => ({ ok: true, session: session(sessionId) }),
    },
    start: (request, signal) => {
      signals.set(request.sessionId ?? '', signal);
      return new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason)),
      );
    },
    previous: () => null,
    isRunActive: () => false,
  });
  const scheduleFor = (sessionId: string) =>
    service.create({
      title: sessionId,
      hostId: 'local',
      projectId: 'default',
      sessionId,
      timezone: 'UTC',
      rule: { kind: 'daily', time: '09:00' },
      enabled: true,
      request: {
        brief: 'Check the changes.',
        choice: { modelProfile: 'simulated' },
        mode: 'mock',
        permissionMode: 'ask',
        configRevision: 1,
      },
    });
  const gone = await scheduleFor('session_gone');
  const stays = await scheduleFor('session_stays');
  const running = [
    service.runNow(gone.id, gone.revision, 'cmd_gone'),
    service.runNow(stays.id, stays.revision, 'cmd_stays'),
  ];
  await vi.waitFor(() => expect(signals.size).toBe(2));
  const release = service.sessionDispatches('session_gone');
  expect(signals.get('session_gone')?.aborted).toBe(false);
  release();
  expect(signals.get('session_gone')?.aborted).toBe(true);
  expect(signals.get('session_stays')?.aborted).toBe(false);
  await running[0];
  service.sessionDispatches('session_stays')();
  await running[1];
});
