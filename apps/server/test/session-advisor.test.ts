import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpSseTransport, RestCorralRepository } from '@corral/client';
import type { CorralDefinition } from '@corral/contracts';
import { queuedSessionCommandId, type SessionEntryStart, waitForProjection } from '@corral/core';
import { Gate, ScriptedAgentAdapter } from '@corral/testkit';
import { afterEach, expect, it } from 'vitest';
import { type CorralServer, startCorralServer } from '../src/index.ts';

// The session's advisor setting and the conversations it is pinned into (features/advisor.md,
// 두는 곳 › 대화 and 계약).

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

const START: SessionEntryStart = {
  choice: { modelProfile: 'model-a' },
  mode: 'mock',
  team: 'none',
};
const TOKEN = 'test-session-advisor-0123456789abcdef';

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'corral-session-advisor-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  let hold: Gate | null = null;
  const server: CorralServer = await startCorralServer({
    workspace: join(root, 'workspace'),
    worktreeRoot: join(root, 'copies'),
    port: 0,
    bootstrapToken: TOKEN,
    agents: new ScriptedAgentAdapter({
      turns: 1,
      collaborate: false,
      appendNotes: false,
      beforeReply: async (_turn, input) => {
        if (input.assignment.kind !== 'advisor') await hold?.wait();
      },
      reply: () => 'Done.',
    }),
  });
  cleanup.push(() => {
    hold?.open();
    return server.close();
  });
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
    if (init.body) merged.set('content-type', 'application/json');
    return fetch(input, { ...init, headers: merged });
  };
  const send = async (method: string, path: string, body?: unknown) => {
    const response = await call(`${server.url}/api/v1${path}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  const repository = new RestCorralRepository({ baseUrl: server.url, fetch: call });
  const transport = new HttpSseTransport({ baseUrl: server.url, fetch: call });
  const created = await repository.createSession({ projectId: 'default', title: 'Watched' });
  if (!created.ok) throw new Error(created.message);
  const sessionId = created.session.sessionId;
  const revision = async () => (await repository.getSession(sessionId))?.revision ?? 0;
  const advisor = async (value: { modelProfile: string } | null) => {
    const result = await repository.updateSession(sessionId, {
      advisor: value,
      expectedRevision: await revision(),
    });
    if (!result.ok) throw new Error(result.message);
    return result.session;
  };
  const ask = (commandId: string, brief = 'A request.') =>
    transport.startAuto({ commandId, sessionId, brief, ...START });
  const ended = (runId: string | null) =>
    waitForProjection(transport, runId ?? '', (p) =>
      ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(p.status),
    );
  const observers = async (runId: string | null) =>
    ((await transport.getRunDefinition(runId ?? '')) as CorralDefinition | null)?.nodes
      .filter((node) => node.type === 'agent' && node.invocation === 'observer')
      .map((node) => node.id) ?? null;
  return {
    server,
    send,
    repository,
    transport,
    sessionId,
    advisor,
    ask,
    ended,
    observers,
    hold() {
      const gate = new Gate();
      hold = gate;
      return gate;
    },
  };
}

it('saves the advisor with the session, off by default, under its revision', async () => {
  const s = await setup();
  const path = `/sessions/${s.sessionId}`;
  expect((await s.repository.getSession(s.sessionId))?.advisor).toBeNull();
  const on = await s.send('PATCH', path, {
    advisor: { modelProfile: 'model-b' },
    expectedRevision: 1,
  });
  expect(on.status).toBe(200);
  expect(on.body.session).toMatchObject({ advisor: { modelProfile: 'model-b' }, revision: 2 });
  expect((await s.repository.getSession(s.sessionId))?.advisor).toEqual({
    modelProfile: 'model-b',
  });
  const stale = await s.send('PATCH', path, { advisor: null, expectedRevision: 1 });
  expect(stale.status).toBe(409);
  for (const advisor of [
    { modelProfile: '' },
    { modelProfile: 'model-b', review: { interval: 1 } },
    'model-b',
    true,
  ]) {
    const invalid = await s.send('PATCH', path, { advisor, expectedRevision: 2 });
    expect(invalid.status).toBe(400);
  }
  // A model profile that no catalog knows is kept; a start treats it like any role's model.
  const unknown = await s.send('PATCH', path, {
    advisor: { modelProfile: 'not-a-known-profile' },
    expectedRevision: 2,
  });
  expect(unknown.status).toBe(200);
  const off = await s.send('PATCH', path, { advisor: null, expectedRevision: 3 });
  expect(off.body.session).toMatchObject({ advisor: null, revision: 4 });
});

it('a change reaches the runs started after it, never the one already running', async () => {
  const s = await setup();
  const gate = s.hold();
  const first = await s.ask('cmd_first');
  await s.advisor({ modelProfile: 'model-b' });
  gate.open();
  await s.ended(first.runId);
  expect(await s.observers(first.runId)).toEqual([]);
  const second = await s.ask('cmd_second');
  await s.ended(second.runId);
  expect(await s.observers(second.runId)).toEqual(['session_advisor']);
  const definition = (await s.transport.getRunDefinition(second.runId ?? '')) as CorralDefinition;
  expect(definition.roles.find((role) => role.id === 'session_advisor')).toMatchObject({
    name: 'Advisor',
    modelProfile: 'model-b',
  });
  await s.advisor(null);
  const third = await s.ask('cmd_third');
  await s.ended(third.runId);
  expect(await s.observers(third.runId)).toEqual([]);
});

it('a queued request starts with the advisor turned on after it was queued, once', async () => {
  const s = await setup();
  const gate = s.hold();
  const first = await s.ask('cmd_first');
  const added = await s.repository.addSessionEntry(s.sessionId, {
    intent: 'queue',
    text: 'Second request.',
    state: 'queued',
    start: START,
  });
  if (!added.ok) throw new Error(added.message);
  const entry = added.session.entries.at(-1);
  if (!entry) throw new Error('no entry');
  await s.advisor({ modelProfile: 'model-b' });
  gate.open();
  await s.ended(first.runId);
  let started = (await s.repository.getSession(s.sessionId))?.entries.find(
    (e) => e.entryId === entry.entryId,
  );
  for (let i = 0; i < 100 && started?.state === 'queued'; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    started = (await s.repository.getSession(s.sessionId))?.entries.find(
      (e) => e.entryId === entry.entryId,
    );
  }
  expect(started?.state).toBe('started');
  expect(await s.observers(started?.runId ?? null)).toEqual(['session_advisor']);
  // The screen starting the same entry gets the same run, not a conflict.
  const same = await s.transport.startAuto({
    ...START,
    commandId: queuedSessionCommandId(s.sessionId, entry),
    sessionId: s.sessionId,
    brief: 'Second request.',
    conversation: { throughRunId: first.runId ?? '' },
  });
  expect(same.receipt.error).toBeUndefined();
  expect(same.runId).toBe(started?.runId);
  await s.ended(started?.runId ?? null);
  expect(
    s.server.coordinator.listRuns().filter((run) => run.sessionId === s.sessionId),
  ).toHaveLength(2);
});

it('a person’s start racing the server’s start of the same entry is one run with the advisor', async () => {
  const s = await setup();
  await s.advisor({ modelProfile: 'model-b' });
  const gate = s.hold();
  const first = await s.ask('cmd_first');
  const added = await s.repository.addSessionEntry(s.sessionId, {
    intent: 'queue',
    text: 'Second request.',
    state: 'queued',
    start: START,
  });
  if (!added.ok) throw new Error(added.message);
  const entry = added.session.entries.at(-1);
  if (!entry) throw new Error('no entry');
  const commandId = queuedSessionCommandId(s.sessionId, entry);
  gate.open();
  // The person sends the entry as the run ends, while the server starts it too.
  await s.ended(first.runId);
  const person = await s.transport.startAuto({
    ...START,
    commandId,
    sessionId: s.sessionId,
    brief: 'Second request.',
    conversation: { throughRunId: first.runId ?? '' },
  });
  expect(person.receipt.error).toBeUndefined();
  await s.ended(person.runId);
  expect(await s.observers(person.runId)).toEqual(['session_advisor']);
  let stored = (await s.repository.getSession(s.sessionId))?.entries.find(
    (e) => e.entryId === entry.entryId,
  );
  for (let i = 0; i < 100 && stored?.state === 'queued'; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    stored = (await s.repository.getSession(s.sessionId))?.entries.find(
      (e) => e.entryId === entry.entryId,
    );
  }
  expect(stored?.state === 'queued' || stored?.runId === person.runId).toBe(true);
  expect(
    s.server.coordinator.listRuns().filter((run) => run.sessionId === s.sessionId),
  ).toHaveLength(2);
});

it('a scheduled run of the session starts without its advisor', async () => {
  const s = await setup();
  await s.advisor({ modelProfile: 'model-b' });
  const created = await s.send('POST', '/schedules', {
    title: 'Review',
    hostId: 'local',
    projectId: 'default',
    sessionId: s.sessionId,
    timezone: 'Asia/Tokyo',
    rule: { kind: 'daily', time: '09:00' },
    enabled: false,
    request: {
      brief: 'Summarize the available information.',
      choice: { modelProfile: 'model-a' },
      mode: 'mock',
      permissionMode: 'ask',
      configRevision: 1,
    },
  });
  expect(created.status).toBeLessThan(300);
  const run = await s.send('POST', `/schedules/${created.body.id}/run`, {
    commandId: 'manual_review',
    expectedRevision: 1,
  });
  const runId = run.body.occurrences?.[0]?.runId ?? null;
  expect(runId).toBeTruthy();
  await s.ended(runId);
  expect(await s.observers(runId)).toEqual([]);
});
