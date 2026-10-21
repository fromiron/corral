import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RestCorralRepository, WorkspacesApi } from '@corral/client';
import type { GitDiff, GitDiffRequest, GitStatus, UserGitTarget } from '@corral/contracts';
import { ScriptedAgentAdapter } from '@corral/testkit';
import { afterEach, expect, it, vi } from 'vitest';
import { startCorralServer } from '../src/index.ts';

vi.setConfig({ testTimeout: 30_000 });
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', ...args],
    { cwd },
  );
const indexHash = (cwd: string) =>
  createHash('sha256')
    .update(git(cwd, 'ls-files', '--stage', '-z'))
    .digest('hex');
const diffQuery = (input: GitDiffRequest) =>
  new URLSearchParams({
    target: JSON.stringify(input.target),
    side: input.side,
    path: input.path,
    head: input.head ?? '',
    indexHash: input.indexHash,
  });

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'corral-user-git-http-'));
  const original = join(root, 'original');
  execFileSync('git', ['init', '-q', original]);
  git(original, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(original, 'a.txt'), 'base\n');
  git(original, 'add', '.');
  git(original, 'commit', '-qm', 'first');
  const token = 'user-git-http-fixture-0123456789abcdef';
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
  expect(login.status).toBe(204);
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
  const binding = await workspaces.bind('default', original);
  await workspaces.configure('default', { trusted: true });
  const copies: { sessionId: string; path: string; prefix: string; generation: number }[] = [];
  for (const name of ['A', 'B']) {
    const created = await repository.createSession({ projectId: 'default', title: `Git ${name}` });
    assert(created.ok);
    const sessionId = created.session.sessionId;
    const copy = await workspaces.createWorktree(sessionId);
    copies.push({
      sessionId,
      path: join(root, 'copies', binding.bindingId, sessionId),
      prefix: `/api/v1/sessions/${sessionId}/worktree/git`,
      generation: copy.copyGeneration,
    });
  }
  const prefix = '/api/v1/projects/default/workspace/git';
  const request = (path: string) => call(`${server.url}${path}`);
  const status = async (path: string): Promise<GitStatus> => {
    const result = await request(`${path}/status`);
    expect(result.status).toBe(200);
    return result.json();
  };
  const diff = async (path: string, input: GitDiffRequest): Promise<GitDiff> => {
    const result = await request(`${path}/diff?${diffQuery(input)}`);
    expect(result.status).toBe(200);
    return result.json();
  };
  return { root, original, prefix, copies, binding, request, status, diff };
}

it('[TC-WBD-008-H] discovers the original and two copies and reads each real index and worktree separately', async () => {
  const s = await fixture();
  const places = [
    { path: s.original, prefix: s.prefix, label: 'original' },
    ...s.copies.map((copy, index) => ({ ...copy, label: `copy-${index}` })),
  ];
  const targets: UserGitTarget[] = [];
  for (const place of places) {
    writeFileSync(join(place.path, 'a.txt'), `${place.label} index\n`);
    git(place.path, 'add', '--', 'a.txt');
    writeFileSync(join(place.path, 'a.txt'), `${place.label} worktree\n`);
    const view = await s.status(place.prefix);
    targets.push(view.target);
    expect(view.head.oid).toBe(git(place.path, 'rev-parse', 'HEAD').toString().trim());
    expect(view.indexHash).toBe(indexHash(place.path));
    expect(view.entries).toContainEqual(
      expect.objectContaining({ path: 'a.txt', indexStatus: 'M', worktreeStatus: 'M' }),
    );
    const common = {
      target: view.target,
      path: 'a.txt',
      head: view.head.oid,
      indexHash: view.indexHash,
    };
    expect(await s.diff(place.prefix, { ...common, side: 'staged' })).toMatchObject({
      kind: 'diff',
      target: view.target,
      before: { kind: 'text', text: 'base\n' },
      after: { kind: 'text', text: `${place.label} index\n` },
    });
    expect(await s.diff(place.prefix, { ...common, side: 'unstaged' })).toMatchObject({
      kind: 'diff',
      before: { kind: 'text', text: `${place.label} index\n` },
      after: { kind: 'text', text: `${place.label} worktree\n` },
    });
    expect(readFileSync(join(place.path, 'a.txt'), 'utf8')).toBe(`${place.label} worktree\n`);
    expect(indexHash(place.path)).toBe(view.indexHash);
  }
  expect(targets[0]).toMatchObject({
    kind: 'project',
    projectId: 'default',
    bindingId: s.binding.bindingId,
  });
  for (const [index, copy] of s.copies.entries())
    expect(targets[index + 1]).toMatchObject({
      kind: 'session',
      sessionId: copy.sessionId,
      bindingId: s.binding.bindingId,
      copyGeneration: copy.generation,
    });
  expect(new Set(targets.map((target) => JSON.stringify(target))).size).toBe(3);
});

