import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CorralDefinition, type MeetingHandoffRequest, type Receipt } from '@corral/contracts';
import { openDatabase, SqliteCorralRepository } from '@corral/storage-sqlite';
import { FakeClock } from '@corral/testkit';
import { afterEach, expect, it, vi } from 'vitest';
import researchTeam from '../../../examples/research-team.corral.json' with { type: 'json' };
import { type MeetingHandoffDeps, MeetingHandoffService } from '../src/meeting-handoffs.ts';

const databases: ReturnType<typeof openDatabase>[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});
const config = {
  version: 1 as const,
  participants: ['a', 'b'].map((participantId) => ({
    participantId,
    name: participantId,
    prompt: 'Review',
    modelProfile: 'model-a',
  })),
  secretary: { modelProfile: 'model-a' },
};
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
    excludedScope: ['Deployment'],
    acceptanceCriteria: ['Reviewable output'],
    remainingDissent: ['b prefers a smaller scope'],
    evidence: ['Selected source'],
    risks: ['Source is incomplete'],
    actions: ['Write report'],
    rejectedAlternatives: ['Deploy automatically'],
  },
};
const accepted = (id: string): Receipt => ({
  commandId: id,
  runId: 'run_1',
  status: 'applied',
  acceptedSeq: 1,
  target: 'run:run_1',
  requestedBoundary: 'immediate',
  relatedEventIds: [],
});

async function setup(path = ':memory:') {
  const db = openDatabase(path);
  databases.push(db);
  const clock = new FakeClock();
  const repository = new SqliteCorralRepository(db, { clock, newCorralId: () => 'team_1' });
  const source = await repository.createSession({
    projectId: 'default',
    title: 'Meeting',
    meeting: config,
  });
  const target = await repository.createSession({ projectId: 'default', title: 'Work' });
  if (!source.ok || !target.ok) throw new Error('fixture');
  db.prepare('UPDATE work_sessions SET meeting_json=? WHERE id=?').run(
    JSON.stringify({ ...source.session.meeting, decisions: [decision], decisionWithdrawals: [] }),
    source.session.sessionId,
  );
  const starts = new Map<string, { runId: string | null; receipt: Receipt }>();
  const start = vi.fn<MeetingHandoffDeps['start']>(async (input) => {
    const result = { runId: 'run_1', receipt: accepted(input.commandId) };
    starts.set(input.commandId, result);
    return result;
  });
  const activeRun = vi.fn(() => false);
  const cancelStart = vi.fn(async () => {});
  const discuss = vi.fn(async () => ({
    ok: true as const,
    outcome: 'started' as const,
    roundId: 'round_1',
  }));
  const deps = {
    clock,
    start,
    previous: (id: string) => starts.get(id) ?? null,
    activeRun,
    cancelStart,
    discuss,
    runResult: () => ({
      status: 'succeeded' as const,
      artifactVersionId: 'version_1',
      text: 'The report.',
    }),
  };
  const service = new MeetingHandoffService(db, repository, deps);
  const request: MeetingHandoffRequest = {
    commandId: 'handoff_1',
    decisionVersionId: decision.versionId,
    target: { kind: 'existing', sessionId: target.session.sessionId },
    action: 'start',
    execution: { kind: 'auto', choice: { modelProfile: 'model-a' } },
    mode: 'mock',
    targetHasDraft: false,
  };
  return {
    db,
    repository,
    source: source.session,
    target: target.session,
    service,
    request,
    deps,
    start,
    activeRun,
    cancelStart,
    starts,
    discuss,
  };
}

