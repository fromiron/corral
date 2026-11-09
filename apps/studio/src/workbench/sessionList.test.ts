import type { InboxItemView } from '@corral/client';
import type { RunSummary, WorkSession } from '@corral/core';
import { expect, it } from 'vitest';
import { needsYouCount } from './sessionList.ts';

const session = (sessionId: string, projectId = 'alpha') =>
  ({ sessionId, projectId, entries: [], archivedAt: null }) as unknown as WorkSession;
const run = (sessionId: string, status: RunSummary['status'], startedAt: string): RunSummary => ({
  sessionId,
  projectId: 'alpha',
  corralId: 'team',
  runId: `${sessionId}:${startedAt}`,
  status,
  startedAt,
});
const item = (kind: InboxItemView['kind'], sessionId: string): InboxItemView => ({
  kind,
  sessionId,
  sessionTitle: sessionId,
  runId: null,
  detail: null,
  ...(kind === 'uncertain_terminal' ? { terminalId: `${sessionId}_pty` } : {}),
});

it('counts runs awaiting the person and terminals to check, across projects', () => {
  const sessions = [session('asks'), session('elsewhere', 'beta'), session('done')];
  const runs = [
    run('asks', 'awaiting_user', '2026-11-01T00:00:00Z'),
    run('elsewhere', 'awaiting_user', '2026-11-02T00:00:00Z'),
    run('done', 'succeeded', '2026-11-02T00:00:00Z'),
  ];
  expect(needsYouCount(sessions, runs, [item('uncertain_terminal', 'done')])).toBe(3);
});

it('leaves queued requests, unreviewed files and an answered older run out of the badge', () => {
  const sessions = [session('answered'), session('quiet')];
  const runs = [
    // The newest run decides: an older wait that was answered no longer counts.
    run('answered', 'awaiting_user', '2026-11-01T00:00:00Z'),
    run('answered', 'running', '2026-11-02T00:00:00Z'),
    run('quiet', 'paused', '2026-11-01T00:00:00Z'),
  ];
  const attention = [item('queued', 'quiet'), item('unreviewed', 'quiet')];
  expect(needsYouCount(sessions, runs, attention)).toBe(0);
});

it('does not count a waiting run whose session the sidebar does not list', () => {
  const runs = [run('archived', 'awaiting_user', '2026-11-01T00:00:00Z')];
  expect(needsYouCount([session('other')], runs, [])).toBe(0);
});
