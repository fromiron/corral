import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RestCorralRepository, WorkspacesApi } from '@corral/client';
import { ScriptedAgentAdapter } from '@corral/testkit';
import { afterEach, expect, it, vi } from 'vitest';
import { startCorralServer } from '../src/index.ts';
import { FAKE_PROFILES, fakeOpenAI } from '../src/testing.ts';

// docs/specs/features/pull-requests.md 초안: the session's model writes the draft through the
// app's own wiring, and a fenced JSON answer is read.

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

it("drafts with the session's chosen model and reads a fenced answer", async () => {
  const root = mkdtempSync(join(tmpdir(), 'corral-pr-draft-'));
  const original = join(root, 'original');
  execFileSync('git', ['init', '-q', '-b', 'main', original]);
  writeFileSync(join(original, 'a.txt'), 'one\n');
  git(original, 'add', '.');
  git(original, 'commit', '-qm', 'first');
  git(original, 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git');
  git(original, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(original, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  const workspace = join(root, 'workspace');
  mkdirSync(join(workspace, '.corral'), { recursive: true });
  writeFileSync(
    join(workspace, '.corral', 'config.json'),
    JSON.stringify({ schemaVersion: '0.1', modelProfiles: FAKE_PROFILES }),
  );
  const fake = fakeOpenAI({
    configDir: join(root, 'config'),
    env: { OPENAI_API_KEY: 'local-fake-key' },
  });
  const token = 'pull-request-draft-fixture-0123456789';
  const server = await startCorralServer({
    workspace,
    worktreeRoot: join(root, 'copies'),
    bootstrapToken: token,
    agents: new ScriptedAgentAdapter({ turns: 1 }),
    port: 0,
    live: fake.live,
    gh: async () => ({ code: 0, stdout: '[]' }),
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
  const chosen = await repository.updateSession(made.session.sessionId, {
    auto: { modelProfile: 'model-b' },
    expectedRevision: made.session.revision,
  });
  assert(chosen.ok);
  const sessionId = made.session.sessionId;
  await workspaces.createWorktree(sessionId);
  const copy = join(root, 'copies', readdirSync(join(root, 'copies'))[0] ?? '', sessionId);
  writeFileSync(join(copy, 'b.txt'), 'b\n');
  git(copy, 'add', 'b.txt');
  git(copy, 'commit', '-qm', 'Fix the login check');

  fake.replyText(
    '```json\n{"title": "Reject empty user names at login", "body": "## Summary\\n\\n- Rejects empty names\\n\\n## Testing\\n\\n- Not run"}\n```',
  );
  const draft = await workspaces.pullRequestDraft(sessionId, { operationId: 'pr_draft_live' });
  expect(draft).toMatchObject({
    title: 'Reject empty user names at login',
    body: '## Summary\n\n- Rejects empty names\n\n## Testing\n\n- Not run',
    source: 'model',
  });
  const request = fake.seen.hostRequests.at(-1);
  expect(request?.model).toBe('gpt-test-b');
  expect(request?.text).toContain('Fix the login check');
  expect(request?.text).toContain('Head branch: corral/');
});