it('hands off only the adopted brief and preserves session execution defaults', async () => {
  const f = await setup();
  const receipt = await f.service.send(f.source.sessionId, f.request);
  expect(receipt).toMatchObject({
    state: 'started',
    runId: 'run_1',
    targetSessionId: f.target.sessionId,
  });
  expect(receipt.brief).toContain('b prefers a smaller scope');
  expect(receipt.brief).toContain('Rejected background');
  const target = await f.repository.getSession(f.target.sessionId);
  expect(target).toMatchObject({ corralId: null, auto: null });
  expect(target?.entries).toHaveLength(1);
  expect(target?.entries[0]).toMatchObject({
    state: 'started',
    runId: 'run_1',
    commandId: receipt.startCommandId,
  });
  expect(target?.entries[0]?.meetingHandoff).toMatchObject({
    sourceSessionId: f.source.sessionId,
    commandId: f.request.commandId,
    decisionVersionId: decision.versionId,
  });
  expect(f.service.list(f.source.sessionId)).toEqual(f.service.list(f.target.sessionId));
  expect(f.start).toHaveBeenCalledTimes(1);
});

it('refuses candidates, withdrawn decisions, other projects, meetings and archives before any start', async () => {
  const f = await setup();
  await expect(
    f.service.send(f.source.sessionId, { ...f.request, decisionVersionId: 'candidate_1' }),
  ).rejects.toThrow('adopted');
  for (const sessionId of [f.source.sessionId, 'missing']) {
    await expect(
      f.service.send(f.source.sessionId, { ...f.request, target: { kind: 'existing', sessionId } }),
    ).rejects.toThrow();
  }
  const project = await f.repository.createProject({ name: 'Other' });
  if (!project.ok) throw new Error('fixture');
  const other = await f.repository.createSession({
    projectId: project.project.projectId,
    title: 'Other',
  });
  if (!other.ok) throw new Error('fixture');
  await expect(
    f.service.send(f.source.sessionId, {
      ...f.request,
      target: { kind: 'existing', sessionId: other.session.sessionId },
    }),
  ).rejects.toThrow();
  await f.repository.updateSession(f.target.sessionId, {
    expectedRevision: f.target.revision,
    archived: true,
  });
  await expect(f.service.send(f.source.sessionId, f.request)).rejects.toThrow();
  const meeting = (await f.repository.getSession(f.source.sessionId))?.meeting;
  f.db.prepare('UPDATE work_sessions SET meeting_json=? WHERE id=?').run(
    JSON.stringify({
      ...meeting,
      decisionWithdrawals: [
        {
          commandId: 'withdraw_1',
          versionId: decision.versionId,
          reason: 'Changed',
          createdAt: decision.createdAt,
        },
      ],
    }),
    f.source.sessionId,
  );
  await expect(
    f.service.send(f.source.sessionId, { ...f.request, target: { kind: 'new', title: 'New' } }),
  ).rejects.toThrow('adopted');
  expect(f.start).not.toHaveBeenCalled();
});

it.each(['draft', 'active', 'composer', 'pending'] as const)(
  'preserves the target and records only a draft for %s',
  async (reason) => {
    const f = await setup();
    if (reason === 'active') f.activeRun.mockReturnValue(true);
    if (reason === 'pending')
      await f.repository.addSessionEntry(f.target.sessionId, {
        intent: 'next',
        text: 'Do not overwrite',
        state: 'undelivered',
      });
    const receipt = await f.service.send(f.source.sessionId, {
      ...f.request,
      action: reason === 'draft' ? 'draft' : 'start',
      targetHasDraft: reason === 'composer',
    });
    expect(receipt.state).toBe('drafted');
    expect(f.start).not.toHaveBeenCalled();
    expect((await f.repository.getSession(f.target.sessionId))?.entries.at(-1)).toMatchObject({
      state: 'undelivered',
      runId: null,
    });
  },
);

