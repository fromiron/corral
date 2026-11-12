import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RestCorralRepository, SessionCompactionApi } from '@corral/client';
import { ScriptedAgentAdapter } from '@corral/testkit';
import { afterEach, expect, it, vi } from 'vitest';
import { startCorralServer } from '../src/index.ts';

vi.setConfig({ testTimeout: 40_000 });
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

async function signedIn() {
  const root = mkdtempSync(join(tmpdir(), 'corral-session-compaction-'));
  const token = 'corral-session-compaction-fixture-0123456789abcdef';
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
  return {
    server,
    call,
    repository: new RestCorralRepository(options),
    compaction: new SessionCompactionApi(options),
  };
}

it('reads one command’s outcome without calling the model, and null for one never accepted', async () => {
  const { server, call, repository, compaction } = await signedIn();
  const created = await repository.createSession({ projectId: 'default', title: 'Idle' });
  assert(created.ok);
  const { sessionId, revision } = created.session;
  expect(await compaction.read(sessionId)).toEqual({ compaction: null, outcome: null });
  const refused = await compaction.compact({
    schemaVersion: '0.1',
    type: 'compact_session',
    commandId: 'cmd_compact',
    sessionId,
    expectedSessionRevision: revision,
  });
  expect(refused.status).toBe('rejected');
  expect(await compaction.read(sessionId, 'cmd_compact')).toEqual({
    compaction: null,
    outcome: null,
  });
  const invalid = await call(
    `${server.url}/api/v1/sessions/${sessionId}/compaction?commandId=${encodeURIComponent('not an id')}`,
  );
  expect(invalid.status).toBe(400);
  const missing = await call(`${server.url}/api/v1/sessions/session_missing/compaction`);
  expect(missing.status).toBe(404);
});
