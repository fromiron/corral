import type { InboxItemView } from '@corral/client';
import type { RunSummary, WorkSession } from '@corral/core';
import { describe, expect, it } from 'vitest';
import { needsYouCount, SESSION_GROUPS, sessionGroups, sessionListState } from './sessionList.ts';

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

// The project's Sessions tab groups sessions by state (docs/specs/workbench.md#세션-목록의-상태와-처리할-항목).
describe('sessionGroups', () => {
  const listed = (
    sessionId: string,
    change: Partial<WorkSession> = {},
    updatedAt = '2026-11-01T00:00:00Z',
  ) =>
    ({
      sessionId,
      projectId: 'alpha',
      title: sessionId,
      objective: '',
      entries: [],
      pinned: false,
      archivedAt: null,
      updatedAt,
      ...change,
    }) as unknown as WorkSession;
  const ids = (groups: ReturnType<typeof sessionGroups>) =>
    groups.map((group) => [group.id, group.rows.map((row) => row.session.sessionId)]);

  // A waits for the person, B finished with an unreviewed write, C runs, D has only a purpose,
  // E finished.
  const sessions = [
    listed('A'),
    listed('B'),
    listed('C'),
    listed('D', { objective: 'Plan the release' }),
    listed('E'),
  ];
  const runs = [
    run('A', 'awaiting_user', '2026-11-01T00:00:00Z'),
    run('B', 'succeeded', '2026-11-01T00:00:00Z'),
    run('C', 'running', '2026-11-01T00:00:00Z'),
    run('E', 'succeeded', '2026-11-01T00:00:00Z'),
  ];
  const attention = [item('unreviewed', 'B')];

  it('orders the groups attention, review, running, ready, completed, cancelled, empty', () => {
    expect(SESSION_GROUPS).toEqual([
      'attention',
      'review',
      'running',
      'ready',
      'completed',
      'cancelled',
      'empty',
    ]);
    expect(ids(sessionGroups(sessions, runs, attention))).toEqual([
      ['attention', ['A']],
      ['review', ['B']],
      ['running', ['C']],
      ['ready', ['D']],
      ['completed', ['E']],
    ]);
  });

  it('puts a session with a new run in progress only in running, even with items to review', () => {
    const later = [...runs, run('B', 'running', '2026-11-02T00:00:00Z')];
    expect(ids(sessionGroups(sessions, later, attention))).toEqual([
      ['attention', ['A']],
      ['running', ['B', 'C']],
      ['ready', ['D']],
      ['completed', ['E']],
    ]);
  });

  it('needs attention for a response item even without a run, before review', () => {
    expect(ids(sessionGroups([listed('F')], [], [item('uncertain_write', 'F')]))).toEqual([
      ['attention', ['F']],
    ]);
    const both = [item('unreviewed', 'B'), item('decision', 'B')];
    expect(ids(sessionGroups([listed('B')], runs, both))).toEqual([['attention', ['B']]]);
    expect(ids(sessionGroups([listed('G')], [], [item('uncertain_terminal', 'G')]))).toEqual([
      ['attention', ['G']],
    ]);
  });

  it('reviews a session for every review kind, and leaves waiting kinds to the run state', () => {
    for (const kind of ['unreviewed', 'check_failed', 'lsp_proposal', 'integration'] as const)
      expect(ids(sessionGroups([listed('B')], runs, [item(kind, 'B')]))).toEqual([
        ['review', ['B']],
      ]);
    const waiting = [item('queued', 'B'), item('recipe_stopped', 'B')];
    expect(ids(sessionGroups([listed('B')], runs, waiting))).toEqual([['completed', ['B']]]);
  });

  it('follows the latest run otherwise, and drops groups without sessions', () => {
    const cancelled = [run('A', 'cancelled', '2026-11-01T00:00:00Z')];
    expect(ids(sessionGroups([listed('A'), listed('Z')], cancelled, []))).toEqual([
      ['cancelled', ['A']],
      ['empty', ['Z']],
    ]);
    expect(sessionGroups([], runs, attention)).toEqual([]);
  });

  it('names the review kinds a reviewed row has, once each, in the Needs you order', () => {
    const items = [
      item('check_failed', 'B'),
      item('unreviewed', 'B'),
      item('check_failed', 'B'),
      item('queued', 'B'),
      item('lsp_proposal', 'other'),
    ];
    const groups = sessionGroups([listed('B'), listed('E')], runs, items);
    expect(groups.find((group) => group.id === 'review')?.rows[0]?.review).toEqual([
      'unreviewed',
      'check_failed',
    ]);
    // Only the review group names them.
    expect(groups.find((group) => group.id === 'completed')?.rows[0]?.review).toEqual([]);
    const waiting = sessionGroups([listed('B')], runs, [...items, item('decision', 'B')]);
    expect(waiting[0]?.rows[0]?.review).toEqual([]);
  });

  it('keeps pinned sessions first, then the most recently updated, inside a group', () => {
    const done = ['P', 'old', 'new', 'Q'].map((id) => run(id, 'succeeded', '2026-11-01T00:00:00Z'));
    const groups = sessionGroups(
      [
        listed('old', {}, '2026-11-01T00:00:00Z'),
        listed('P', { pinned: true }, '2026-10-01T00:00:00Z'),
        listed('new', {}, '2026-11-03T00:00:00Z'),
        listed('Q', { pinned: true }, '2026-10-02T00:00:00Z'),
      ],
      done,
      [],
    );
    expect(ids(groups)).toEqual([['completed', ['Q', 'P', 'new', 'old']]]);
  });

  it('leaves the sidebar state as it was: review is not one of its states', () => {
    const reviewed = sessions[1] as WorkSession;
    expect(sessionListState(reviewed, runs, attention)).toBe('completed');
    expect(sessionListState(listed('F'), [], [item('uncertain_write', 'F')])).toBe('empty');
  });

  // A row says only why it is in Needs attention; the group already says the rest.
  const reasons = (
    session: WorkSession,
    sessionRuns: RunSummary[],
    items: InboxItemView[] = [],
  ) => {
    const [group] = sessionGroups([session], sessionRuns, items);
    return [group?.id, group?.rows[0]?.attention];
  };

  it('gives a Needs attention row the latest run state that put it there', () => {
    for (const status of ['awaiting_user', 'failed', 'interrupted', 'paused'] as const)
      expect(reasons(listed('A'), [run('A', status, '2026-11-01T00:00:00Z')])).toEqual([
        'attention',
        [status],
      ]);
    // The latest run decides; an older failure is not a reason.
    const older = [
      run('A', 'failed', '2026-11-01T00:00:00Z'),
      run('A', 'paused', '2026-11-02T00:00:00Z'),
    ];
    expect(reasons(listed('A'), older)).toEqual(['attention', ['paused']]);
  });

  it('names the response item when no run puts the session in Needs attention', () => {
    // No run at all: never "empty" or "no run yet", only the item.
    expect(reasons(listed('F'), [], [item('uncertain_write', 'F')])).toEqual([
      'attention',
      ['uncertain_write'],
    ]);
    // A decision waits for the person, whatever the newest run is doing.
    const running = [run('F', 'running', '2026-11-01T00:00:00Z')];
    expect(reasons(listed('F'), running, [item('decision', 'F')])).toEqual([
      'attention',
      ['awaiting_user'],
    ]);
    const both = [item('decision', 'F'), item('uncertain_write', 'F'), item('unreviewed', 'F')];
    expect(reasons(listed('F'), running, both)).toEqual([
      'attention',
      ['awaiting_user', 'uncertain_write'],
    ]);
    // A run that waits already says it; the items do not repeat it.
    const failed = [run('F', 'failed', '2026-11-01T00:00:00Z')];
    expect(reasons(listed('F'), failed, both)).toEqual(['attention', ['failed']]);
  });

  it('names a terminal to check, beside a run that needs the person', () => {
    const done = [run('G', 'succeeded', '2026-11-01T00:00:00Z')];
    expect(reasons(listed('G'), done, [item('uncertain_terminal', 'G')])).toEqual([
      'attention',
      ['uncertain_terminal'],
    ]);
    expect(reasons(listed('G'), [], [item('uncertain_terminal', 'G')])).toEqual([
      'attention',
      ['uncertain_terminal'],
    ]);
    const failed = [run('G', 'failed', '2026-11-01T00:00:00Z')];
    expect(reasons(listed('G'), failed, [item('uncertain_terminal', 'G')])).toEqual([
      'attention',
      ['uncertain_terminal', 'failed'],
    ]);
  });

  it('gives no reason to rows of any other group', () => {
    const groups = sessionGroups(sessions, runs, attention);
    for (const group of groups.filter((group) => group.id !== 'attention'))
      for (const row of group.rows) expect(row.attention).toEqual([]);
  });
});
