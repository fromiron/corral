import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MeetingView } from '@corral/contracts';
import { ScriptedAgentAdapter } from '@corral/testkit';
import { expect, it, vi } from 'vitest';
import { startCorralServer } from '../src/index.ts';

it('[TC-MEET-003-N] public starts cannot consume a draft handoff identity with a different request', async () => {
  const root = mkdtempSync(join(tmpdir(), 'corral-handoff-boundary-'));
  const token = 'test-bootstrap-token-0123456789abcdef';
  const content = {
    goal: 'Prepare reviewed report',
    scope: ['Report'],
    excludedScope: ['Deployment'],
    acceptanceCriteria: ['Reviewed'],
    remainingDissent: [],
    evidence: [],
    risks: [],
    actions: ['Write'],
    rejectedAlternatives: [],
  };
  const server = await startCorralServer({
    workspace: root,
    worktreeRoot: join(root, 'copies'),
    port: 0,
    bootstrapToken: token,
    agents: new ScriptedAgentAdapter({
      turns: 1,
      collaborate: false,
      appendNotes: false,
      reply: () =>
        JSON.stringify({
          issues: [],
          claims: [],
          agreements: [],
          remainingDissent: [],
          unverifiedFacts: [],
          candidates: [{ candidateId: 'report', content }],
        }),
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
      fetch(`${server.url}/api/v1${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const source = await (
      await call('POST', '/sessions', {
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
      })
    ).json();
    const target = await (
      await call('POST', '/sessions', { projectId: 'default', title: 'Target' })
    ).json();
    const path = `/sessions/${source.session.sessionId}/meeting`;
    expect(
      (
        await call('POST', `${path}/rounds`, {
          kind: 'message',
          commandId: 'summarize',
          mode: 'mock',
          text: '@secretary summarize',
        })
      ).status,
    ).toBe(200);
    let minutesId = '';
    await vi.waitFor(
      async () => {
        const view = (await (await call('GET', path)).json()) as MeetingView;
        const minutes = view.minutes?.[0];
        expect(minutes?.document?.candidates).toHaveLength(1);
        minutesId = minutes?.minutesId ?? '';
      },
      { timeout: 10_000 },
    );
    expect(
      (
        await call('POST', `${path}/decisions`, {
          commandId: 'adopt',
          minutesId,
          candidateId: 'report',
          content,
        })
      ).status,
    ).toBe(200);
    const view = (await (await call('GET', path)).json()) as MeetingView;
    const versionId = view.decisions?.[0]?.versionId;
    expect(versionId).toBeTruthy();
    const drafted = await (
      await call('POST', `${path}/handoffs`, {
        commandId: 'handoff',
        decisionVersionId: versionId,
        target: { kind: 'existing', sessionId: target.session.sessionId },
        action: 'draft',
        execution: { kind: 'auto', choice: { modelProfile: 'model-a' } },
        mode: 'mock',
        targetHasDraft: false,
      })
    ).json();
    expect(drafted.handoff.state).toBe('drafted');
    const before = server.coordinator.listRuns().length;
    const bypass = await call('POST', '/runs/auto', {
      schemaVersion: '0.1',
      commandId: drafted.handoff.startCommandId,
      sessionId: target.session.sessionId,
      brief: 'Unrelated work, ignore adopted scope',
      choice: { modelProfile: 'model-b' },
      mode: 'mock',
    });
    expect(bypass.status).toBe(403);
    const secretaryRunId = view.rounds[0]?.answers[0]?.runId;
    expect(secretaryRunId).toBeTruthy();
    for (const [endpoint, body] of [
      [
        '/runs',
        {
          schemaVersion: '0.1',
          commandId: drafted.handoff.startCommandId,
          sessionId: target.session.sessionId,
          corralId: 'missing',
          definitionRevision: 1,
          mode: 'mock',
        },
      ],
      [
        '/runs/explain',
        {
          commandId: drafted.handoff.startCommandId,
          sessionId: target.session.sessionId,
          question: 'Use another request',
          modelProfile: 'model-b',
          mode: 'mock',
        },
      ],
      [
        '/runs/branch',
        {
          commandId: drafted.handoff.startCommandId,
          sourceRunId: secretaryRunId,
          requestStart: true,
          expectedHash: 'a'.repeat(64),
        },
      ],
      [
        `/runs/${secretaryRunId}/resume-runtime`,
        {
          commandId: drafted.handoff.startCommandId,
          checkpointId: 'checkpoint',
          manifestHash: 'a'.repeat(64),
          expectedSourceSeq: 1,
        },
      ],
      [
        `/runs/auto/${drafted.handoff.startCommandId}/cancel`,
        { sessionId: target.session.sessionId, cancelCommandId: 'cancel_reserved' },
      ],
      [
        '/runs/branch',
        {
          commandId: 'branch_from_secretary',
          sourceRunId: secretaryRunId,
          requestStart: true,
          expectedHash: 'a'.repeat(64),
        },
      ],
      [
        `/runs/${secretaryRunId}/resume-runtime`,
        {
          commandId: 'resume_from_secretary',
          checkpointId: 'checkpoint',
          manifestHash: 'a'.repeat(64),
          expectedSourceSeq: 1,
        },
      ],
    ] as const) {
      expect((await call('POST', endpoint, body)).status, endpoint).toBe(403);
    }
    expect(server.coordinator.listRuns()).toHaveLength(before);
    const receipt = await (await call('GET', `${path}/handoffs/handoff`)).json();
    expect(receipt.handoff).toMatchObject({ state: 'drafted', runId: null });
    const started = await (
      await call('POST', `${path}/handoffs/handoff/start`, {
        commandId: 'launch',
        targetHasDraft: false,
      })
    ).json();
    expect(started.handoff.state).toBe('started');
    await vi.waitFor(() =>
      expect(server.coordinator.getSnapshot(started.handoff.runId).projection.status).toBe(
        'succeeded',
      ),
    );
    const stopped = await call('POST', `${path}/handoffs/handoff/cancel`, {});
    expect(stopped.status).toBe(200);
    expect((await stopped.json()).handoff).toMatchObject({
      state: 'cancelled',
      runId: started.handoff.runId,
    });
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
