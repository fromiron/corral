import {
  FakeClock,
  linearCorral,
  ScriptedAgentAdapter,
  SequentialIdFactory,
} from '@corral/testkit';
import { expect, it } from 'vitest';
import {
  Coordinator,
  InMemoryRunStore,
  InProcessTransport,
  planSessionEntry,
  queuedEntriesInStartOrder,
  type RunProjection,
  resendEntry,
  resendStep,
  type SessionEntry,
  type SessionEntryStart,
  usageLimitResetAt,
  type WorkSession,
  waitForProjection,
} from '../src/index.ts';

// features/usage-limit-resend.md: a request that failed on a usage limit with a known reset time
// is copied to the front of the queue and started once the limit resets.

const ended = (p: RunProjection) => ['succeeded', 'failed', 'cancelled'].includes(p.status);
const NOW = Date.parse('2026-11-25T10:00:00.000Z');
const RESET = '2026-11-25T10:42:00.000Z';
const START: SessionEntryStart = { choice: { modelProfile: 'gpt' }, mode: 'live', team: 'none' };

async function limitedRun(settlement: Record<string, unknown>) {
  const store = new InMemoryRunStore();
  const coordinator = new Coordinator({
    store,
    clock: new FakeClock(),
    ids: new SequentialIdFactory(),
    agents: new ScriptedAgentAdapter({
      turns: 1,
      appendNotes: false,
      collaborate: false,
      script: async () => settlement as never,
    }),
  });
  const started = coordinator.startRun({
    schemaVersion: '0.1',
    commandId: 'start',
    mode: 'mock',
    definition: linearCorral(['research']),
  });
  const runId = started.runId ?? '';
  const projection = await waitForProjection(new InProcessTransport(coordinator), runId, ended);
  const settled = store.readEvents(runId, 0).find((event) => event.type === 'execution.settled');
  return { runId, projection, settled };
}

it('records the usage limit of an execution that ended on one', async () => {
  const { projection, settled } = await limitedRun({
    outcome: 'failed',
    error: 'the model request failed: HTTP 429 (QUOTA)',
    usageLimit: { resetAt: RESET },
  });
  expect(projection.status).toBe('failed');
  expect(settled?.payload).toMatchObject({ outcome: 'failed', usageLimit: { resetAt: RESET } });
  expect(usageLimitResetAt(projection)).toBe(RESET);
});

it('records no usage limit for any other failure', async () => {
  const { projection } = await limitedRun({ outcome: 'failed', error: 'the role gave up' });
  expect(usageLimitResetAt(projection)).toBeNull();
});

// ── the copy ─────────────────────────────────────────────────────────────────

const entry = (entryId: string, extra: Partial<SessionEntry> = {}): SessionEntry => ({
  entryId,
  intent: 'next',
  text: `text ${entryId}`,
  createdAt: 'x',
  state: 'started',
  runId: 'run_failed',
  executionId: null,
  detail: null,
  start: START,
  ...extra,
});
const session = (entries: SessionEntry[], extra: Partial<WorkSession> = {}): WorkSession => ({
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
  autoStart: true,
  entries,
  ...extra,
});
const failed = (resetAt: string | null, status = 'failed') =>
  ({
    status,
    executionOrder: ['exec_1'],
    executions: {
      exec_1: {
        status: 'failed',
        ...(resetAt ? { usageLimit: { resetAt } } : {}),
      },
    },
  }) as unknown as RunProjection;

it('copies the request that started the failed run, to start one minute after the reset', () => {
  const attachment = {
    kind: 'text_attachment',
    name: 'a.txt',
    mime: 'text/plain',
    text: 'words',
    sha256: 'b'.repeat(64),
  } as unknown as NonNullable<SessionEntry['attachments']>[number];
  const source = entry('e1', { permissionMode: 'auto', attachments: [attachment] });
  const copy = resendEntry(session([source]), 'run_failed', failed(RESET), NOW);
  expect(copy).toEqual({
    intent: 'queue',
    state: 'queued',
    text: 'text e1',
    start: START,
    permissionMode: 'auto',
    attachments: [attachment],
    resend: { of: 'e1', runId: 'run_failed', notBefore: '2026-11-25T10:43:00.000Z' },
  });
});

it('makes no copy without a reset at least ten minutes away', () => {
  const s = session([entry('e1')]);
  expect(resendEntry(s, 'run_failed', failed(null), NOW)).toBeNull();
  expect(resendEntry(s, 'run_failed', failed('2026-11-25T10:09:59.000Z'), NOW)).toBeNull();
  // A window already over when the failure arrived cannot start a retry loop.
  expect(resendEntry(s, 'run_failed', failed('2026-11-25T09:00:00.000Z'), NOW)).toBeNull();
  expect(resendEntry(s, 'run_failed', failed('not a time'), NOW)).toBeNull();
});

