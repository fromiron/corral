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

it('serves only the primary conversation turn after final-body release behind the normal read boundary', async () => {
  const root = mkdtempSync(join(tmpdir(), 'corral-conversation-turn-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const gate = new Gate();
  const token = 'test-conversation-turn-0123456789abcdef';
  const server = await startCorralServer({
    workspace: join(root, 'workspace'),
    worktreeRoot: join(root, 'copies'),
    port: 0,
    bootstrapToken: token,
    agents: new ScriptedAgentAdapter({
      turns: 1,
      appendNotes: false,
      beforeReply: () => gate.wait(),
      reply: (_turn, input) =>
        `Answer: ${input.inputs.find((item) => item.name === 'brief')?.text}`,
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
  const start = (commandId: string, brief: string) => {
    const definition = linearCorral(['writer', 'editor']);
    definition.input.brief = brief;
    const result = server.coordinator.startRun({
      schemaVersion: '0.1',
      commandId,
      definition,
      mode: 'mock',
      sessionId: 'session_conversation',
    });
    if (!result.runId) throw new Error('fixture failed to start');
    return result.runId;
  };
  const first = start('cmd_first', 'First question');
  const address = `${server.url}/api/v1/runs/${first}/conversation-turn`;
  expect((await fetch(address)).status).toBe(401);
  expect((await call(address)).status).toBe(404);
  gate.open();
  const transport = new InProcessTransport(server.coordinator);
  const firstProjection = await waitForProjection(
    transport,
    first,
    (p) => p.status === 'succeeded',
  );
  const primaryId = firstProjection.output?.artifactVersionIds[0];
  if (!primaryId) throw new Error('fixture produced no answer');
  const answer = server.coordinator.getArtifactText(first, primaryId);
  const second = start('cmd_second', 'Second question');
  await waitForProjection(transport, second, (p) => p.status === 'succeeded');
  expect(server.coordinator.getArtifactText(first, primaryId)).toBeNull();
  const response = await call(address);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toContain('no-store');
  expect(await response.json()).toMatchObject({
    runId: first,
    request: 'First question',
    answer,
    artifactVersionId: primaryId,
  });
  const http = new HttpSseTransport({ baseUrl: server.url, fetch: call });
  expect((await http.getConversationTurn(first))?.answer).toBe(answer);
  const retiredBody = await call(
    `${server.url}/api/v1/runs/${first}/artifact-versions/${primaryId}`,
  );
  expect(retiredBody.status).toBe(200);
  expect(await retiredBody.json()).toEqual({ text: null, bodyAvailable: false });
  expect((await call(`${address}/${primaryId}`)).status).toBe(404);
  expect((await call(`${server.url}/api/v1/runs/missing/conversation-turn`)).status).toBe(404);
  expect(
    (await fetch(address, { headers: { cookie, origin: 'https://foreign.example' } })).status,
  ).toBe(403);
});
