import type { InboxItemView, SessionEvidenceView } from '@corral/client';
import { RunStatus } from '@corral/contracts';
import type { RunSummary, WorkSession } from '@corral/core';
import { runPresence } from '@corral/react';
import { describe, expect, it } from 'vitest';
import {
  needsYouCount,
  SESSION_GROUPS,
  sessionFacts,
  sessionGroups,
  sessionListState,
  sessionPresences,
} from './sessionList.ts';

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
    // An advice its target never read sends an ended session to review (workbench.md).
    for (const kind of [
      'unreviewed',
      'check_failed',
      'lsp_proposal',
      'integration',
      'advice',
    ] as const)
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

  // The group table of docs/specs/features/presence.md, for every Run state of constitution §3.
  it('groups every Run state as the presence table says', () => {
    const expected: Record<RunStatus, string> = {
      created: 'running',
      validating: 'running',
      running: 'running',
      pausing: 'running',
      cancelling: 'running',
      awaiting_user: 'attention',
      failed: 'attention',
      interrupted: 'attention',
      paused: 'attention',
      succeeded: 'completed',
      cancelled: 'cancelled',
    };
    expect(Object.keys(expected).sort()).toEqual([...RunStatus.options].sort());
    for (const status of RunStatus.options) {
      const runs = [run('A', status, '2026-11-01T00:00:00Z')];
      expect([status, sessionListState(listed('A'), runs)]).toEqual([status, expected[status]]);
      expect([status, ids(sessionGroups([listed('A')], runs, []))]).toEqual([
        status,
        [[expected[status], ['A']]],
      ]);
    }
  });

  it('reads each session’s state through the presence rule, latest run first', () => {
    const shown = sessionPresences(
      [listed('A'), listed('D', { objective: 'Plan' }), listed('Z')],
      [
        run('A', 'failed', '2026-11-01T00:00:00Z'),
        run('A', 'created', '2026-11-02T00:00:00Z'),
        run('other', 'running', '2026-11-03T00:00:00Z'),
      ],
    );
    expect(shown.get('A')).toEqual(runPresence({ status: 'created' }, [], []));
    expect(shown.get('D')?.kind).toBe('ready');
    expect(shown.get('Z')?.kind).toBe('empty');
  });

  it('groups by a held presence when one is given, and keeps the badge on the live run', () => {
    // The run ended a moment ago and the list still holds it in progress (presence.md grace).
    const runs = [run('A', 'succeeded', '2026-11-01T00:00:00Z')];
    const held = new Map([['A', runPresence({ status: 'running' }, [], [])]]);
    expect(ids(sessionGroups([listed('A')], runs, [], held))).toEqual([['running', ['A']]]);
    expect(sessionListState(listed('A'), runs, [], held.get('A'))).toBe('running');
    // A terminal to check still puts the row in Needs attention.
    expect(
      sessionListState(listed('A'), runs, [item('uncertain_terminal', 'A')], held.get('A')),
    ).toBe('attention');
  });

  it('gives no reason to rows of any other group', () => {
    const groups = sessionGroups(sessions, runs, attention);
    for (const group of groups.filter((group) => group.id !== 'attention'))
      for (const row of group.rows) expect(row.attention).toEqual([]);
  });
});

// A row's recorded facts (docs/specs/features/session-evidence.md): check · decision · applied.
describe('sessionFacts', () => {
  const evidence = (change: Partial<SessionEvidenceView> = {}): SessionEvidenceView => ({
    sessionId: 'A',
    check: null,
    decision: null,
    integration: null,
    ...change,
  });
  const check = (
    verdict: NonNullable<SessionEvidenceView['check']>['verdict'],
    writesSince = false,
  ) => ({ name: 'Unit tests', verdict, writesSince }) as const;

  it('says the checks passed only for a passing check with no write after it', () => {
    expect(sessionFacts(evidence({ check: check('pass') }))).toEqual(['checks_passed']);
    // A write after the check: it changed since, and never also "passed".
    expect(sessionFacts(evidence({ check: check('pass', true) }))).toEqual([
      'changed_after_checks',
    ]);
  });

  it('says nothing for a check that did not pass, or none that completed', () => {
    // A failure is the Review group's "Checks failed"; cancelled and running checks are null.
    for (const verdict of ['fail', 'inconclusive', 'not_evaluated'] as const) {
      expect(sessionFacts(evidence({ check: check(verdict) }))).toEqual([]);
      expect(sessionFacts(evidence({ check: check(verdict, true) }))).toEqual([]);
    }
    expect(sessionFacts(evidence())).toEqual([]);
    expect(sessionFacts(undefined)).toEqual([]);
  });

  it('says the latest decision only while no write follows it', () => {
    expect(
      sessionFacts(evidence({ decision: { decision: 'approved', writesSince: false } })),
    ).toEqual(['approved']);
    expect(
      sessionFacts(evidence({ decision: { decision: 'changes_requested', writesSince: false } })),
    ).toEqual(['changes_requested']);
    // A write after it is the Review group's unreviewed writes.
    for (const decision of ['approved', 'changes_requested'] as const)
      expect(sessionFacts(evidence({ decision: { decision, writesSince: true } }))).toEqual([]);
  });

  it('says applied only for an applying that finished, never for the other states', () => {
    expect(sessionFacts(evidence({ integration: 'applied' }))).toEqual(['applied']);
    for (const integration of ['applying', 'partial', 'conflict', 'reverted', 'failed'] as const)
      expect(sessionFacts(evidence({ integration }))).toEqual([]);
  });

  it('keeps the order check, decision, applied', () => {
    expect(
      sessionFacts(
        evidence({
          integration: 'applied',
          decision: { decision: 'approved', writesSince: false },
          check: check('pass'),
        }),
      ),
    ).toEqual(['checks_passed', 'approved', 'applied']);
  });
});
