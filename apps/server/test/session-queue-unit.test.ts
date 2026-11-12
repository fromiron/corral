import type { RunStatus } from '@corral/contracts';
import {
  type CorralRepository,
  planSessionEntry,
  queuedSessionCommandId,
  type RunProjection,
  type SessionEntry,
  type WorkSession,
} from '@corral/core';
import { expect, it } from 'vitest';
import {
  conversationRun,
  createSessionQueue,
  type QueuedStartRequest,
  type QueueRun,
} from '../src/session-queue.ts';

// The queue pass with fake dependencies: one pass at a time per session, and the conversation
// run chosen by the screen's rule.

const START = { choice: { modelProfile: 'model-a' }, mode: 'mock' as const, team: 'none' as const };
const entry = (entryId: string, extra: Partial<SessionEntry> = {}): SessionEntry => ({
  entryId,
  intent: 'queue',
  text: `text ${entryId}`,
  createdAt: 'x',
  state: 'queued',
  runId: null,
  executionId: null,
  detail: null,
  start: START,
  ...extra,
});
const run = (runId: string, startedAt: string, status: RunStatus = 'succeeded'): QueueRun => ({
  runId,
  sessionId: 's1',
  status,
  startedAt,
});

function harness(
  options: {
    startDelayMs?: number;
    failStart?: boolean;
    refuseStart?: boolean;
    entries?: SessionEntry[];
    autoStart?: boolean;
    /** The run each carried directive was sent in. */
    directiveRuns?: Record<string, string>;
  } = {},
) {
  const runs: QueueRun[] = [
    run('run_a', '2026-01-01T00:00:01Z'),
    run('run_b', '2026-01-01T00:00:02Z'),
  ];
  const session: WorkSession = {
    sessionId: 's1',
    projectId: 'default',
    corralId: null,
    auto: null,
    title: 't',
    objective: '',
    pinned: false,
    revision: 1,
    createdAt: 'x',
    updatedAt: 'x',
    archivedAt: null,
    autoStart: options.autoStart ?? true,
    entries: options.entries ?? [entry('e1'), entry('e2')],
  };
  const starts: QueuedStartRequest[] = [];
  const logs: [string, string][] = [];
  let fail = options.failStart ?? false;
  let added = 0;
  const repository: Pick<
    CorralRepository,
    'getSession' | 'updateSessionEntry' | 'addSessionEntry'
  > = {
    getSession: async () => structuredClone(session),
    // The real plan, so a carried directive is recorded once as the stores record it.
    addSessionEntry: async (sessionId, item) => {
      added += 1;
      const planned = planSessionEntry(structuredClone(session), sessionId, item, {
        now: 'x',
        entryId: `carried_${added}`,
      });
      if (planned.ok) session.entries = planned.session.entries;
      return planned;
    },
    updateSessionEntry: async (_sessionId, entryId, change) => {
      const found = session.entries.find((item) => item.entryId === entryId);
      if (!found) return { ok: false, error: 'not_found', message: 'none' };
      Object.assign(found, change);
      return { ok: true, session: structuredClone(session) };
    },
  };
  const queue = createSessionQueue({
    repository,
    runs: () => runs,
    directiveRun: (_sessionId, directiveId) => options.directiveRuns?.[directiveId] ?? null,
    start: async (request) => {
      starts.push(request);
      if (options.startDelayMs) await new Promise((r) => setTimeout(r, options.startDelayMs));
      if (fail) throw new Error('/home/someone/secret path and body text');
      if (options.refuseStart)
        return {
          ok: true,
          runId: null,
          error: { code: 'TARGET_NOT_FOUND', message: 'no such team' },
          autoRoute: null,
        };
      const runId = `run_new_${starts.length}`;
      runs.push(run(runId, `2026-01-01T00:01:0${starts.length}Z`, 'running'));
      return { ok: true, runId, error: null, autoRoute: null };
    },
    log: (sessionId, code) => logs.push([sessionId, code]),
  });
  const states = () => session.entries.map((item) => item.state);
  return {
    runs,
    session,
    starts,
    logs,
    queue,
    states,
    setFail: (value: boolean) => (fail = value),
  };
}

