import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Schedule, ScheduledOccurrence } from '@corral/contracts';
import { ScriptedAgentAdapter } from '@corral/testkit';
import { expect, it } from 'vitest';
import { startCorralServer } from '../src/index.ts';

it('schedule HTTP command uses Auto/Coordinator and persists conversation readback across restart', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'corral-schedules-api-'));
  const bootstrapToken = 'schedules-test-token-0123456789abcdef';
  const start = () =>
    startCorralServer({
      workspace,
      port: 0,
      bootstrapToken,
      agents: new ScriptedAgentAdapter({ turns: 1 }),
    });
  let server = await start();
  const connect = async () => {
    const login = await fetch(`${server.url}/api/v1/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: server.url },
      body: JSON.stringify({ token: bootstrapToken }),
    });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const csrf = login.headers.get('x-corral-csrf') ?? '';
    return async (path: string, body?: unknown, method = 'POST') => {
      const response = await fetch(`${server.url}/api/v1${path}`, {
        method: body === undefined ? 'GET' : method,
        headers: {
          cookie,
          'x-corral-csrf': csrf,
          origin: server.url,
          'content-type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const value = response.status === 204 ? null : await response.json();
      expect(response.ok, JSON.stringify(value)).toBe(true);
      return value;
    };
  };
  try {
    let json = await connect();
    const { session } = await json('/sessions', {
      projectId: 'default',
      title: 'Scheduled review',
    });
    const schedule: Schedule = await json('/schedules', {
      title: 'Review',
      hostId: 'local',
      projectId: 'default',
      sessionId: session.sessionId,
      timezone: 'Asia/Tokyo',
      rule: { kind: 'daily', time: '09:00' },
      enabled: false,
      request: {
        brief: 'Summarize the available information.',
        choice: { modelProfile: 'simulated' },
        mode: 'mock',
        permissionMode: 'ask',
        configRevision: 1,
      },
    });
    const first: { occurrences: ScheduledOccurrence[] } = await json(
      `/schedules/${schedule.id}/run`,
      {
        commandId: 'manual_review',
        expectedRevision: 1,
      },
    );
    expect(first.occurrences).toHaveLength(1);
    expect(first.occurrences[0]?.status).toBe('started');
    const duplicate = await json(`/schedules/${schedule.id}/run`, {
      commandId: 'manual_review',
      expectedRevision: 1,
    });
    expect(duplicate.occurrences[0]?.runId).toBe(first.occurrences[0]?.runId);
    const conversation = await json(`/sessions/${session.sessionId}`);
    expect(conversation.entries).toHaveLength(1);
    expect(conversation.entries[0]).toMatchObject({
      text: 'Summarize the available information.',
      state: 'started',
      auto: { permissionMode: 'ask' },
      runId: first.occurrences[0]?.runId,
    });
    await server.close();
    server = await start();
    json = await connect();
    const restored = await json('/schedules');
    expect(restored.schedules[0]).toMatchObject({ id: schedule.id, enabled: false });
    const history = await json(`/schedules/${schedule.id}/occurrences`);
    expect(history.occurrences).toHaveLength(1);
    expect(history.occurrences[0]?.runId).toBe(first.occurrences[0]?.runId);
    const restoredConversation = await json(`/sessions/${session.sessionId}`);
    expect(restoredConversation.entries).toHaveLength(1);
  } finally {
    await server.close();
    rmSync(workspace, { recursive: true, force: true });
  }
}, 30_000);

it('a refused schedule request answers with the code Studio turns into its own words', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'corral-schedules-refusal-'));
  const bootstrapToken = 'schedules-test-token-0123456789abcdef';
  const server = await startCorralServer({
    workspace,
    port: 0,
    bootstrapToken,
    agents: new ScriptedAgentAdapter({ turns: 1 }),
  });
  try {
    const login = await fetch(`${server.url}/api/v1/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: server.url },
      body: JSON.stringify({ token: bootstrapToken }),
    });
    const headers = {
      cookie: (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '',
      'x-corral-csrf': login.headers.get('x-corral-csrf') ?? '',
      origin: server.url,
      'content-type': 'application/json',
    };
    const send = async (path: string, method: string, body: unknown) => {
      const response = await fetch(`${server.url}/api/v1${path}`, {
        method,
        headers,
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };
    const { body: made } = await send('/sessions', 'POST', {
      projectId: 'default',
      title: 'Scheduled review',
    });
    const draft = {
      title: 'Review',
      hostId: 'local',
      projectId: 'default',
      sessionId: made.session.sessionId,
      timezone: 'Asia/Tokyo',
      rule: { kind: 'daily', time: '09:00' },
      enabled: false,
      request: {
        brief: 'Summarize the available information.',
        choice: { modelProfile: 'simulated' },
        mode: 'mock',
        permissionMode: 'ask',
        configRevision: 1,
      },
    };
    const { body: schedule } = await send('/schedules', 'POST', draft);
    expect(await send('/schedules', 'POST', { ...draft, timezone: 'Mars/Olympus' })).toMatchObject({
      status: 400,
      body: { error: { code: 'SCHEMA_INVALID' } },
    });
    const stale = { expectedRevision: schedule.revision + 5 };
    expect(await send(`/schedules/${schedule.id}`, 'PUT', { ...stale, draft })).toMatchObject({
      status: 409,
      body: { error: { code: 'REVISION_CONFLICT' } },
    });
    expect(await send(`/schedules/${schedule.id}`, 'DELETE', stale)).toMatchObject({
      status: 409,
      body: { error: { code: 'REVISION_CONFLICT' } },
    });
    expect(
      await send('/schedules/schedule_missing/run', 'POST', { ...stale, commandId: 'manual_1' }),
    ).toMatchObject({ status: 404, body: { error: { code: 'TARGET_NOT_FOUND' } } });
  } finally {
    await server.close();
    rmSync(workspace, { recursive: true, force: true });
  }
}, 30_000);