it('[TC-WBD-008-N] refuses foreign target identities and a stale index without reading another copy', async () => {
  const s = await fixture();
  const copy = s.copies[0];
  assert(copy);
  const view = await s.status(copy.prefix);
  assert(view.target.kind === 'session');
  const request: GitDiffRequest = {
    target: view.target,
    side: 'staged',
    path: 'a.txt',
    head: view.head.oid,
    indexHash: view.indexHash,
  };
  for (const target of [
    { ...view.target, hostId: 'different-host' },
    { ...view.target, bindingId: 'different-binding' },
    { ...view.target, copyGeneration: view.target.copyGeneration + 1 },
  ]) {
    const response = await s.request(`${copy.prefix}/diff?${diffQuery({ ...request, target })}`);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'REVISION_CONFLICT' } });
  }
  writeFileSync(join(copy.path, 'a.txt'), 'new staged content\n');
  git(copy.path, 'add', '--', 'a.txt');
  const stale = await s.request(`${copy.prefix}/diff?${diffQuery(request)}`);
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ error: { code: 'REVISION_CONFLICT' } });
  expect(readFileSync(join(s.original, 'a.txt'), 'utf8')).toBe('base\n');
  expect(readFileSync(join(copy.path, 'a.txt'), 'utf8')).toBe('new staged content\n');
});

it('[TC-WBD-008-F] rejects malformed queries and traversal while preserving an encoded Unicode/newline path', async () => {
  const s = await fixture();
  const path = "공백 이름\n'quoted'.txt";
  writeFileSync(join(s.original, path), 'untracked UTF-8\n');
  writeFileSync(join(s.root, 'outside.txt'), 'outside secret fixture\n');
  const view = await s.status(s.prefix);
  expect(view.entries).toContainEqual(expect.objectContaining({ kind: 'untracked', path }));
  const request: GitDiffRequest = {
    target: view.target,
    side: 'untracked',
    path,
    head: view.head.oid,
    indexHash: view.indexHash,
  };
  expect(await s.diff(s.prefix, request)).toMatchObject({
    kind: 'diff',
    path,
    before: { kind: 'absent' },
    after: { kind: 'text', text: 'untracked UTF-8\n' },
  });
  for (const patch of [{ target: '{' }, { side: 'invalid' }, { indexHash: 'invalid' }]) {
    const query = diffQuery(request);
    for (const [name, value] of Object.entries(patch)) query.set(name, value);
    const response = await s.request(`${s.prefix}/diff?${query}`);
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('outside secret fixture');
  }
  const traversal = await s.request(
    `${s.prefix}/diff?${diffQuery({ ...request, path: '../outside.txt' })}`,
  );
  expect(traversal.status).toBe(403);
  const traversalError = await traversal.json();
  expect(traversalError).toMatchObject({ error: { code: 'CAPABILITY_DENIED' } });
  expect(JSON.stringify(traversalError)).not.toContain('outside secret fixture');
  expect((await s.request(`${s.prefix}/status?unknown=true`)).status).toBe(400);
});

it('[TC-WBD-008-F] refuses parent repository discovery after the bound original loses its Git root', async () => {
  const s = await fixture();
  git(s.root, 'init', '-q');
  writeFileSync(join(s.root, 'parent.txt'), 'parent repository must stay separate\n');
  git(s.root, 'add', '--', 'parent.txt');
  git(s.root, 'commit', '-qm', 'parent');
  renameSync(join(s.original, '.git'), join(s.root, 'original-git-backup'));
  const response = await s.request(`${s.prefix}/status`);
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: 'REVISION_CONFLICT' } });
});
