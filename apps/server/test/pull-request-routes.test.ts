import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RestCorralRepository, WorkspacesApi } from '@corral/client';
import { ScriptedAgentAdapter } from '@corral/testkit';
import { afterEach, expect, it, vi } from 'vitest';
import { startCorralServer } from '../src/index.ts';
import type { GhResult } from '../src/pull-requests/gh.ts';

// docs/specs/features/pull-requests.md over HTTP, with an injected gh and no model.

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

it('reads the row, drafts from the commits and opens a PR once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'corral-pr-http-'));
  const original = join(root, 'original');
  execFileSync('git', ['init', '-q', '-b', 'main', original]);
  writeFileSync(join(original, 'a.txt'), 'one\n');
  git(original, 'add', '.');
  git(original, 'commit', '-qm', 'first');
  git(original, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  git(original, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(original, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  const created: string[][] = [];
  let open: unknown[] = [];
  const gh = async (args: string[]): Promise<GhResult> => {
    if (args[1] === 'list') return { code: 0, stdout: JSON.stringify(open) };
    if (args[1] === 'create') {
      created.push(args);
      open = [
        {
          number: 21,
          url: 'https://github.com/acme/widgets/pull/21',
          state: 'OPEN',
          isDraft: false,
          title: args[args.indexOf('--title') + 1],
          headRefOid: 'f'.repeat(40),
          baseRefName: 'main',
          updatedAt: '2026-11-25T00:00:00Z',
          statusCheckRollup: [],
          reviewDecision: '',
          mergeable: 'MERGEABLE',
        },
      ];
      return { code: 0, stdout: 'https://github.com/acme/widgets/pull/21\n' };
    }
    return { code: 1, stdout: '' };
  };
  const token = 'pull-request-http-fixture-0123456789abcdef';
  const server = await startCorralServer({
    workspace: join(root, 'workspace'),
    worktreeRoot: join(root, 'copies'),
    bootstrapToken: token,
    agents: new ScriptedAgentAdapter({ turns: 1 }),
    port: 0,
    gh,
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
  const made = await repository.createSession({ projectId: 'default', title: 'Login fix' });
  assert(made.ok);
  const sessionId = made.session.sessionId;
  await workspaces.createWorktree(sessionId);
  const copy = join(root, 'copies', readdirSync(join(root, 'copies'))[0] ?? '', sessionId);
  writeFileSync(join(copy, 'b.txt'), 'b\n');
  git(copy, 'add', 'b.txt');
  git(copy, 'commit', '-qm', 'Fix the login check');
  const head = git(copy, 'rev-parse', 'HEAD');
  const branch = git(copy, 'symbolic-ref', '--short', 'HEAD');

  expect(await workspaces.pullRequest(sessionId, true)).toMatchObject({
    kind: 'none',
    branch,
    base: 'main',
    action: 'push_and_open',
  });
  const draft = await workspaces.pullRequestDraft(sessionId, { operationId: 'pr_draft_1' });
  expect(draft).toMatchObject({
    title: 'Fix the login check',
    head: { branch, commit: head },
    source: 'commits',
  });
  const request = {
    operationId: 'pr_open_1',
    title: 'Fix the login check',
    body: draft.body,
    head: { branch, commit: head },
  };
  expect(await workspaces.openPullRequest(sessionId, request)).toMatchObject({
    pr: { number: 21, state: 'open' },
  });
  expect(await workspaces.openPullRequest(sessionId, request)).toMatchObject({
    pr: { number: 21 },
  });
  expect(created).toHaveLength(1);
  expect(await workspaces.pullRequest(sessionId, false)).toMatchObject({
    kind: 'open',
    pr: { number: 21 },
  });
  expect(await workspaces.pullRequest(sessionId, true)).toMatchObject({
    kind: 'open',
    pr: { number: 21 },
  });
  await expect(
    workspaces.openPullRequest(sessionId, {
      ...request,
      operationId: 'pr_open_2',
      head: { branch, commit: '0'.repeat(40) },
    }),
  ).rejects.toThrow(/moved/);
});