it('two runs of a session ending together start the first entry once', async () => {
  const h = harness({ startDelayMs: 20 });
  await Promise.all([h.queue.onRunEnded('run_a'), h.queue.onRunEnded('run_b')]);
  expect(h.starts).toHaveLength(1);
  expect(h.starts[0]?.commandId).toBe(queuedSessionCommandId('s1', entry('e1')));
  expect(h.states()).toEqual(['started', 'queued']);
});

it('the same end reported twice starts the first entry once', async () => {
  const h = harness({ startDelayMs: 20 });
  await Promise.all([h.queue.onRunEnded('run_a'), h.queue.onRunEnded('run_a')]);
  expect(h.starts).toHaveLength(1);
  expect(h.states()).toEqual(['started', 'queued']);
});

it('an end or a new entry reported while a pass is starting does not start again', async () => {
  const h = harness({ startDelayMs: 40 });
  const first = h.queue.onRunEnded('run_a');
  await new Promise((r) => setTimeout(r, 10));
  await Promise.all([first, h.queue.onRunEnded('run_b'), h.queue.onEntryQueued('s1')]);
  expect(h.starts).toHaveLength(1);
  expect(h.states()).toEqual(['started', 'queued']);
});

it('new requests that started or were refused before the queue are not started again', async () => {
  // A new request keeps its start snapshot after it starts or is refused, ahead of the queue.
  const h = harness({
    entries: [
      entry('sent', { intent: 'next', state: 'started', runId: 'run_b', commandId: 'cmd_sent' }),
      entry('refused', { intent: 'next', state: 'refused', detail: 'no' }),
      entry('e1'),
    ],
  });
  await h.queue.onRunEnded('run_b');
  expect(h.starts.map((request) => request.brief)).toEqual(['text e1']);
  expect(h.states()).toEqual(['started', 'refused', 'started']);
  // When that run ends, nothing is left to start.
  for (const item of h.runs) item.status = 'succeeded';
  await h.queue.onRunEnded('run_new_1');
  expect(h.starts).toHaveLength(1);
  expect(h.session.entries.map((item) => item.runId)).toEqual(['run_b', null, 'run_new_1']);
});

it('a queued entry with no open run starts; with an open run it waits', async () => {
  const h = harness();
  await h.queue.onEntryQueued('s1');
  expect(h.starts).toHaveLength(1);
  await h.queue.onEntryQueued('s1');
  expect(h.starts).toHaveLength(1);
});

it('a start that throws is logged by code only and later passes still run', async () => {
  const h = harness({ failStart: true });
  await h.queue.onRunEnded('run_a');
  expect(h.logs).toEqual([['s1', 'Error']]);
  expect(h.states()).toEqual(['queued', 'queued']);
  h.setFail(false);
  await h.queue.onRunEnded('run_b');
  expect(h.starts).toHaveLength(2);
  expect(h.states()).toEqual(['started', 'queued']);
});

it('continues through the ended run that started last, as the screen does', async () => {
  const h = harness();
  // run_b started later but is listed first, and it ended before run_a.
  h.runs.reverse();
  await h.queue.onRunEnded('run_a');
  expect(h.starts[0]?.conversation).toEqual({ throughRunId: 'run_b' });
  expect(Object.keys(h.starts[0] ?? {}).sort()).toEqual(
    ['brief', 'choice', 'commandId', 'conversation', 'mode', 'sessionId', 'team'].sort(),
  );
});