it('repeats a new-session command without another session, entry or run, including service recovery', async () => {
  const f = await setup();
  const request = { ...f.request, target: { kind: 'new' as const, title: 'New work' } };
  const [first, second] = await Promise.all([
    f.service.send(f.source.sessionId, request),
    f.service.send(f.source.sessionId, request),
  ]);
  expect(second).toEqual(first);
  const restarted = new MeetingHandoffService(f.db, f.repository, f.deps);
  expect(await restarted.send(f.source.sessionId, request)).toEqual(first);
  expect(restarted.receipt(f.source.sessionId, request.commandId)).toEqual(first);
  expect(await f.repository.listSessions('default')).toHaveLength(3);
  expect((await f.repository.getSession(first.targetSessionId))?.entries).toHaveLength(1);
  expect(f.start).toHaveBeenCalledTimes(1);
  await expect(restarted.send(f.source.sessionId, { ...request, action: 'draft' })).rejects.toThrow(
    'different',
  );
});

it('reconciles a lost start response from its receipt without dispatching again', async () => {
  const f = await setup();
  f.start.mockImplementationOnce(async (input) => {
    f.starts.set(input.commandId, { runId: 'run_1', receipt: accepted(input.commandId) });
    throw new Error('connection dropped');
  });
  expect(await f.service.send(f.source.sessionId, f.request)).toMatchObject({
    state: 'started',
    runId: 'run_1',
  });
  expect(f.service.receipt(f.source.sessionId, f.request.commandId)).toMatchObject({
    state: 'started',
    runId: 'run_1',
  });
  expect(f.start).toHaveBeenCalledTimes(1);
});

it('cancellation wins a start race and later resends never restart it', async () => {
  const f = await setup();
  let finish!: (value: { runId: string; receipt: Receipt }) => void;
  f.start.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const sending = f.service.send(f.source.sessionId, f.request);
  await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(1));
  expect(await f.service.cancel(f.source.sessionId, f.request.commandId)).toMatchObject({
    state: 'cancelled',
  });
  finish({ runId: 'run_1', receipt: accepted('start') });
  expect(await sending).toMatchObject({ state: 'cancelled', runId: 'run_1' });
  expect(await f.service.send(f.source.sessionId, f.request)).toMatchObject({ state: 'cancelled' });
  expect(f.cancelStart).toHaveBeenCalledTimes(2);
  expect(f.start).toHaveBeenCalledTimes(1);
});

it('reads never start a round and explicit rediscussion pins the terminal result', async () => {
  const f = await setup();
  const receipt = await f.service.send(f.source.sessionId, f.request);
  f.service.receipt(f.source.sessionId, f.request.commandId);
  f.service.list(f.source.sessionId);
  expect(f.discuss).not.toHaveBeenCalled();
  await f.service.rediscuss(f.source.sessionId, f.request.commandId, {
    commandId: 'discuss_1',
    mode: 'mock',
  });
  expect(f.discuss).toHaveBeenCalledWith(
    f.source.sessionId,
    expect.objectContaining({
      text: expect.stringContaining('The report.'),
      commandId: 'discuss_1',
      kind: 'message',
    }),
  );
  expect(receipt.result?.artifactVersionId).toBe('version_1');
});

it('explicitly launches a draft once using its pinned request and original entry', async () => {
  const f = await setup();
  const drafted = await f.service.send(f.source.sessionId, { ...f.request, action: 'draft' });
  const request = { commandId: 'launch_1', targetHasDraft: false };
  const started = await f.service.startDraft(f.source.sessionId, f.request.commandId, request);
  expect(started).toMatchObject({
    state: 'started',
    entryId: drafted.entryId,
    startCommandId: drafted.startCommandId,
    execution: drafted.execution,
  });
  expect(await f.service.startDraft(f.source.sessionId, f.request.commandId, request)).toEqual(
    started,
  );
  expect((await f.repository.getSession(f.target.sessionId))?.entries).toHaveLength(1);
  expect(f.start).toHaveBeenCalledTimes(1);
});

