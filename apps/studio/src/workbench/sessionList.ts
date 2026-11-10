import type { InboxItemView } from '@corral/client';
import { TERMINAL_RUN_STATUSES } from '@corral/contracts';
import type { RunSummary, WorkSession } from '@corral/core';
import { INBOX_GROUPS, type InboxGroupId } from './inbox.ts';

export function latestSessionRun(session: WorkSession, runs: RunSummary[]) {
  return runs
    .filter((run) => run.sessionId === session.sessionId)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
}

type SessionAttention = Pick<InboxItemView, 'kind' | 'sessionId' | 'terminalId'>;

export function uncertainSessionTerminal(sessionId: string, items: readonly SessionAttention[]) {
  return items.find((item) => item.kind === 'uncertain_terminal' && item.sessionId === sessionId)
    ?.terminalId;
}

/**
 * The sidebar's Needs you badge: listed sessions whose newest run waits for the person, plus
 * terminals whose result needs checking. Queued requests and unreviewed files stay in the list
 * only (docs/specs/features/inbox.md).
 */
export function needsYouCount(
  sessions: readonly WorkSession[],
  runs: RunSummary[],
  attention: readonly SessionAttention[],
) {
  const latest = new Map<string, RunSummary>();
  for (const run of runs) {
    if (!run.sessionId) continue;
    const seen = latest.get(run.sessionId);
    if (!seen || run.startedAt > seen.startedAt) latest.set(run.sessionId, run);
  }
  const waiting = sessions.filter(
    (session) => latest.get(session.sessionId)?.status === 'awaiting_user',
  ).length;
  return waiting + attention.filter((item) => item.kind === 'uncertain_terminal').length;
}

export function sessionListState(
  session: WorkSession,
  runs: RunSummary[],
  attention: readonly SessionAttention[] = [],
) {
  if (uncertainSessionTerminal(session.sessionId, attention)) return 'attention';
  const latest = latestSessionRun(session, runs);
  if (latest) {
    if (['failed', 'interrupted', 'awaiting_user', 'paused'].includes(latest.status))
      return 'attention';
    if (!TERMINAL_RUN_STATUSES.has(latest.status)) return 'running';
    return latest.status === 'cancelled' ? 'cancelled' : 'completed';
  }
  return session.entries.length || session.objective || session.meeting ? 'ready' : 'empty';
}

/** The project Sessions tab's groups, in display order (docs/specs/workbench.md). */
export const SESSION_GROUPS = [
  'attention',
  'review',
  'running',
  'ready',
  'completed',
  'cancelled',
  'empty',
] as const;
export type SessionGroupId = (typeof SESSION_GROUPS)[number];

type InboxKind = InboxItemView['kind'];
type InboxGroup<Id extends InboxGroupId> = Extract<(typeof INBOX_GROUPS)[number], { id: Id }>;
const kindsOf = <Id extends InboxGroupId>(id: Id) =>
  (INBOX_GROUPS.find((group) => group.id === id) as InboxGroup<Id>).kinds;
const RESPONSE_KINDS: readonly InboxKind[] = kindsOf('response');
const REVIEW_KINDS = kindsOf('review');
export type ReviewKind = (typeof REVIEW_KINDS)[number];

export interface SessionGroupRow {
  session: WorkSession;
  /** The review kinds a row of the review group names, in the Needs you order; else empty. */
  review: ReviewKind[];
}

/**
 * Each session in the first group whose rule it meets: something waits for the person, then a
 * run in progress, then something to review, then the latest run (or none). Groups keep the
 * display order and drop out without sessions; inside one, pinned sessions lead, then the most
 * recently updated. The sidebar keeps `sessionListState`, which has no review state.
 */
export function sessionGroups(
  sessions: readonly WorkSession[],
  runs: RunSummary[],
  attention: readonly SessionAttention[],
): { id: SessionGroupId; rows: SessionGroupRow[] }[] {
  const kinds = new Map<string, Set<InboxKind>>();
  for (const item of attention) {
    const seen = kinds.get(item.sessionId) ?? new Set<InboxKind>();
    seen.add(item.kind);
    kinds.set(item.sessionId, seen);
  }
  const grouped = new Map<SessionGroupId, SessionGroupRow[]>();
  const ordered = [...sessions].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt),
  );
  for (const session of ordered) {
    const has = kinds.get(session.sessionId) ?? new Set<InboxKind>();
    const state = sessionListState(session, runs, attention);
    const review = REVIEW_KINDS.filter((kind) => has.has(kind));
    const id: SessionGroupId =
      state === 'attention' || RESPONSE_KINDS.some((kind) => has.has(kind))
        ? 'attention'
        : state === 'running'
          ? 'running'
          : review.length
            ? 'review'
            : state;
    const rows = grouped.get(id) ?? [];
    rows.push({ session, review: id === 'review' ? review : [] });
    grouped.set(id, rows);
  }
  return SESSION_GROUPS.flatMap((id) => {
    const rows = grouped.get(id);
    return rows ? [{ id, rows }] : [];
  });
}
