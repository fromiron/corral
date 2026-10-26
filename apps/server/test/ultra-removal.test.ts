import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MeetingHandoffRequest, Receipt, RunEvent } from '@corral/contracts';
import type { RunProjection, StoredRun } from '@corral/core';
import { openDatabase, SqliteCorralRepository, SqliteRunStore } from '@corral/storage-sqlite';
import { FakeClock, linearCorral, ScriptedAgentAdapter } from '@corral/testkit';
import { afterEach, expect, it, vi } from 'vitest';
import ultraRuns from '../../../packages/core/test/fixtures/ultra-runs.json' with { type: 'json' };
import { startCorralServer } from '../src/index.ts';
import { type MeetingHandoffDeps, MeetingHandoffService } from '../src/meeting-handoffs.ts';

// Ultra is removed. No server path starts it, and runs that recorded it are not opened.

const ultra = {
  version: 2,
  modelProfiles: ['model-a', 'model-b'],
  verifierProfile: 'model-b',
};
const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
});

it('the HTTP API refuses Ultra starts, entries and candidate routes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'corral-ultra-removal-'));
  const token = 'test-bootstrap-token-0123456789abcdef';
  const server = await startCorralServer({
    workspace: root,
    worktreeRoot: join(root, 'copies'),
    port: 0,
    bootstrapToken: token,
    agents: new ScriptedAgentAdapter({ turns: 1 }),
  });
  try {
    const login = await fetch(`${server.url}/api/v1/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: server.url },
      body: JSON.stringify({ token }),
    });
    const headers = {
      cookie: (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '',
      'x-corral-csrf': login.headers.get('x-corral-csrf') ?? '',
      'content-type': 'application/json',
      origin: server.url,
    };
    const post = (route: string, body: unknown) =>
      fetch(`${server.url}${route}`, { method: 'POST', headers, body: JSON.stringify(body) });
    const created = await post('/api/v1/sessions', { projectId: 'default', title: 'Work' });
    expect(created.status, await created.clone().text()).toBe(201);
    const { session } = (await created.json()) as { session: { sessionId: string } };
    const auto = {
      schemaVersion: '0.1',
      commandId: 'ultra_start',
      sessionId: session.sessionId,
      brief: 'Hello',
      choice: { modelProfile: 'model-a' },
      mode: 'mock',
    };
    for (const extra of [{ qualityPreset: 'ultra' }, { qualityPreset: 'ultra', ultra }]) {
      const refused = await post('/api/v1/runs/auto', { ...auto, ...extra });
      expect(refused.status).toBe(400);
    }
    expect(server.coordinator.hasStartCommand('ultra_start')).toBe(false);
    for (const extra of [{ qualityPreset: 'ultra' }, { qualityPreset: 'ultra', ultra }]) {
      const entry = await post(`/api/v1/sessions/${session.sessionId}/entries`, {
        intent: 'next',
        text: 'Hello',
        state: 'queued',
        ...extra,
      });
      expect(entry.status).toBe(400);
    }
    const { runId } = server.coordinator.startRun({
      schemaVersion: '0.1',
      commandId: 'start_ordinary',
      definition: linearCorral(['writer']),
      mode: 'mock',
    });
    expect(runId).toBeTruthy();
    for (const route of [
      `/api/v1/runs/${runId}/candidates`,
      `/api/v1/runs/${runId}/candidates/candidate_1/changes?tree=${'a'.repeat(40)}`,
    ])
      expect((await fetch(`${server.url}${route}`, { headers })).status).toBe(404);
    const command = await post(`/api/v1/runs/${runId}/commands`, {
      schemaVersion: '0.1',
      commandId: 'select_1',
      runId,
      type: 'select_candidate',
      payload: { candidateId: 'candidate_1', tree: 'a'.repeat(40) },
    });
    expect(command.status).toBe(400);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

type Recorded = { snapshot: StoredRun['snapshot']; projection: RunProjection; events: RunEvent[] };

it('a store with Ultra runs starts; those runs are refused with a clear error', async () => {
  const root = mkdtempSync(join(tmpdir(), 'corral-ultra-store-'));
  mkdirSync(join(root, '.corral'));
  const recorded = ultraRuns as unknown as Record<'tournament' | 'comparison', Recorded>;
  const seeded = openDatabase(join(root, '.corral', 'corral.db'));
  const store = new SqliteRunStore(seeded);
  for (const record of Object.values(recorded)) {
    const runId = record.events[0]!.runId;
    store.insertRun({ runId, snapshot: record.snapshot, projection: record.projection });
    store.appendEvents(runId, record.events);
  }
  seeded.close();
  const token = 'test-bootstrap-token-0123456789abcdef';
  const server = await startCorralServer({
    workspace: root,
    worktreeRoot: join(root, 'copies'),
    port: 0,
    bootstrapToken: token,
    agents: new ScriptedAgentAdapter({ turns: 1 }),
  });
  try {
    const login = await fetch(`${server.url}/api/v1/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: server.url },
      body: JSON.stringify({ token }),
    });
    const headers = {
      cookie: (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '',
      origin: server.url,
    };
    for (const record of Object.values(recorded)) {
      const runId = record.events[0]!.runId;
      for (const route of ['', '/snapshot', '/events', '/runtime-checkpoints']) {
        const refused = await fetch(`${server.url}/api/v1/runs/${runId}${route}`, { headers });
        expect(refused.status).toBe(404);
        expect(((await refused.json()) as { error: { message: string } }).error.message).toMatch(
          /Ultra/,
        );
      }
    }
    // The unfinished comparison was interrupted at start-up like any other run.
    const comparison = recorded.comparison.events[0]!.runId;
    expect(server.coordinator.findSnapshot(comparison)?.projection.status).toBe('interrupted');
    const { runId } = server.coordinator.startRun({
      schemaVersion: '0.1',
      commandId: 'start_ordinary',
      definition: linearCorral(['writer']),
      mode: 'mock',
    });
    expect((await fetch(`${server.url}/api/v1/runs/${runId}`, { headers })).status).toBe(200);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

const decision = {
  versionId: 'decision_1',
  commandId: 'adopt_1',
  minutesId: 'minutes_1',
  candidateId: 'candidate_1',
  supersedesVersionId: null,
  createdAt: '2026-10-23T00:00:00Z',
  content: {
    goal: 'Ship a readable report',
    scope: ['Report'],
    excludedScope: [],
    acceptanceCriteria: ['Reviewable output'],
    remainingDissent: [],
    evidence: [],
    risks: [],
    actions: ['Write report'],
    rejectedAlternatives: [],
  },
};

async function meeting() {
  const db = openDatabase(':memory:');
  databases.push(db);
  const clock = new FakeClock();
  const repository = new SqliteCorralRepository(db, { clock, newCorralId: () => 'team_1' });
  const source = await repository.createSession({
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
  const target = await repository.createSession({ projectId: 'default', title: 'Work' });
  if (!source.ok || !target.ok) throw new Error('fixture');
  db.prepare('UPDATE work_sessions SET meeting_json=? WHERE id=?').run(
    JSON.stringify({ ...source.session.meeting, decisions: [decision], decisionWithdrawals: [] }),
    source.session.sessionId,
  );
  const start = vi.fn<MeetingHandoffDeps['start']>(async (input) => ({
    runId: 'run_1',
    receipt: {
      commandId: input.commandId,
      runId: 'run_1',
      status: 'applied',
      acceptedSeq: 1,
      target: 'run:run_1',
      requestedBoundary: 'immediate',
      relatedEventIds: [],
    } satisfies Receipt,
  }));
  const service = new MeetingHandoffService(db, repository, {
    clock,
    start,
    previous: () => null,
    activeRun: () => false,
    cancelStart: async () => {},
    discuss: async () => ({ ok: true, outcome: 'started', roundId: 'round_1' }),
    runResult: () => null,
  });
  const request: MeetingHandoffRequest = {
    commandId: 'handoff_1',
    decisionVersionId: decision.versionId,
    target: { kind: 'existing', sessionId: target.session.sessionId },
    action: 'draft',
    execution: { kind: 'auto', choice: { modelProfile: 'model-a' } },
    mode: 'mock',
    targetHasDraft: false,
  };
  return { db, repository, service, start, request, sourceId: source.session.sessionId };
}

it('a meeting handoff cannot ask for Ultra', async () => {
  const f = await meeting();
  await expect(
    f.service.send(f.sourceId, {
      ...f.request,
      action: 'start',
      execution: {
        kind: 'auto',
        choice: { modelProfile: 'model-a' },
        qualityPreset: 'ultra',
        ultra,
      },
    } as unknown as MeetingHandoffRequest),
  ).rejects.toThrow('Invalid handoff fields.');
  expect(f.start).not.toHaveBeenCalled();
});

it('a handoff saved with Ultra is listed but refused, not started', async () => {
  const f = await meeting();
  const drafted = await f.service.send(f.sourceId, f.request);
  expect(drafted.state).toBe('drafted');
  // A draft saved before Ultra was removed, recorded the Ultra choice in its receipt and start input.
  const row = f.db
    .prepare('SELECT payload_json FROM meeting_handoffs WHERE command_id=?')
    .get(f.request.commandId) as { payload_json: string };
  const stored = JSON.parse(row.payload_json);
  const execution = { ...stored.receipt.execution, qualityPreset: 'ultra', ultra };
  stored.receipt.execution = execution;
  stored.start.execution = execution;
  f.db
    .prepare('UPDATE meeting_handoffs SET payload_json=? WHERE command_id=?')
    .run(JSON.stringify(stored), f.request.commandId);

  expect(f.service.receipt(f.sourceId, f.request.commandId)?.execution).toMatchObject({
    qualityPreset: 'ultra',
  });
  expect(f.service.list(f.sourceId)).toHaveLength(1);
  await expect(
    f.service.startDraft(f.sourceId, f.request.commandId, {
      commandId: 'launch_1',
      targetHasDraft: false,
    }),
  ).rejects.toThrow(/Ultra/);
  expect(f.start).not.toHaveBeenCalled();
  expect(f.service.receipt(f.sourceId, f.request.commandId)?.state).toBe('refused');
});

it('a session with an entry saved with Ultra still loads; new entries cannot name it', async () => {
  const f = await meeting();
  const sessionId = f.request.target.kind === 'existing' ? f.request.target.sessionId : '';
  const added = await f.repository.addSessionEntry(sessionId, {
    intent: 'next',
    text: 'Hello',
    state: 'refused',
  });
  if (!added.ok) throw new Error('fixture');
  const entries = added.session.entries.map((entry) => ({
    ...entry,
    qualityPreset: 'ultra',
    ultra,
    auto: { template: 'write_review', source: 'local', reason: 'Ultra', qualityPreset: 'ultra' },
  }));
  f.db
    .prepare('UPDATE work_sessions SET entries_json=? WHERE id=?')
    .run(JSON.stringify(entries), sessionId);
  const loaded = await f.repository.getSession(sessionId);
  expect(loaded?.entries[0]?.text).toBe('Hello');
  const refused = await f.repository.addSessionEntry(sessionId, {
    intent: 'next',
    text: 'Again',
    state: 'queued',
    qualityPreset: 'ultra',
  } as never);
  expect(refused.ok).toBe(false);
});