it('explicit draft launch still preserves active work and unsent inputs', async () => {
  const f = await setup();
  await f.service.send(f.source.sessionId, { ...f.request, action: 'draft' });
  expect(
    await f.service.startDraft(f.source.sessionId, f.request.commandId, {
      commandId: 'launch_1',
      targetHasDraft: true,
    }),
  ).toMatchObject({ state: 'drafted' });
  f.activeRun.mockReturnValue(true);
  expect(
    await f.service.startDraft(f.source.sessionId, f.request.commandId, {
      commandId: 'launch_2',
      targetHasDraft: false,
    }),
  ).toMatchObject({ state: 'drafted' });
  expect(f.start).not.toHaveBeenCalled();
});

it('pins a chosen Corral revision across later edits and draft launch', async () => {
  const f = await setup();
  const saved = await f.repository.save({
    definition: CorralDefinition.parse(researchTeam),
    expectedDefinitionRevision: null,
    layout: { nodes: {}, viewport: { x: 0, y: 0, zoom: 1 } },
  });
  if (!saved.ok) throw new Error('fixture');
  const draft = await f.service.send(f.source.sessionId, {
    ...f.request,
    action: 'draft',
    execution: { kind: 'corral', corralId: saved.record.corralId },
  });
  await f.repository.save({
    definition: { ...saved.record.definition, name: 'Edited team' },
    expectedDefinitionRevision: 1,
    layout: saved.record.layout,
  });
  await f.service.startDraft(f.source.sessionId, f.request.commandId, {
    commandId: 'launch_1',
    targetHasDraft: false,
  });
  expect(f.start).toHaveBeenCalledWith(
    expect.objectContaining({ definitionRevision: 1, definition: saved.record.definition }),
  );
  expect(draft.definitionRevision).toBe(1);
  expect((await f.repository.getSession(f.target.sessionId))?.corralId).toBeNull();
});

it('an active run appearing during preparation falls back to a draft', async () => {
  const f = await setup();
  f.start.mockImplementationOnce(async (input) => ({
    runId: null,
    receipt: {
      ...accepted(input.commandId),
      status: 'rejected',
      error: { code: 'RUN_ALREADY_ACTIVE', message: 'The target session is already running.' },
    },
  }));
  expect(await f.service.send(f.source.sessionId, f.request)).toMatchObject({
    state: 'drafted',
    runId: null,
  });
  expect((await f.repository.getSession(f.target.sessionId))?.entries[0]).toMatchObject({
    state: 'undelivered',
  });
});

it('a cancelled start whose response is lost still cancels the committed run', async () => {
  const f = await setup();
  let finish!: () => void;
  f.start.mockImplementationOnce(async (input) => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    f.starts.set(input.commandId, { runId: 'run_1', receipt: accepted(input.commandId) });
    throw new Error('lost response');
  });
  const sending = f.service.send(f.source.sessionId, f.request);
  await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(1));
  await f.service.cancel(f.source.sessionId, f.request.commandId);
  finish();
  expect(await sending).toMatchObject({ state: 'cancelled', runId: 'run_1' });
  expect(f.cancelStart).toHaveBeenCalledTimes(2);
});

it('reopens a persisted draft receipt and starts the original target and entry', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'corral-handoff-'));
  directories.push(directory);
  const file = join(directory, 'workspace.sqlite');
  const f = await setup(file);
  const draft = await f.service.send(f.source.sessionId, {
    ...f.request,
    action: 'draft',
    target: { kind: 'new', title: 'New' },
  });
  f.db.close();
  const reopened = openDatabase(file);
  databases.push(reopened);
  const repository = new SqliteCorralRepository(reopened, {
    clock: f.deps.clock,
    newCorralId: () => 'unused',
  });
  const service = new MeetingHandoffService(reopened, repository, f.deps);
  expect(service.receipt(f.source.sessionId, f.request.commandId)).toEqual(draft);
  expect(
    await service.startDraft(f.source.sessionId, f.request.commandId, {
      commandId: 'launch_1',
      targetHasDraft: false,
    }),
  ).toMatchObject({
    state: 'started',
    targetSessionId: draft.targetSessionId,
    entryId: draft.entryId,
  });
  expect((await repository.getSession(draft.targetSessionId))?.entries).toHaveLength(1);
});
