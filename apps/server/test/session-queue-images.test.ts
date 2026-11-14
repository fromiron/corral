import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpSseTransport, RestCorralRepository } from '@corral/client';
import type { ImageAttachment } from '@corral/contracts';
import { type SessionEntryStart, waitForProjection } from '@corral/core';
import { ScriptedAgentAdapter } from '@corral/testkit';
import { afterEach, expect, it } from 'vitest';
import { type CorralServer, startCorralServer } from '../src/index.ts';
import { FAKE_PROFILES, fakeOpenAI } from '../src/testing.ts';

// A queued request's images are read from its own session when the server starts it: an image
// another session saved is not carried into the run (features/composer-flow.md "합류 대상").

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWP4z8DwHwAFAAH/e+m+7wAAAABJRU5ErkJggg==';
const TOKEN = 'test-queue-images-0123456789abcdef0';
const START: SessionEntryStart = {
  choice: { modelProfile: 'model-a' },
  mode: 'live',
  team: 'none',
};

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function boot() {
  const root = mkdtempSync(join(tmpdir(), 'corral-queue-images-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  mkdirSync(join(workspace, '.corral'), { recursive: true });
  writeFileSync(
    join(workspace, '.corral', 'config.json'),
    JSON.stringify({ schemaVersion: '0.1', modelProfiles: FAKE_PROFILES }),
  );
  const fake = fakeOpenAI({ configDir: join(root, 'config'), codexLogin: {}, imageInput: true });
  const server: CorralServer = await startCorralServer({
    workspace,
    port: 0,
    bootstrapToken: TOKEN,
    worktreeRoot: join(root, 'worktrees'),
    agents: new ScriptedAgentAdapter({ turns: 1 }),
    live: fake.live,
  });
  cleanup.push(() => server.close());
  const login = await fetch(`${server.url}/api/v1/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: server.url },
    body: JSON.stringify({ token: TOKEN }),
  });
  const call: typeof fetch = (input, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set('cookie', (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '');
    headers.set('x-corral-csrf', login.headers.get('x-corral-csrf') ?? '');
    headers.set('origin', server.url);
    if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
    return fetch(input, { ...init, headers });
  };
  const repository = new RestCorralRepository({ baseUrl: server.url, fetch: call });
  const transport = new HttpSseTransport({ baseUrl: server.url, fetch: call });
  const session = async (title: string) => {
    const created = await repository.createSession({ projectId: 'default', title });
    if (!created.ok) throw new Error(created.message);
    return created.session.sessionId;
  };
  const upload = async (sessionId: string) => {
    const response = await call(`${server.url}/api/v1/sessions/${sessionId}/images?name=a.png`, {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: Buffer.from(PNG, 'base64'),
    });
    if (response.status !== 201) throw new Error(`upload ${response.status}`);
    return (await response.json()) as ImageAttachment;
  };
  const queued = async (sessionId: string, image: ImageAttachment) => {
    const added = await repository.addSessionEntry(sessionId, {
      intent: 'queue',
      text: 'Look at the picture.',
      state: 'queued',
      images: [image],
      start: START,
    });
    if (!added.ok) throw new Error(added.message);
    const entryId = added.session.entries.at(-1)?.entryId ?? '';
    const until = Date.now() + 5_000;
    for (;;) {
      const entry = (await repository.getSession(sessionId))?.entries.find(
        (e) => e.entryId === entryId,
      );
      if (entry?.state !== 'queued' || Date.now() > until) return entry;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  return { transport, session, upload, queued };
}

it('starts a queued request with an image of its own session', async () => {
  const s = await boot();
  const sessionId = await s.session('Own');
  const image = await s.upload(sessionId);
  const entry = await s.queued(sessionId, image);
  expect(entry).toMatchObject({ state: 'started', detail: null });
  // The run's input names the image the session saved; its bytes are read from that session.
  expect((await s.transport.getRunDefinition(entry?.runId ?? ''))?.input.images).toEqual([image]);
  await waitForProjection(s.transport, entry?.runId ?? '', (p) =>
    ['succeeded', 'failed'].includes(p.status),
  );
});

it('refuses a queued request naming an image only another session saved, and reads nothing', async () => {
  const s = await boot();
  const other = await s.session('Other');
  const image = await s.upload(other);
  const sessionId = await s.session('Mine');
  const entry = await s.queued(sessionId, image);
  expect(entry).toMatchObject({
    state: 'refused',
    runId: null,
    detail: 'image input is unavailable or its identity changed',
  });
});