it('chooses the conversation run like the screen, open runs and other sessions aside', () => {
  const runs: QueueRun[] = [
    run('run_late_open', '2026-01-01T00:00:09Z', 'running'),
    { ...run('run_other', '2026-01-01T00:00:08Z'), sessionId: 's2' },
    run('run_mid', '2026-01-01T00:00:05Z', 'failed'),
    run('run_early', '2026-01-01T00:00:01Z'),
  ];
  expect(conversationRun(runs, 's1')).toBe('run_mid');
  expect(conversationRun([], 's1')).toBeNull();
  // The list is not in start order: the run that started last wins wherever it is listed.
  const shuffled = [
    run('run_one', '2026-01-01T00:00:01Z'),
    run('run_three', '2026-01-01T00:00:03Z'),
    run('run_two', '2026-01-01T00:00:02Z'),
  ];
  expect(conversationRun(shuffled, 's1')).toBe('run_three');
  expect(conversationRun([...shuffled].reverse(), 's1')).toBe('run_three');
  // Equal start times: the earlier listed of the two wins after the reverse, as on the screen.
  const tie = [run('run_x', '2026-01-01T00:00:01Z'), run('run_y', '2026-01-01T00:00:01Z')];
  expect(conversationRun(tie, 's1')).toBe('run_x');
});

// Carrying an unread directive over (features/composer-flow.md, "대기 요청과 넘겨받기").
const PERMITTED = { ...START, permissionMode: 'ask' as const };
const source = (extra: Partial<SessionEntry> = {}) =>
  entry('src', {
    intent: 'next',
    state: 'started',
    runId: 'run_b',
    commandId: 'cmd_src',
    start: PERMITTED,
    permissionMode: 'ask',
    ...extra,
  });
const directiveView = (directiveId: string, status = 'expired', target = 'ex_1') => ({
  directiveId,
  targetExecutionId: target,
  text: `unread ${directiveId}`,
  status,
  commandId: null,
  acceptedSeq: 1,
  contextSnapshotId: null,
  modelCallId: null,
  reason: null,
});
const projectionOf = (directives: ReturnType<typeof directiveView>[], target = 'succeeded') =>
  ({
    executions: { ex_1: { status: target }, ex_2: { status: 'succeeded' } },
    directiveOrder: directives.map((d) => d.directiveId),
    directives: Object.fromEntries(directives.map((d) => [d.directiveId, d])),
  }) as unknown as RunProjection;

it('carries an unread directive to the front of the queue and starts it with the source start', async () => {
  const h = harness({ entries: [source(), entry('plain', { start: START })] });
  await h.queue.onDirectivesExpired('run_b', projectionOf([directiveView('dir_1')]));
  expect(h.starts).toHaveLength(1);
  expect(h.starts[0]).toMatchObject({ ...PERMITTED, brief: 'unread dir_1', sessionId: 's1' });
  const carried = h.session.entries.find((item) => item.carriedFrom === 'dir_1');
  expect(carried).toMatchObject({
    intent: 'queue',
    state: 'started',
    start: PERMITTED,
    permissionMode: 'ask',
    runId: 'run_new_1',
  });
  expect(h.starts[0]?.commandId).toBe(queuedSessionCommandId('s1', carried as SessionEntry));
  expect(h.session.entries.find((item) => item.entryId === 'plain')?.state).toBe('queued');
});

it('starts a carried entry with autoStart off, and not the plain entry behind it', async () => {
  const h = harness({ autoStart: false, entries: [source(), entry('plain', { start: START })] });
  await h.queue.onDirectivesExpired('run_b', projectionOf([directiveView('dir_1')]));
  expect(h.starts.map((request) => request.brief)).toEqual(['unread dir_1']);
  for (const item of h.runs) item.status = 'succeeded';
  await h.queue.onRunEnded('run_new_1');
  expect(h.starts).toHaveLength(1);
  expect(h.session.entries.find((item) => item.entryId === 'plain')?.state).toBe('queued');
});

it('starts a carried entry saved after the run end was already reported', async () => {
  const h = harness({ entries: [source()] });
  await h.queue.onRunEnded('run_b');
  expect(h.starts).toHaveLength(0);
  await h.queue.onDirectivesExpired('run_b', projectionOf([directiveView('dir_1')]));
  expect(h.starts.map((request) => request.brief)).toEqual(['unread dir_1']);
});

