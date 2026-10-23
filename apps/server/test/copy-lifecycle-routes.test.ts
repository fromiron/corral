import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RestCorralRepository, WorkspacesApi } from '@corral/client';
import { ScriptedAgentAdapter } from '@corral/testkit';
import { afterEach, expect, it, vi } from 'vitest';
import { startCorralServer } from '../src/index.ts';

// CR-046 P21-A: archiving keeps the copy; removing it is shown first and pinned to its generation.
vi.setConfig({ testTimeout: 40_000 });
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

it('[TC-WBD-016-H] [TC-WBD-016-N] archiving keeps the copy, and a removal for an old generation is refused over HTTP', async () => {
  const root = mkdtempSync(join(tmpdir(), 'corral-copy-life-'));
  const original = join(root, 'original');
  execFileSync('git', ['init', '-q', original]);
  writeFileSync(join(original, 'a.txt'), 'one\n');
  execFileSync('git', ['add', '.'], { cwd: original });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'first'], {
    cwd: original,
  });
  const token = 'copy-lifecycle-http-fixture-0123456789ab';
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
  const created = await repository.createSession({ projectId: 'default', title: 'Copy' });
  assert(created.ok);
  const sessionId = created.session.sessionId;
  await workspaces.createWorktree(sessionId);
  const archived = await repository.updateSession(sessionId, {
    archived: true,
    expectedRevision: created.session.revision,
  });
  assert(archived.ok);
  const copy = await workspaces.worktree(sessionId);
  expect(copy).toMatchObject({ copyGeneration: 1, missing: false });
  const plan = await workspaces.removalPlan(sessionId);
  expect(plan).toMatchObject({ copyGeneration: 1, git: { staged: 0, untracked: 0 }, owners: [] });
  await workspaces.removeWorktree(sessionId, 1);
  await workspaces.createWorktree(sessionId);
  await expect(workspaces.removeWorktree(sessionId, 1)).rejects.toMatchObject({
    code: 'REVISION_CONFLICT',
  });
  const again = await workspaces.worktree(sessionId);
  expect(again).toMatchObject({ copyGeneration: 2, missing: false });
  expect(existsSync(join(root, 'copies'))).toBe(true);
});
