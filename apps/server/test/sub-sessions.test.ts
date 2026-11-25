import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RestCorralRepository, WorkspacesApi } from '@corral/client';
import { ScriptedAgentAdapter } from '@corral/testkit';
import { afterEach, expect, it, vi } from 'vitest';
import { startCorralServer } from '../src/index.ts';

// docs/specs/features/sub-sessions.md over HTTP: opening from a Paddock, the start state, the
// command's idempotency and the parent-merge read.

vi.setConfig({ testTimeout: 40_000 });
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();
const short = (id: string) => createHash('sha256').update(id).digest('hex').slice(0, 6);

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'corral-sub-session-http-'));
  const original = join(root, 'original');
  execFileSync('git', ['init', '-q', original]);
  writeFileSync(join(original, '.gitignore'), '.env\n');
  for (const name of ['a.txt', 'd.txt']) writeFileSync(join(original, name), `${name}\n`);
  git(original, 'add', '.');
  git(original, 'commit', '-qm', 'first');
  const token = 'sub-sessions-http-fixture-0123456789abcdef';
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
  const created = await repository.createSession({ projectId: 'default', title: 'Login work' });
  assert(created.ok);
  const parent = created.session.sessionId;
  const open = (sessionId: string, body: { commandId: string; title: string }) =>
    call(`${server.url}/api/v1/sessions/${sessionId}/sub-sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const parentMerge = (sessionId: string) =>
    call(`${server.url}/api/v1/sessions/${sessionId}/parent-merge`);
  // The copies root holds one folder per binding; the fixture binds exactly one.
  const copy = (sessionId: string) =>
    join(root, 'copies', readdirSync(join(root, 'copies'))[0] ?? '', sessionId);
  return { root, original, repository, workspaces, parent, open, parentMerge, copy };
}

it('starts from the parent HEAD and its uncommitted files, leaving the parent as it was', async () => {
  const s = await setup();
  await s.workspaces.createWorktree(s.parent);
  const p = s.copy(s.parent);
  writeFileSync(join(p, 'b.txt'), 'b\n');
  git(p, 'add', 'b.txt');
  git(p, 'commit', '-qm', 'parent commit');
  writeFileSync(join(p, 'a.txt'), 'changed by parent\n');
  writeFileSync(join(p, 'c.txt'), 'staged\n');
  git(p, 'add', 'c.txt');
  unlinkSync(join(p, 'd.txt'));
  writeFileSync(join(p, 'u.txt'), 'untracked\n');
  writeFileSync(join(p, '.env'), 'SECRET=1\n');
  const head = git(p, 'rev-parse', 'HEAD');
  const status = git(p, 'status', '--porcelain');
  const checkpoints = (await s.workspaces.checkpoints(s.parent)).checkpoints.length;

  const response = await s.open(s.parent, { commandId: 'open_1', title: 'New conversation' });
  expect(response.status).toBe(201);
  const { sessionId } = (await response.json()) as { sessionId: string };
  const c = s.copy(sessionId);

  expect(git(c, 'rev-parse', 'HEAD')).toBe(head);
  expect(git(c, 'symbolic-ref', '--short', 'HEAD')).toBe(`corral/login-work-${short(sessionId)}`);
  expect(readFileSync(join(c, 'a.txt'), 'utf8')).toBe('changed by parent\n');
  expect(readFileSync(join(c, 'c.txt'), 'utf8')).toBe('staged\n');
  expect(existsSync(join(c, 'd.txt'))).toBe(false);
  expect(readFileSync(join(c, 'u.txt'), 'utf8')).toBe('untracked\n');
  expect(existsSync(join(c, '.env'))).toBe(false);
  expect(git(c, 'diff', '--cached', '--name-only')).toBe('');
  // The whole-session range starts at this state: the base ref is the copy's current tree.
  const index = join(s.root, 'probe-index');
  const env = { ...process.env, GIT_INDEX_FILE: index };
  execFileSync('git', ['read-tree', 'HEAD'], { cwd: c, env });
  execFileSync('git', ['add', '-A', '--', '.'], { cwd: c, env });
  const tree = execFileSync('git', ['write-tree'], { cwd: c, env, encoding: 'utf8' }).trim();
  expect(git(c, 'rev-parse', `refs/corral/${sessionId}/base`)).toBe(tree);

  expect(git(p, 'rev-parse', 'HEAD')).toBe(head);
  expect(git(p, 'status', '--porcelain')).toBe(status);
  expect((await s.workspaces.checkpoints(s.parent)).checkpoints.length).toBe(checkpoints);

  const sub = await s.repository.getSession(sessionId);
  const main = await s.repository.getSession(s.parent);
  expect(sub).toMatchObject({
    parentSessionId: s.parent,
    title: 'New conversation',
    autoTitle: true,
    corralId: main?.corralId,
  });
  expect(main?.parentSessionId).toBeNull();
});

it('returns the same sub-session for the same command and refuses a changed one', async () => {
  const s = await setup();
  await s.workspaces.createWorktree(s.parent);
  const first = await s.open(s.parent, { commandId: 'open_2', title: 'New conversation' });
  const again = await s.open(s.parent, { commandId: 'open_2', title: 'New conversation' });
  expect(again.status).toBe(200);
  const a = (await first.json()) as { sessionId: string };
  expect(await again.json()).toEqual(a);
  const changed = await s.open(s.parent, { commandId: 'open_2', title: 'Other' });
  expect(changed.status).toBe(409);
  expect(await changed.json()).toMatchObject({ error: { code: 'REVISION_CONFLICT' } });
  expect((await s.repository.listSessions('default')).length).toBe(2);
});

it('refuses a parent without a Paddock and makes no copy', async () => {
  const s = await setup();
  const refused = await s.open(s.parent, { commandId: 'open_3', title: 'New conversation' });
  expect(await refused.json()).toMatchObject({ error: { code: 'CAPABILITY_DENIED' } });
  expect(await s.workspaces.worktree(s.parent)).toBeNull();
  expect((await s.repository.listSessions('default')).length).toBe(1);
});

it('reads what a merge into the parent would take', async () => {
  const s = await setup();
  await s.workspaces.createWorktree(s.parent);
  const opened = await s.open(s.parent, { commandId: 'open_4', title: 'New conversation' });
  const { sessionId } = (await opened.json()) as { sessionId: string };
  const branch = `corral/login-work-${short(sessionId)}`;
  expect(await (await s.parentMerge(sessionId)).json()).toEqual({
    parentSessionId: s.parent,
    branch,
    commits: 0,
    parentPaddock: true,
  });
  const c = s.copy(sessionId);
  writeFileSync(join(c, 'e.txt'), 'e\n');
  git(c, 'add', 'e.txt');
  git(c, 'commit', '-qm', 'sub commit');
  expect(await (await s.parentMerge(sessionId)).json()).toMatchObject({ commits: 1 });
  await s.workspaces.removeWorktree(s.parent);
  expect(await (await s.parentMerge(sessionId)).json()).toMatchObject({
    commits: null,
    parentPaddock: false,
  });
  const main = await s.parentMerge(s.parent);
  expect(await main.json()).toMatchObject({ error: { code: 'TARGET_NOT_FOUND' } });
});

it('returns the same sub-session for its command after the sub-session was used', async () => {
  const s = await setup();
  await s.workspaces.createWorktree(s.parent);
  const body = { commandId: 'open_5', title: 'New conversation' };
  const { sessionId } = (await (await s.open(s.parent, body)).json()) as { sessionId: string };
  writeFileSync(join(s.copy(sessionId), 'work.txt'), 'sub work\n');
  const again = await s.open(s.parent, body);
  expect(again.status).toBe(200);
  expect(await again.json()).toEqual({ sessionId });
  expect(readFileSync(join(s.copy(sessionId), 'work.txt'), 'utf8')).toBe('sub work\n');
  const parent = await s.repository.getSession(s.parent);
  const archived = await s.repository.updateSession(s.parent, {
    archived: true,
    expectedRevision: parent?.revision ?? 0,
  });
  expect(archived.ok).toBe(true);
  expect((await s.open(s.parent, body)).status).toBe(200);
});
