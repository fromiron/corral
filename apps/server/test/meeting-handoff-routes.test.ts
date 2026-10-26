import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MeetingHandoffReceipt, MeetingView } from '@corral/contracts';
import { ScriptedAgentAdapter } from '@corral/testkit';
import { expect, it, vi } from 'vitest';
import { startCorralServer } from '../src/index.ts';

it('adopts secretary minutes over HTTP, starts one pinned handoff, and explicitly discusses its result', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'corral-meeting-handoff-http-'));
  const token = 'test-bootstrap-token-0123456789abcdef';
  const content = {
    goal: 'Write the report',
    scope: ['Report'],
    excludedScope: ['Deployment'],
    acceptanceCriteria: ['Readable report'],
    remainingDissent: ['The scope is disputed'],
    evidence: ['User selected source'],
    risks: ['Missing data'],
    actions: ['Write'],
    rejectedAlternatives: ['Deploy automatically'],
  };
  const minutes = {
    issues: ['Report scope'],
    claims: [],
    agreements: [],
    remainingDissent: [],
    unverifiedFacts: ['Missing data'],
    candidates: [{ candidateId: 'report', content }],
  };
  const server = await startCorralServer({
    workspace: directory,
    worktreeRoot: join(directory, 'copies'),
    port: 0,
    bootstrapToken: token,
    agents: new ScriptedAgentAdapter({
      turns: 1,
      collaborate: false,
      appendNotes: false,
      reply: (_turn, input) =>
        input.role.name === 'Secretary' ? JSON.stringify(minutes) : 'The report is ready.',
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
    const created = await call('POST', '/api/v1/sessions', {
      projectId: 'default',
      title: 'Meeting',
      meeting: {
        version: 1,
        participants: ['a', 'b'].map((participantId) => ({
          participantId,
          name: participantId,
          prompt: 'Review',
          modelProfile: 'model-a',
        })),
        secretary: { modelProfile: 'model-a' },
      },
    });
    expect(created.status).toBe(201);
    const { session } = (await created.json()) as { session: { sessionId: string } };
    const path = `/api/v1/sessions/${session.sessionId}/meeting`;
    expect(
      (
        await call('POST', `${path}/rounds`, {
          kind: 'message',
          commandId: 'summary_1',
          mode: 'mock',
          text: '@비서 Summarise',
        })
      ).status,
    ).toBe(200);
    let view!: MeetingView;
    await vi.waitFor(
      async () => {
        view = (await (await call('GET', path)).json()) as MeetingView;
        expect(view.minutes?.[0]?.document?.candidates).toHaveLength(1);
      },
      { timeout: 10_000 },
    );
    const adopted = await call('POST', `${path}/decisions`, {
      commandId: 'adopt_1',
      minutesId: view.minutes?.[0]?.minutesId,
      candidateId: 'report',
      content,
    });
    expect(adopted.status).toBe(200);
    view = (await (await call('GET', path)).json()) as MeetingView;
    const request = {
      commandId: 'handoff_1',
      decisionVersionId: view.decisions?.[0]?.versionId,
      target: { kind: 'new', title: 'Work' },
      action: 'start',
      execution: { kind: 'auto', choice: { modelProfile: 'model-a' } },
      mode: 'mock',
      targetHasDraft: false,
    };
    const sent = await call('POST', `${path}/handoffs`, request);
    expect(sent.status).toBe(200);
    const { handoff } = (await sent.json()) as { handoff: MeetingHandoffReceipt };
    expect(handoff).toMatchObject({ state: 'started', execution: request.execution });
    expect(handoff.autoRoute?.modelProfile).toBe('model-a');
    const replay = (await (await call('POST', `${path}/handoffs`, request)).json()) as {
      handoff: MeetingHandoffReceipt;
    };
    expect(replay.handoff).toMatchObject({
      runId: handoff.runId,
      entryId: handoff.entryId,
      targetSessionId: handoff.targetSessionId,
    });
    const target = (await (
      await call('GET', `/api/v1/sessions/${handoff.targetSessionId}`)
    ).json()) as { entries: unknown[]; corralId: null; auto: null };
    expect(target).toMatchObject({ corralId: null, auto: null });
    expect(target.entries).toHaveLength(1);
    const links = (await (
      await call('GET', `/api/v1/sessions/${handoff.targetSessionId}/meeting-handoffs`)
    ).json()) as { handoffs: MeetingHandoffReceipt[] };
    expect(links.handoffs[0]?.sourceSessionId).toBe(session.sessionId);
    await vi.waitFor(
      async () => {
        const receipt = (await (await call('GET', `${path}/handoffs/handoff_1`)).json()) as {
          handoff: MeetingHandoffReceipt;
        };
        expect(receipt.handoff.result?.status).toBe('succeeded');
      },
      { timeout: 10_000 },
    );
    expect(
      (
        await call('POST', `${path}/handoffs/handoff_1/rediscuss`, {
          commandId: 'discuss_1',
          mode: 'mock',
        })
      ).status,
    ).toBe(200);
    const discussed = (await (await call('GET', path)).json()) as MeetingView;
    expect(discussed.rounds.at(-1)?.message).toContain('The report is ready.');
  } finally {
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
