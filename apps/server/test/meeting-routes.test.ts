import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MeetingView } from '@corral/contracts';
import { ScriptedAgentAdapter } from '@corral/testkit';
import { expect, it, vi } from 'vitest';
import { startCorralServer } from '../src/index.ts';

it('[TC-MEET-001-H] [TC-MEET-001-N] a meeting is created, answers a round over HTTP, and its state only changes through rounds', async () => {
  const root = mkdtempSync(join(tmpdir(), 'corral-meeting-routes-'));
  const token = 'test-bootstrap-token-0123456789abcdef';
  const server = await startCorralServer({
    workspace: root,
    worktreeRoot: join(root, 'copies'),
    port: 0,
    bootstrapToken: token,
    agents: new ScriptedAgentAdapter({
      turns: 1,
      collaborate: false,
      appendNotes: false,
      reply: (_turn, input) => `${input.role.name}: noted`,
    }),
  });
  try {
    const login = await fetch(`${server.url}/api/v1/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: server.url },
      body: JSON.stringify({ token }),
    });
    const headers = {
      cookie: (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '',
      'content-type': 'application/json',
      origin: server.url,
      'x-corral-csrf': login.headers.get('x-corral-csrf') ?? '',
    };
    const call = (method: string, path: string, body?: unknown) =>
      fetch(`${server.url}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const config = {
      version: 1,
      participants: [
        {
          participantId: 'architect',
          name: 'Architect',
          prompt: 'Structure.',
          modelProfile: 'model-a',
        },
        { participantId: 'builder', name: 'Builder', prompt: 'Delivery.', modelProfile: 'model-b' },
      ],
      secretary: { modelProfile: 'model-a' },
    };
    expect((await fetch(`${server.url}/api/v1/sessions/x/meeting`)).status).toBe(401);
    const created = await call('POST', '/api/v1/sessions', {
      projectId: 'default',
      title: 'Review',
      meeting: config,
    });
    expect(created.status).toBe(201);
    const { session } = (await created.json()) as {
      session: { sessionId: string; revision: number };
    };
    const path = `/api/v1/sessions/${session.sessionId}/meeting`;
    const workResponse = await call('POST', '/api/v1/sessions', {
      projectId: 'default',
      title: 'Work',
    });
    const work = (await workResponse.json()) as { session: { sessionId: string } };
    for (const [endpoint, body] of [
      [
        '/runs/auto',
        {
          schemaVersion: '0.1',
          commandId: 'meeting_start_reserved',
          sessionId: work.session.sessionId,
          brief: 'A different request',
          choice: { modelProfile: 'model-a' },
          mode: 'mock',
        },
      ],
      [
        '/runs/explain',
        {
          commandId: 'meeting_start_reserved',
          sessionId: work.session.sessionId,
          question: 'A different request',
          modelProfile: 'model-a',
          mode: 'mock',
        },
      ],
      [
        '/runs',
        {
          schemaVersion: '0.1',
          commandId: 'meeting_start_reserved',
          sessionId: work.session.sessionId,
          corralId: 'missing',
          definitionRevision: 1,
          mode: 'mock',
        },
      ],
    ] as const) {
      expect((await call('POST', `/api/v1${endpoint}`, body)).status).toBe(403);
    }
    // A meeting cannot bypass turn-taking through the ordinary execution endpoints.
    for (const [endpoint, body] of [
      [
        '/runs/auto',
        {
          schemaVersion: '0.1',
          commandId: 'bypass_auto',
          sessionId: session.sessionId,
          brief: 'Change files',
          choice: { modelProfile: 'model-a' },
          mode: 'mock',
        },
      ],
      [
        '/runs/explain',
        {
          commandId: 'bypass_explain',
          sessionId: session.sessionId,
          question: 'Skip the round',
          modelProfile: 'model-a',
          mode: 'mock',
        },
      ],
      [
        '/runs',
        {
          schemaVersion: '0.1',
          commandId: 'bypass_corral',
          sessionId: session.sessionId,
          corralId: 'missing',
          definitionRevision: 1,
          mode: 'mock',
        },
      ],
    ] as const) {
      const refused = await call('POST', `/api/v1${endpoint}`, body);
      expect(refused.status).toBe(403);
    }
    expect(server.coordinator.listRuns()).toHaveLength(0);
    const sent = await call('POST', `${path}/rounds`, {
      kind: 'message',
      commandId: 'c1',
      mode: 'mock',
      text: 'Ship it this week?',
    });
    expect(sent.status).toBe(200);
    expect(await sent.json()).toMatchObject({ ok: true, outcome: 'started' });
    await vi.waitFor(
      async () => {
        const view = (await (await call('GET', path)).json()) as MeetingView;
        expect(
          view.rounds[0]?.answers.map((a) => [a.participantId, a.status, a.text]).sort(),
        ).toEqual([
          ['architect', 'answered', 'Architect: noted'],
          ['builder', 'answered', 'Builder: noted'],
        ]);
      },
      { timeout: 10_000 },
    );
    // The meeting record cannot be edited around the rules.
    expect(
      (
        await call('PATCH', `/api/v1/sessions/${session.sessionId}`, {
          expectedRevision: session.revision,
          meeting: { config, rounds: [], queued: null },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call('POST', `${path}/rounds`, {
          kind: 'message',
          commandId: 'c2',
          mode: 'mock',
          text: '@비서 @Builder both?',
        })
      ).status,
    ).toBe(400);
    expect((await call('GET', '/api/v1/sessions/session_missing/meeting')).status).toBe(404);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
