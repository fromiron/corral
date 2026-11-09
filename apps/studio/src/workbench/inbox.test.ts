import type { InboxItemView } from '@corral/client';
import type { RunSummary, WorkSession } from '@corral/core';
import { expect, it, vi } from 'vitest';
import { inboxEntries, inboxGroups } from './inbox.ts';
import { destinationHref, inboxDestination, notificationDestination } from './notifications.ts';
import { validateReviewSearch, validateSessionSearch } from './panels/routes.ts';
import { needsYouCount } from './sessionList.ts';

// docs/specs/features/inbox.md: three groups, the notification targets, the badge unchanged.

const KINDS: InboxItemView['kind'][] = [
  'decision',
  'uncertain_write',
  'uncertain_terminal',
  'unreviewed',
  'check_failed',
  'lsp_proposal',
  'integration',
  'queued',
  'recipe_stopped',
];

const item = (
  kind: InboxItemView['kind'],
  sessionId = 'session_a',
  extra: Partial<InboxItemView> = {},
): InboxItemView => ({
  kind,
  sessionId,
  sessionTitle: `Title ${sessionId}`,
  runId: kind === 'decision' || kind === 'recipe_stopped' ? `run_${sessionId}` : null,
  detail: null,
  ...(kind === 'uncertain_terminal' ? { terminalId: `pty_${sessionId}` } : {}),
  ...extra,
});

it('puts an awaiting approval and a queued request in different groups; the badge counts the run only', () => {
  const entries = [
    ...inboxEntries('alpha', [item('decision', 'asks')]),
    ...inboxEntries('beta', [item('queued', 'later', { detail: 'Private request body' })]),
  ];
  expect(
    inboxGroups(entries).map((group) => [group.id, group.entries.map((e) => e.item.kind)]),
  ).toEqual([
    ['response', ['decision']],
    ['waiting', ['queued']],
  ]);
  const sessions = [
    { sessionId: 'asks', projectId: 'alpha', entries: [], archivedAt: null },
    { sessionId: 'later', projectId: 'beta', entries: [], archivedAt: null },
  ] as unknown as WorkSession[];
  const runs: RunSummary[] = [
    {
      runId: 'run_asks',
      sessionId: 'asks',
      projectId: 'alpha',
      corralId: 'team',
      status: 'awaiting_user',
      startedAt: '2026-11-10T00:00:00Z',
    },
  ];
  expect(needsYouCount(sessions, runs, [])).toBe(1);
});

it('files every server kind under exactly one group, in the spec’s order', () => {
  const groups = inboxGroups(
    inboxEntries(
      'alpha',
      KINDS.map((kind) => item(kind)),
    ),
  );
  expect(groups.map((group) => [group.id, group.entries.map((e) => e.item.kind)])).toEqual([
    ['response', ['decision', 'uncertain_write', 'uncertain_terminal']],
    ['review', ['unreviewed', 'check_failed', 'lsp_proposal', 'integration']],
    ['waiting', ['queued', 'recipe_stopped']],
  ]);
});

it('keys repeated items apart and keeps each key to its project, kind, session and run', () => {
  const entries = inboxEntries('alpha', [item('queued'), item('queued'), item('decision')]);
  expect(new Set(entries.map((entry) => entry.key)).size).toBe(3);
  const other = inboxEntries('beta', [item('decision')]);
  expect(other[0]?.key).not.toBe(entries[2]?.key);
  const later = inboxEntries('alpha', [item('decision', 'session_a', { runId: 'run_later' })]);
  expect(later[0]?.key).not.toBe(entries[2]?.key);
});

it('opens the same exact targets as a desktop notification for every kind', async () => {
  for (const kind of KINDS) {
    const target = item(kind);
    const source = {
      getSession: vi.fn(async () => ({ projectId: 'alpha', archivedAt: null })),
      inbox: vi.fn(async () => [target]),
    };
    const destination = inboxDestination(target);
    expect(destination, kind).not.toBeNull();
    if (destination)
      expect(await notificationDestination(target, source), kind).toBe(
        destinationHref(destination),
      );
  }
  const hrefOf = (target: InboxItemView) => {
    const destination = inboxDestination(target);
    return destination ? destinationHref(destination) : null;
  };
  expect(hrefOf(item('unreviewed'))).toBe('/sessions/session_a/review');
  expect(hrefOf(item('queued'))).toBe('/sessions/session_a');
  expect(hrefOf(item('uncertain_terminal'))).toBe(
    '/sessions/session_a?panel=terminal&terminal=pty_session_a',
  );
  expect(hrefOf(item('recipe_stopped'))).toBe(
    '/sessions/session_a?panel=run&view=run&run=run_session_a',
  );
  // A terminal item tied to a run is not a terminal's own control screen.
  expect(hrefOf(item('uncertain_terminal', 'session_a', { runId: 'run_x' }))).toBeNull();
});

it('adds no returnTo while the session screens it opens do not read one', () => {
  // When the session or review route starts validating `returnTo`, inbox links must carry
  // `returnTo=/inbox` (docs/specs/features/inbox.md) and this expectation changes with them.
  expect(validateSessionSearch({ returnTo: '/inbox' })).toEqual({});
  expect(validateReviewSearch({ returnTo: '/inbox' })).toEqual({});
  for (const kind of KINDS)
    expect(inboxDestination(item(kind))?.search ?? {}, kind).not.toHaveProperty('returnTo');
});