it('a carried entry waits for an open run to end', async () => {
  // One role of a team ended first; the run is still going.
  const h = harness({ entries: [source()] });
  const open = h.runs.find((item) => item.runId === 'run_b');
  if (open) open.status = 'running';
  await h.queue.onDirectivesExpired('run_b', projectionOf([directiveView('dir_1')]));
  expect(h.starts).toHaveLength(0);
  expect(h.session.entries.find((item) => item.carriedFrom === 'dir_1')?.state).toBe('queued');
  if (open) open.status = 'succeeded';
  await h.queue.onRunEnded('run_b');
  expect(h.starts.map((request) => request.brief)).toEqual(['unread dir_1']);
});

it('carries nothing without the start of the request that started the run', async () => {
  const { start: _start, permissionMode: _mode, ...bare } = source();
  const h = harness({ entries: [bare] });
  await h.queue.onDirectivesExpired('run_b', projectionOf([directiveView('dir_1')]));
  expect(h.session.entries).toHaveLength(1);
  expect(h.starts).toHaveLength(0);
});

it('carries nothing for a failed target, a cancelled run or a directive already read', async () => {
  const h = harness({ entries: [source()] });
  await h.queue.onDirectivesExpired('run_b', projectionOf([directiveView('dir_1')], 'failed'));
  await h.queue.onDirectivesExpired(
    'run_b',
    projectionOf([directiveView('dir_2', 'not_delivered'), directiveView('dir_3', 'delivered')]),
  );
  expect(h.session.entries).toHaveLength(1);
  expect(h.starts).toHaveLength(0);
});

it('the same directive reported twice is carried and started once', async () => {
  const h = harness({ entries: [source()], startDelayMs: 20 });
  const projection = projectionOf([directiveView('dir_1')]);
  await Promise.all([
    h.queue.onDirectivesExpired('run_b', projection),
    h.queue.onDirectivesExpired('run_b', projection),
    h.queue.onRunEnded('run_b'),
  ]);
  await h.queue.onDirectivesExpired('run_b', projection);
  expect(h.session.entries.filter((item) => item.carriedFrom === 'dir_1')).toHaveLength(1);
  expect(h.starts).toHaveLength(1);
});

it('carries a directive as soon as it expires, ahead of an earlier one still waiting', async () => {
  const h = harness({ entries: [source(), entry('plain', { start: START })] });
  const open = h.runs.find((item) => item.runId === 'run_b');
  if (open) open.status = 'running';
  // The later directive's target ended first; the earlier one is still waiting to be read.
  const later = directiveView('dir_late', 'expired', 'ex_2');
  await h.queue.onDirectivesExpired(
    'run_b',
    projectionOf([directiveView('dir_early', 'queued'), later], 'active'),
  );
  expect(h.session.entries.filter((item) => item.carriedFrom).map((item) => item.text)).toEqual([
    'unread dir_late',
  ]);
  await h.queue.onDirectivesExpired('run_b', projectionOf([directiveView('dir_early'), later]));
  expect(h.session.entries.filter((item) => item.carriedFrom).map((item) => item.text)).toEqual([
    'unread dir_late',
    'unread dir_early',
  ]);
  // Carried ones start in the order carried, ahead of the plain queue.
  if (open) open.status = 'succeeded';
  await h.queue.onRunEnded('run_b');
  for (const item of h.runs) item.status = 'succeeded';
  await h.queue.onRunEnded('run_new_1');
  for (const item of h.runs) item.status = 'succeeded';
  await h.queue.onRunEnded('run_new_2');
  expect(h.starts.map((request) => request.brief)).toEqual([
    'unread dir_late',
    'unread dir_early',
    'text plain',
  ]);
});

