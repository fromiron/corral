import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
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

const freePort = () =>
  new Promise<number>((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });

it('[TC-WBD-011-H] a task started over HTTP is previewed through its owned port, then stopped', async () => {
  const root = mkdtempSync(join(tmpdir(), 'corral-task-http-'));
  const original = join(root, 'original');
  execFileSync('git', ['init', '-q', original]);
  const port = await freePort();
  writeFileSync(
    join(original, 'package.json'),
    JSON.stringify({ scripts: { dev: 'node server.js' } }),
  );
  writeFileSync(
    join(original, 'server.js'),
    `require('http').createServer((q,s)=>{s.setHeader('content-type','text/html');s.end('<h1>hello from task</h1>')}).listen(${port},'127.0.0.1',()=>console.log('ready'));\n`,
  );
  execFileSync('git', ['add', '.'], { cwd: original });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'first'], {
    cwd: original,
  });
  const token = 'user-tasks-http-fixture-0123456789abcdef';
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
  const created = await repository.createSession({ projectId: 'default', title: 'Tasks' });
  assert(created.ok);
  const sessionId = created.session.sessionId;
  await workspaces.createWorktree(sessionId);
  const document = await workspaces.readDocument(sessionId, 'server.js');

  const listed = await workspaces.tasks(sessionId);
  expect(listed.candidates.scripts).toEqual([{ name: 'dev', command: 'node server.js' }]);
  expect(listed.tasks).toEqual([]);
  const task = await workspaces.startTask(sessionId, {
    operationId: 'task_http',
    target: document.target,
    script: 'dev',
  });
  expect(task).toMatchObject({ state: 'running', script: 'dev' });
  await vi.waitFor(
    async () =>
      expect((await workspaces.taskOutput(sessionId, 'task_http')).text).toContain('ready'),
    { timeout: 15_000 },
  );
  const preview = await call(`${server.url}/api/v1/sessions/${sessionId}/previews`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operationId: 'task_http', port }),
  });
  expect(preview.status).toBe(201);
  const view = (await preview.json()) as { leaseId: string; url: string; state: string };
  expect(view.state).toBe('ready');
  // The proxy answers only the preview's own credential, as the Studio frame sends it.
  expect((await fetch(view.url)).status).toBe(403);
  const delegation = (await (
    await call(`${server.url}/api/v1/sessions/${sessionId}/previews/${view.leaseId}/delegations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
  ).json()) as { target: { url: string; headers: Record<string, string> } };
  expect(
    await (await fetch(delegation.target.url, { headers: delegation.target.headers })).text(),
  ).toContain('hello from task');
  expect(await workspaces.stopTask(sessionId, 'task_http')).toMatchObject({ state: 'cancelled' });
});
