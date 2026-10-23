import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RestCorralRepository, WorkspacesApi } from '@corral/client';
import { ScriptedAgentAdapter } from '@corral/testkit';
import { afterEach, expect, it, vi } from 'vitest';
import { startCorralServer } from '../src/index.ts';

// Language sessions use the existing authenticated session and exact target boundary.
vi.setConfig({ testTimeout: 40_000 });
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

it('[TC-WBD-018-N] [TC-WBD-019-H] [TC-WBD-021-H] [TC-WBD-021-N] [TC-WBD-023-N] [TC-WBD-024-N] workbench HTTP endpoints preserve the managed-copy boundary', async () => {
  const root = mkdtempSync(join(tmpdir(), 'corral-language-http-'));
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
    allowSharedDevelopment: true,
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
  const state = await workspaces.languageState(sessionId);
  expect(state).toMatchObject({
    available: process.platform === 'linux',
    session: null,
    servers: [],
  });
  await expect(
    workspaces.inspectLanguage(sessionId, {
      target: { ...state.target, hostId: 'other' },
      serverId: 'ts',
    }),
  ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  const invalid = await call(
    `${server.url}/api/v1/sessions/${sessionId}/worktree/language/document`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: { kind: 'project', projectId: 'default' } }),
    },
  );
  expect(invalid.status).toBe(400);
  expect((await fetch(`${server.url}/api/v1/sessions/${sessionId}/worktree/language`)).status).toBe(
    401,
  );
  const searched = await call(
    `${server.url}/api/v1/sessions/${sessionId}/worktree/search-contents`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: state.target, queryId: 'search_http', query: 'one' }),
    },
  );
  expect(searched.status).toBe(200);
  expect(await searched.json()).toMatchObject({
    queryId: 'search_http',
    matches: [{ path: 'a.txt', range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 4 } }],
  });
  const edits = `${server.url}/api/v1/sessions/${sessionId}/worktree/edit-proposals`;
  const post = (url: string, body: unknown) =>
    call(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const preview = await post(edits, {
    kind: 'replace',
    target: state.target,
    requestId: 'replace_http',
    query: 'one',
    replacement: 'two',
  });
  expect(preview.status).toBe(200);
  const {
    proposals: [proposal],
  } = await preview.json();
  expect(proposal.files).toMatchObject([{ path: 'a.txt', before: 'one\n', after: 'two\n' }]);
  expect((await workspaces.readDocument(sessionId, 'a.txt')).content).toMatchObject({
    text: 'one\n',
  });
  expect((await fetch(edits)).status).toBe(401);
  expect((await post(edits, { kind: 'replace' })).status).toBe(400);
  const request = { operationId: 'apply_http', target: state.target, proposalHash: proposal.hash };
  const wrong = await post(`${edits}/${proposal.proposalId}/apply`, {
    ...request,
    target: { ...state.target, sessionId: 'another_session' },
  });
  expect(wrong.status).toBe(400);
  const applied = await post(`${edits}/${proposal.proposalId}/apply`, request);
  expect(applied.status).toBe(200);
  expect(await applied.json()).toMatchObject({ operationId: 'apply_http', state: 'succeeded' });
  expect(await (await post(`${edits}/${proposal.proposalId}/apply`, request)).json()).toMatchObject(
    {
      operationId: 'apply_http',
      state: 'succeeded',
    },
  );
  expect((await workspaces.readDocument(sessionId, 'a.txt')).content).toMatchObject({
    text: 'two\n',
  });
  const receipt = await call(
    `${server.url}/api/v1/sessions/${sessionId}/worktree/edit-operations/apply_http`,
  );
  expect(await receipt.json()).toMatchObject({ operationId: 'apply_http', state: 'succeeded' });
  const debug = `${server.url}/api/v1/sessions/${sessionId}/worktree/debug`;
  const debugState = await call(debug);
  expect(debugState.status).toBe(200);
  expect(await debugState.json()).toMatchObject({
    target: state.target,
    configurations: [],
    session: null,
  });
  expect((await fetch(debug)).status).toBe(401);
  expect(
    (
      await post(`${debug}/inspect`, {
        target: { ...state.target, sessionId: 'foreign' },
        configId: 'node',
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await post(`${debug}/inspect`, {
        target: { ...state.target, hostId: 'foreign' },
        configId: 'node',
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await post(`${debug}/start`, {
        target: state.target,
        processId: 1,
        url: 'http://localhost:9222',
      })
    ).status,
  ).toBe(400);
  const deployments = `${server.url}/api/v1/sessions/${sessionId}/worktree/deployments`;
  const listing = await call(deployments);
  expect(listing.status).toBe(200);
  expect(await listing.json()).toMatchObject({ profiles: [], deployments: [] });
  expect((await fetch(deployments)).status).toBe(401);
  expect(
    (
      await post(`${deployments}/inspect`, {
        target: { ...state.target, sessionId: 'foreign' },
        profileId: 'preview',
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await post(deployments, {
        target: state.target,
        operationId: 'deploy_http',
        profileId: 'preview',
      })
    ).status,
  ).toBe(400);
});
