import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpSseTransport, RestCorralRepository } from '@corral/client';
import type { SessionEntry, SessionEntryStart } from '@corral/core';
import { ScriptedAgentAdapter } from '@corral/testkit';
import { afterEach, expect, it } from 'vitest';
import { type CorralServer, startCorralServer } from '../src/index.ts';

// features/usage-limit-resend.md, through the real server, its store and its queue: a queued
// request whose run fails on a usage limit is copied to the front, and nothing behind it starts.

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

const TOKEN = 'test-usage-limit-resend-0123456789ab';
const START: SessionEntryStart = {
  choice: { modelProfile: 'model-a' },
  mode: 'mock',
  team: 'none',
};
const resetAt = new Date(Math.ceil((Date.now() + 42 * 60_000) / 1000) * 1000).toISOString();

async function boot(workspace: string, root: string) {
  const server: CorralServer = await startCorralServer({
    workspace,
    worktreeRoot: join(root, 'copies'),
    port: 0,
    bootstrapToken: TOKEN,
    agents: new ScriptedAgentAdapter({
      turns: 1,
      collaborate: false,
      appendNotes: false,
      script: async () => ({
        outcome: 'failed',
        error: 'the model request failed: HTTP 429 (QUOTA)',
        usageLimit: { resetAt },
      }),
    }),
  });
  cleanup.push(() => server.close());
  const login = await fetch(`${server.url}/api/v1/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: server.url },
    body: JSON.stringify({ token: TOKEN }),
  });
  const headers = {
    cookie: (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '',
    'x-corral-csrf': login.headers.get('x-corral-csrf') ?? '',
    origin: server.url,
  };
  const call: typeof fetch = (input, init = {}) => {
    const merged = new Headers(init.headers);
    for (const [key, value] of Object.entries(headers)) merged.set(key, value);
    if (init.body && !merged.has('content-type')) merged.set('content-type', 'application/json');
    return fetch(input, { ...init, headers: merged });
  };
  return {
    server,
    repository: new RestCorralRepository({ baseUrl: server.url, fetch: call }),
    transport: new HttpSseTransport({ baseUrl: server.url, fetch: call }),
  };
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, ms = 5_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > end) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

it('a queued request failed on a usage limit is copied to the front and holds the queue', async () => {
  const root = mkdtempSync(join(tmpdir(), 'corral-usage-limit-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const s = await boot(workspace, root);
  const created = await s.repository.createSession({ projectId: 'default', title: 'Limit' });
  if (!created.ok) throw new Error(created.message);
  const sessionId = created.session.sessionId;
  const added = await s.repository.addSessionEntry(sessionId, {
    intent: 'queue',
    text: 'Summarize the report.',
    state: 'queued',
    start: START,
  });
  if (!added.ok) throw new Error(added.message);
  const source = added.session.entries.at(-1) as SessionEntry;

  const copied = await until(
    async () => (await s.repository.getSession(sessionId))?.entries ?? [],
    (entries) => entries.some((entry) => entry.resend),
  );
  const started = copied.find((entry) => entry.entryId === source.entryId);
  expect(started?.state).toBe('started');
  const failed = await s.transport.getSnapshot(started?.runId ?? '');
  expect(failed.projection.status).toBe('failed');
  const copy = copied.find((entry) => entry.resend);
  expect(copy).toMatchObject({
    intent: 'queue',
    state: 'queued',
    text: 'Summarize the report.',
    start: START,
    resend: {
      of: source.entryId,
      runId: started?.runId,
      notBefore: new Date(Date.parse(resetAt) + 60_000).toISOString(),
    },
  });

  // A request queued behind it waits for the reset too.
  const behind = await s.repository.addSessionEntry(sessionId, {
    intent: 'queue',
    text: 'Then draft the reply.',
    state: 'queued',
    start: START,
  });
  if (!behind.ok) throw new Error(behind.message);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const after = (await s.repository.getSession(sessionId))?.entries ?? [];
  expect(after.filter((entry) => entry.state === 'queued').map((entry) => entry.text)).toEqual([
    'Summarize the report.',
    'Then draft the reply.',
  ]);
  expect(after.filter((entry) => entry.state === 'started')).toHaveLength(1);

  // A restart keeps the copy waiting; it does not start it early.
  await s.server.close();
  const again = await boot(workspace, root);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const reopened = (await again.repository.getSession(sessionId))?.entries ?? [];
  expect(reopened.find((entry) => entry.resend)?.state).toBe('queued');
  expect(reopened.filter((entry) => entry.state === 'started')).toHaveLength(1);
});

it('a sent request recorded after its run failed is copied, and another run ending removes it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'corral-usage-limit-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const s = await boot(join(root, 'workspace'), root);
  const created = await s.repository.createSession({ projectId: 'default', title: 'Sent' });
  if (!created.ok) throw new Error(created.message);
  const sessionId = created.session.sessionId;
  // As the composer sends a new request: start it, then record it with the run it started.
  const started = await s.transport.startAuto({
    commandId: 'cmd_sent',
    sessionId,
    brief: 'Summarize the report.',
    ...START,
  });
  const runId = started.runId ?? '';
  await until(
    () => s.transport.getSnapshot(runId),
    (snapshot) => snapshot.projection.status === 'failed',
  );
  const recorded = await s.repository.addSessionEntry(sessionId, {
    intent: 'next',
    text: 'Summarize the report.',
    state: 'started',
    runId,
    commandId: 'cmd_sent',
    start: START,
  });
  if (!recorded.ok) throw new Error(recorded.message);
  const copied = await until(
    async () => (await s.repository.getSession(sessionId))?.entries ?? [],
    (entries) => entries.some((entry) => entry.resend),
  );
  expect(copied.find((entry) => entry.resend)).toMatchObject({
    state: 'queued',
    resend: { runId },
  });

  // The person sends another request and its run ends: the copy is not wanted any more.
  const other = await s.transport.startAuto({
    commandId: 'cmd_other',
    sessionId,
    brief: 'Try with another model.',
    ...START,
  });
  await until(
    () => s.transport.getSnapshot(other.runId ?? ''),
    (snapshot) => snapshot.projection.status === 'failed',
  );
  const after = await until(
    async () => (await s.repository.getSession(sessionId))?.entries ?? [],
    (entries) => entries.find((entry) => entry.resend)?.state === 'dismissed',
  );
  expect(after.find((entry) => entry.resend)?.state).toBe('dismissed');
});
