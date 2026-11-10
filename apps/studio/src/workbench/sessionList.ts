import type { InboxItemView, SessionEvidenceView } from '@corral/client';
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

/**
 * Why a session needs attention: a terminal to check, the latest run's state that waits on the
 * person, or else a response item ('awaiting_user' stands for a decision, whose run waits).
 */
export type AttentionReason =
  | 'uncertain_terminal'
  | 'awaiting_user'
  | 'failed'
  | 'interrupted'
  | 'paused'
  | 'uncertain_write';

export interface SessionGroupRow {
  session: WorkSession;
  /** Why a row of the attention group is there, each once; else empty. */
  attention: AttentionReason[];
  /** The review kinds a row of the review group names, in the Needs you order; else empty. */
  review: ReviewKind[];
}

function attentionReasons(
  session: WorkSession,
  runs: RunSummary[],
  has: ReadonlySet<InboxKind>,
): AttentionReason[] {
  const reasons: AttentionReason[] = [];
  if (has.has('uncertain_terminal')) reasons.push('uncertain_terminal');
  const latest = latestSessionRun(session, runs);
  // Without the inbox, sessionListState says attention only for a run that waits on the person.
  if (latest && sessionListState(session, runs) === 'attention')
    reasons.push(latest.status as AttentionReason);
  else {
    if (has.has('decision')) reasons.push('awaiting_user');
    if (has.has('uncertain_write')) reasons.push('uncertain_write');
  }
  return reasons;
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
    rows.push({
      session,
      attention: id === 'attention' ? attentionReasons(session, runs, has) : [],
      review: id === 'review' ? review : [],
    });
    grouped.set(id, rows);
  }
  return SESSION_GROUPS.flatMap((id) => {
    const rows = grouped.get(id);
    return rows ? [{ id, rows }] : [];
  });
}

/** A recorded fact a session row says (docs/specs/features/session-evidence.md). */
export type SessionFact =
  | 'checks_passed'
  | 'changed_after_checks'
  | 'approved'
  | 'changes_requested'
  | 'applied';

/**
 * What a session's latest check, decision and applying say on its row, in that order. Only the
 * good outcomes show: a failed check, a decision with writes after it and an applying that did
 * not finish are the Review group's kinds, and a fact never changes a session's group.
 */
export function sessionFacts(
  evidence: Pick<SessionEvidenceView, 'check' | 'decision' | 'integration'> | undefined,
): SessionFact[] {
  if (!evidence) return [];
  const facts: SessionFact[] = [];
  const { check, decision, integration } = evidence;
  if (check?.verdict === 'pass')
    facts.push(check.writesSince ? 'changed_after_checks' : 'checks_passed');
  if (decision && !decision.writesSince)
    facts.push(decision.decision === 'approved' ? 'approved' : 'changes_requested');
  if (integration === 'applied') facts.push('applied');
  return facts;
}
