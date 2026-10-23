import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linearCorral, ScriptedAgentAdapter } from '@corral/testkit';
import { expect, it } from 'vitest';
import { startCorralServer } from '../src/index.ts';

it('[TC-ULTRA-002-N] candidate reads preserve authentication, ordinary Runs and exact candidate scope', async () => {
  const root = mkdtempSync(join(tmpdir(), 'corral-candidate-routes-'));
  const token = 'test-bootstrap-token-0123456789abcdef';
  const server = await startCorralServer({
    workspace: root,
    worktreeRoot: join(root, 'copies'),
    port: 0,
    bootstrapToken: token,
    agents: new ScriptedAgentAdapter({ turns: 1 }),
  });
  try {
    const { runId } = server.coordinator.startRun({
      schemaVersion: '0.1',
      commandId: 'start_ordinary',
      definition: linearCorral(['writer']),
      mode: 'mock',
    });
    expect(runId).toBeTruthy();
    const path = `/api/v1/runs/${runId}/candidates`;
    expect((await fetch(`${server.url}${path}`)).status).toBe(401);
    const login = await fetch(`${server.url}/api/v1/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: server.url },
      body: JSON.stringify({ token }),
    });
    const headers = { cookie: (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '' };
    const get = (route: string) => fetch(`${server.url}${route}`, { headers });
    const ordinary = await get(path);
    expect(ordinary.status).toBe(200);
    expect(await ordinary.json()).toBeNull();
    expect((await get('/api/v1/runs/run_missing/candidates')).status).toBe(404);
    expect((await get(`${path}/candidate_missing/changes?tree=${'a'.repeat(40)}`)).status).toBe(
      404,
    );
    for (const query of ['tree=HEAD', `tree=${'a'.repeat(41)}`, `tree=${'a'.repeat(40)}&extra=yes`])
      expect((await get(`${path}/candidate_missing/changes?${query}`)).status).toBe(400);
    expect(
      (await get(`${path}/candidate_missing/files?tree=${'a'.repeat(40)}&path=../secret`)).status,
    ).toBe(400);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