it('directives expiring together are carried in the order sent', async () => {
  const h = harness({ entries: [source()] });
  const open = h.runs.find((item) => item.runId === 'run_b');
  if (open) open.status = 'running';
  await h.queue.onDirectivesExpired(
    'run_b',
    projectionOf([directiveView('dir_1'), directiveView('dir_2'), directiveView('dir_3')]),
  );
  expect(h.session.entries.filter((item) => item.carriedFrom).map((item) => item.text)).toEqual([
    'unread dir_1',
    'unread dir_2',
    'unread dir_3',
  ]);
});

it('a carried entry whose start is refused is recorded refused, as any queued entry', async () => {
  const h = harness({ entries: [source()], refuseStart: true });
  await h.queue.onDirectivesExpired('run_b', projectionOf([directiveView('dir_1')]));
  expect(h.session.entries.find((item) => item.carriedFrom === 'dir_1')).toMatchObject({
    state: 'refused',
    runId: null,
    detail: 'no such team',
  });
});

// A carried request whose run the person then cancelled follows autoStart like any other.
const carriedFrom = (directiveId: string, extra: Partial<SessionEntry> = {}) =>
  entry(`c_${directiveId}`, {
    carriedFrom: directiveId,
    start: START,
    text: directiveId,
    ...extra,
  });
const ending = (h: ReturnType<typeof harness>, runId: string, status: RunStatus) => {
  const found = h.runs.find((item) => item.runId === runId);
  if (found) found.status = status;
  return h.queue.onRunEnded(runId);
};

it('with autoStart off, a request carried from a cancelled run stays queued', async () => {
  const h = harness({
    autoStart: false,
    entries: [carriedFrom('dir_1')],
    directiveRuns: { dir_1: 'run_b' },
  });
  await ending(h, 'run_b', 'cancelled');
  expect(h.starts).toHaveLength(0);
  expect(h.states()).toEqual(['queued']);
});

it('with autoStart on, a request carried from a cancelled run starts as any queued request', async () => {
  const h = harness({ entries: [carriedFrom('dir_1')], directiveRuns: { dir_1: 'run_b' } });
  await ending(h, 'run_b', 'cancelled');
  expect(h.starts.map((request) => request.brief)).toEqual(['dir_1']);
});

it('with autoStart off, a request carried from a run that failed, succeeded or was interrupted starts', async () => {
  for (const status of ['failed', 'succeeded', 'interrupted'] as const) {
    const h = harness({
      autoStart: false,
      entries: [carriedFrom('dir_1')],
      directiveRuns: { dir_1: 'run_b' },
    });
    await ending(h, 'run_b', status);
    expect(h.starts.map((request) => request.brief)).toEqual(['dir_1']);
  }
});

it('a later run of the session that succeeds does not give the cancelled run its carry back', async () => {
  const h = harness({
    autoStart: false,
    entries: [carriedFrom('dir_1')],
    directiveRuns: { dir_1: 'run_a' },
  });
  // run_a, which sent the message, was cancelled; run_b started after it and succeeds.
  const sent = h.runs.find((item) => item.runId === 'run_a');
  if (sent) sent.status = 'cancelled';
  await ending(h, 'run_b', 'succeeded');
  expect(h.starts).toHaveLength(0);
  expect(h.states()).toEqual(['queued']);
});

it('a request carried from a cancelled run holds the queue behind it without autoStart', async () => {
  const entries = () => [entry('plain'), carriedFrom('dir_1'), carriedFrom('dir_2')];
  const directiveRuns = { dir_1: 'run_b', dir_2: 'run_a' };
  const off = harness({ autoStart: false, entries: entries(), directiveRuns });
  await ending(off, 'run_b', 'cancelled');
  expect(off.starts).toHaveLength(0);
  // With autoStart on, the carried ones go first, in order, then the plain one.
  const on = harness({ entries: entries(), directiveRuns });
  await ending(on, 'run_b', 'cancelled');
  for (const runId of ['run_new_1', 'run_new_2']) await ending(on, runId, 'succeeded');
  expect(on.starts.map((request) => request.brief)).toEqual(['dir_1', 'dir_2', 'text plain']);
});