it('makes no copy of a run that did not fail, a request without its start, or a resend', () => {
  expect(
    resendEntry(session([entry('e1')]), 'run_failed', failed(RESET, 'cancelled'), NOW),
  ).toBeNull();
  expect(
    resendEntry(session([entry('e1', { start: undefined })]), 'run_failed', failed(RESET), NOW),
  ).toBeNull();
  // Sent automatically once per request: a resend that failed again is not copied.
  const resent = entry('e2', {
    intent: 'queue',
    resend: { of: 'e1', runId: 'run_old', notBefore: RESET },
  });
  expect(resendEntry(session([resent]), 'run_failed', failed(RESET), NOW)).toBeNull();
  // A meeting's or an explain's run is not a conversation request.
  expect(
    resendEntry(
      session([entry('e1', { intent: 'explain', start: undefined })]),
      'run_failed',
      failed(RESET),
      NOW,
    ),
  ).toBeNull();
});

it('records one copy per failed run, however often its end is reported', () => {
  const copy = resendEntry(session([entry('e1')]), 'run_failed', failed(RESET), NOW);
  if (!copy) throw new Error('expected a copy');
  const first = planSessionEntry(session([entry('e1')]), 's1', copy, { now: 'x', entryId: 'r1' });
  if (!first.ok) throw new Error(first.message);
  const again = planSessionEntry(first.session, 's1', copy, { now: 'x', entryId: 'r2' });
  expect(again.ok && again.session.entries.map((item) => item.entryId)).toEqual(['e1', 'r1']);
});

it('refuses a resend record that is not a queued request with a time', () => {
  const base = { intent: 'queue' as const, state: 'queued' as const, text: 't', start: START };
  for (const resend of [
    { of: 'e1', runId: 'run_failed', notBefore: 'soon' },
    { of: '', runId: 'run_failed', notBefore: RESET },
  ])
    expect(
      planSessionEntry(session([]), 's1', { ...base, resend }, { now: 'x', entryId: 'r1' }).ok,
    ).toBe(false);
  expect(
    planSessionEntry(
      session([]),
      's1',
      { ...base, intent: 'next', resend: { of: 'e1', runId: 'run_failed', notBefore: RESET } },
      { now: 'x', entryId: 'r1' },
    ).ok,
  ).toBe(false);
});

it('puts a request to resend at the front of the queue', () => {
  const queued = entry('q1', { intent: 'queue', state: 'queued', runId: null });
  const resend = entry('r1', {
    intent: 'queue',
    state: 'queued',
    runId: null,
    resend: { of: 'e1', runId: 'run_failed', notBefore: RESET },
  });
  expect(queuedEntriesInStartOrder(session([queued, resend])).map((item) => item.entryId)).toEqual([
    'r1',
    'q1',
  ]);
});

// ── the step ─────────────────────────────────────────────────────────────────

const waiting = entry('r1', {
  intent: 'queue',
  state: 'queued',
  runId: null,
  resend: { of: 'e1', runId: 'run_failed', notBefore: '2026-11-25T10:43:00.000Z' },
});
const at = (iso: string) => Date.parse(iso);

it('waits until its time, then starts', () => {
  const s = session([waiting]);
  expect(resendStep(waiting, s, 'run_failed', NOW)).toEqual({
    kind: 'wait',
    until: '2026-11-25T10:43:00.000Z',
  });
  expect(resendStep(waiting, s, 'run_failed', at('2026-11-25T10:43:00.000Z'))).toEqual({
    kind: 'start',
  });
  // A server that was off at the time starts it once it is back, within a day.
  expect(resendStep(waiting, s, 'run_failed', at('2026-11-26T10:42:00.000Z'))).toEqual({
    kind: 'start',
  });
});

it('is removed once another run of the session ended after the failed one', () => {
  expect(resendStep(waiting, session([waiting]), 'run_later', NOW)).toEqual({ kind: 'dismiss' });
  expect(
    resendStep(waiting, session([waiting]), 'run_later', at('2026-11-25T11:00:00.000Z')),
  ).toEqual({ kind: 'dismiss' });
});

it('waits for a person when the session is archived, auto start is off or a day passed', () => {
  const due = at('2026-11-25T11:00:00.000Z');
  expect(resendStep(waiting, session([waiting], { archivedAt: 'x' }), 'run_failed', due)).toEqual({
    kind: 'hold',
  });
  expect(resendStep(waiting, session([waiting], { autoStart: false }), 'run_failed', due)).toEqual({
    kind: 'hold',
  });
  expect(
    resendStep(waiting, session([waiting]), 'run_failed', at('2026-11-26T10:43:00.001Z')),
  ).toEqual({ kind: 'hold' });
});
