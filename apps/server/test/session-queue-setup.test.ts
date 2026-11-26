import {
  type CorralRepository,
  planSessionEntry,
  type SessionEntry,
  type WorkSession,
} from '@corral/core';
import { expect, it } from 'vitest';
import {
  createSessionQueue,
  type QueuedStartRequest,
  type QueueRun,
} from '../src/session-queue.ts';

// features/paddock-setup.md 기다리는 요청: while a Paddock's setup runs the queue waits; a
// request sent during it starts when it ends, even without autoStart.

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

function harness(options: { entries: SessionEntry[]; autoStart?: boolean }) {
  const runs: QueueRun[] = [];
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
    entries: options.entries,
  };
  let setupRunning = true;
  const starts: QueuedStartRequest[] = [];
  const repository: Pick<
    CorralRepository,
    'getSession' | 'updateSessionEntry' | 'addSessionEntry'
  > = {
    getSession: async () => structuredClone(session),
    addSessionEntry: async () => ({ ok: false, error: 'invalid', message: 'unused' }),
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
    setupRunning: () => setupRunning,
    projection: () => null,
    now: () => Date.parse('2026-11-26T10:00:00.000Z'),
    timer: () => () => {},
    directiveRun: () => null,
    start: async (request) => {
      starts.push(request);
      const runId = `run_${starts.length}`;
      runs.push({
        runId,
        sessionId: 's1',
        status: 'running',
        startedAt: `2026-11-26T10:0${starts.length}:00Z`,
      });
      return { ok: true, runId, error: null, autoRoute: null };
    },
    log: () => {},
  });
  return {
    queue,
    starts,
    session,
    endSetup: () => {
      setupRunning = false;
      return queue.onSetupEnded('s1');
    },
  };
}

it('a queued request waits while the setup runs and starts when it ends', async () => {
  const h = harness({ entries: [entry('e1')] });
  await h.queue.onEntryQueued('s1');
  expect(h.starts).toHaveLength(0);
  await h.endSetup();
  expect(h.starts.map((start) => start.brief)).toEqual(['text e1']);
});

it('a request sent during setup goes first and starts without autoStart; the rest wait', async () => {
  const h = harness({
    autoStart: false,
    entries: [entry('older'), entry('sent', { afterSetup: true })],
  });
  await h.endSetup();
  expect(h.starts.map((start) => start.brief)).toEqual(['text sent']);
  expect(h.session.entries.find((item) => item.entryId === 'older')?.state).toBe('queued');
});

it('only a new queued request can wait for setup', () => {
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
    autoStart: true,
    entries: [],
  };
  const plan = (extra: Record<string, unknown>) =>
    planSessionEntry(
      structuredClone(session),
      's1',
      { intent: 'queue', text: 'hi', state: 'queued', start: START, ...extra },
      { now: 'x', entryId: 'e1' },
    );
  expect(plan({ afterSetup: true })).toMatchObject({
    ok: true,
    session: { entries: [expect.objectContaining({ afterSetup: true })] },
  });
  expect(plan({ afterSetup: true, intent: 'next', state: 'started', runId: 'r1' })).toMatchObject({
    ok: false,
    error: 'invalid',
  });
  expect(plan({ afterSetup: true, state: 'dismissed' })).toMatchObject({ ok: false });
});
