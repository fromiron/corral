import type { MeetingHandoffRequest, Receipt } from '@corral/contracts';
import { openDatabase, SqliteCorralRepository } from '@corral/storage-sqlite';
import { FakeClock } from '@corral/testkit';
import { afterEach, expect, it, vi } from 'vitest';
import { MeetingHandoffService, type MeetingHandoffStart } from '../src/meeting-handoffs.ts';

const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

async function fixture() {
  const db = openDatabase(':memory:');
  databases.push(db);
  const clock = new FakeClock();
  const repository = new SqliteCorralRepository(db, { clock, newCorralId: () => 'team' });
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
  if (!source.ok || !target.ok || !source.session.meeting) throw new Error('fixture missing');
  const meeting = {
    ...source.session.meeting,
    decisions: [
      {
        versionId: 'decision',
        commandId: 'adopt',
        minutesId: 'minutes',
        candidateId: 'candidate',
        supersedesVersionId: null,
        createdAt: clock.nowIso(),
        content: {
          goal: 'Prepare report',
          scope: ['Report'],
          excludedScope: [],
          acceptanceCriteria: ['Reviewed'],
          remainingDissent: [],
          evidence: [],
          risks: [],
          actions: ['Write'],
          rejectedAlternatives: [],
        },
      },
    ],
  };
  await repository.updateSession(source.session.sessionId, {
    expectedRevision: source.session.revision,
    meeting,
  });
  const starts = new Map<string, { runId: string | null; receipt: Receipt }>();
  const start = vi.fn(async (input: MeetingHandoffStart) => {
    const result = {
      runId: 'run_1',
      receipt: {
        commandId: input.commandId,
        runId: 'run_1',
        status: 'applied' as const,
        acceptedSeq: 1,
        target: 'run:run_1',
        requestedBoundary: 'immediate' as const,
        relatedEventIds: [],
      },
    };
    starts.set(input.commandId, result);
    return result;
  });
  const cancelStart = vi.fn(async () => {});
  const deps = {
    clock,
    start,
    cancelStart,
    activeRun: () => false,
    previous: (id: string) => starts.get(id) ?? null,
    runResult: () => ({ status: 'running' as const, artifactVersionId: null, text: null }),
    discuss: vi.fn(async () => ({ ok: true as const, outcome: 'started' as const })),
  };
  const service = new MeetingHandoffService(db, repository, deps);
  const request: MeetingHandoffRequest = {
    commandId: 'handoff',
    decisionVersionId: 'decision',
    target: { kind: 'existing', sessionId: target.session.sessionId },
    action: 'start',
    execution: { kind: 'auto', choice: { modelProfile: 'model-a' } },
    mode: 'mock',
    targetHasDraft: false,
  };
  return {
    db,
    repository,
    sourceId: source.session.sessionId,
    service,
    start,
    cancelStart,
    deps,
    request,
    meeting,
    clock,
  };
}

it('[TC-MEET-003-F] an uncertain start cannot newly execute a decision withdrawn before retry', async () => {
  const f = await fixture();
  f.start.mockRejectedValueOnce(new Error('start never reached coordinator'));
  expect(await f.service.send(f.sourceId, f.request)).toMatchObject({
    state: 'uncertain',
    runId: null,
  });
  const current = await f.repository.getSession(f.sourceId);
  if (!current?.meeting) throw new Error('fixture missing');
  await f.repository.updateSession(f.sourceId, {
    expectedRevision: current.revision,
    meeting: {
      ...current.meeting,
      decisionWithdrawals: [
        {
          commandId: 'withdraw',
          versionId: 'decision',
          reason: 'Further discussion',
          createdAt: f.clock.nowIso(),
        },
      ],
    },
  });
  const restarted = new MeetingHandoffService(f.db, f.repository, f.deps);
  await expect(restarted.send(f.sourceId, f.request)).rejects.toThrow(/adopted|decision|withdraw/i);
  expect(f.start).toHaveBeenCalledTimes(1);
});

it('[TC-MEET-003-F] cancellation failure remains retryable after restart and never starts more work', async () => {
  const f = await fixture();
  await f.service.send(f.sourceId, f.request);
  f.cancelStart.mockRejectedValueOnce(new Error('cancellation not recorded'));
  await f.service.cancel(f.sourceId, f.request.commandId).catch(() => undefined);
  expect(f.service.receipt(f.sourceId, f.request.commandId)).toMatchObject({
    state: 'uncertain',
    runId: 'run_1',
  });
  const restarted = new MeetingHandoffService(f.db, f.repository, f.deps);
  expect(await restarted.send(f.sourceId, f.request)).toMatchObject({
    state: 'cancelled',
    runId: 'run_1',
  });
  expect(f.cancelStart).toHaveBeenCalledTimes(2);
  expect(f.start).toHaveBeenCalledTimes(1);
});
