import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpSseTransport } from '@corral/client';
import { InProcessTransport, waitForProjection } from '@corral/core';
import { Gate, linearCorral, ScriptedAgentAdapter } from '@corral/testkit';
import { afterEach, expect, it } from 'vitest';
import { startCorralServer } from '../src/index.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

it('returns explicit absence when a known live response is released before its HTTP read', async () => {
  const root = mkdtempSync(join(tmpdir(), 'corral-artifact-read-lifetime-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const gate = new Gate();
  const token = 'test-artifact-read-0123456789abcdef';
  const server = await startCorralServer({
    workspace: join(root, 'workspace'),
    worktreeRoot: join(root, 'copies'),
    port: 0,
    bootstrapToken: token,
    agents: new ScriptedAgentAdapter({
      turns: 2,
      beforeReply: (turn) => (turn === 2 ? gate.wait() : Promise.resolve()),
    }),
  });
  cleanup.push(() => server.close());
  cleanup.push(() => gate.open());
  const login = await fetch(`${server.url}/api/v1/session`, {
    method: 'POST',
    headers: { origin: server.url, 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const call: typeof fetch = (url, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set('cookie', cookie);
    headers.set('origin', server.url);
    return fetch(url, { ...init, headers });
  };
  const started = server.coordinator.startRun({
    schemaVersion: '0.1',
    commandId: 'cmd_lifetime',
    definition: linearCorral(['writer']),
    mode: 'mock',
  });
  if (!started.runId) throw new Error('fixture failed to start');
  const runId = started.runId;
  const transport = new InProcessTransport(server.coordinator);
  const active = await waitForProjection(transport, runId, (p) =>
    Object.values(p.modelCalls).some((model) => model.finished),
  );
  const responseRef = Object.values(active.modelCalls).find(
    (model) => model.responseRef,
  )?.responseRef;
  if (!responseRef) throw new Error('fixture did not finish its first model call');
  const address = `${server.url}/api/v1/runs/${runId}/artifact-versions/${responseRef}`;
  const available = await call(address);
  expect(available.status).toBe(200);
  expect((await available.json()).text).toEqual(expect.any(String));

  // The UI discovered this reference while active; the server can settle before its fetch arrives.
  gate.open();
  const settled = await waitForProjection(transport, runId, (p) => p.status === 'succeeded');
  const released = await call(address);
  expect(released.status).toBe(200);
  expect(await released.json()).toEqual({ text: null, bodyAvailable: false });
  const http = new HttpSseTransport({ baseUrl: server.url, fetch: call });
  expect(await http.getArtifactText(runId, responseRef)).toBeNull();
  const finalId = settled.output?.artifactVersionIds[0];
  if (!finalId) throw new Error('fixture produced no final result');
  expect(await http.getArtifactText(runId, finalId)).toEqual(expect.any(String));
  expect(
    (await call(`${server.url}/api/v1/runs/run_other/artifact-versions/${responseRef}`)).status,
  ).toBe(404);
  expect(
    (await call(`${server.url}/api/v1/runs/${runId}/artifact-versions/unknown_ref`)).status,
  ).toBe(404);
});
