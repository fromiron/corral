import type { RunStatus } from '@corral/contracts';
import {
  type CorralRepository,
  queuedSessionCommandId,
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

function harness(options: { startDelayMs?: number; failStart?: boolean } = {}) {
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
    autoStart: true,
    entries: [entry('e1'), entry('e2')],
  };
  const starts: QueuedStartRequest[] = [];
  const logs: [string, string][] = [];
  let fail = options.failStart ?? false;
  const repository: Pick<CorralRepository, 'getSession' | 'updateSessionEntry'> = {
    getSession: async () => structuredClone(session),
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
    start: async (request) => {
      starts.push(request);
      if (options.startDelayMs) await new Promise((r) => setTimeout(r, options.startDelayMs));
      if (fail) throw new Error('/home/someone/secret path and body text');
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
