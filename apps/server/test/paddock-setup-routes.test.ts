import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RestCorralRepository, WorkspacesApi } from '@corral/client';
import { ScriptedAgentAdapter } from '@corral/testkit';
import { afterEach, expect, it, vi } from 'vitest';
import { startCorralServer } from '../src/index.ts';

vi.setConfig({ testTimeout: 40_000 });
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

it('a setup command saved over HTTP runs in a new copy, runs again on request and stops', async () => {
  const root = mkdtempSync(join(tmpdir(), 'corral-setup-http-'));
  const original = join(root, 'original');
  execFileSync('git', ['init', '-q', original]);
  writeFileSync(join(original, 'a.txt'), 'one\n');
  execFileSync('git', ['add', '.'], { cwd: original });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'first'], {
    cwd: original,
  });
  const token = 'paddock-setup-http-fixture-0123456789ab';
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
  const saved = await workspaces.configure('default', {
    setupCommand: 'echo set up here\ntouch ran.txt',
    setupRevision: 0,
  });
  expect(saved).toMatchObject({
    setupCommand: 'echo set up here\ntouch ran.txt',
    setupRevision: 1,
  });
  await expect(
    workspaces.configure('default', { setupCommand: 'npm ci', setupRevision: 0 }),
  ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });

  const created = await repository.createSession({ projectId: 'default', title: 'Setup' });
  assert(created.ok);
  const sessionId = created.session.sessionId;
  const copy = await workspaces.createWorktree(sessionId);
  expect(copy.setup).toMatchObject({ state: expect.stringMatching(/running|succeeded/) });
  const done = await vi.waitFor(
    async () => {
      const setup = (await workspaces.worktree(sessionId))?.setup;
      expect(setup?.state).toBe('succeeded');
      return setup;
    },
    { timeout: 15_000 },
  );
  const path = join(root, 'copies', copy.bindingId, sessionId);
  expect(existsSync(join(path, 'ran.txt'))).toBe(true);
  const detail = await workspaces.setup(sessionId, done?.operationId ?? '');
  expect(detail.output.text).toContain('set up here');
  expect(detail.target).toMatchObject({ sessionId, copyGeneration: copy.copyGeneration });

  await workspaces.configure('default', { setupCommand: 'sleep 30', setupRevision: 1 });
  const target = detail.target;
  const again = await workspaces.startSetup(sessionId, { operationId: 'setup_http', target });
  expect(again).toMatchObject({ operationId: 'setup_http', state: 'running' });
  await expect(
    workspaces.startSetup(sessionId, {
      operationId: 'setup_http_stale',
      target: { ...target, copyGeneration: target.copyGeneration + 1 },
    }),
  ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  expect(await workspaces.stopSetup(sessionId, 'setup_http', target)).toMatchObject({
    state: 'cancelled',
    reason: 'stopped',
  });
  await expect(workspaces.setup('another_session', 'setup_http')).rejects.toMatchObject({
    code: 'TARGET_NOT_FOUND',
  });
});
