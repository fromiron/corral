import type { InboxItemView, SessionEvidenceView } from '@corral/client';
import type { RunSummary, WorkSession } from '@corral/core';
import { type Presence, runPresence, sessionGroupOf, sessionPresence } from '@corral/react';
import { INBOX_GROUPS, type InboxGroupId } from './inbox.ts';

/** Each session's newest run, by start time. */
export function latestRunsBySession(runs: readonly RunSummary[]) {
  const latest = new Map<string, RunSummary>();
  for (const run of runs) {
    if (!run.sessionId) continue;
    const seen = latest.get(run.sessionId);
    if (!seen || run.startedAt > seen.startedAt) latest.set(run.sessionId, run);
  }
  return latest;
}

export function latestSessionRun(
  session: Pick<WorkSession, 'sessionId'>,
  runs: readonly RunSummary[],
) {
  let latest: RunSummary | undefined;
  for (const run of runs)
    if (run.sessionId === session.sessionId && (!latest || run.startedAt > latest.startedAt))
      latest = run;
  return latest;
}

/** A run of the run list as it shows: the list carries no executions or open requests. */
export function listedRunPresence(run: Pick<RunSummary, 'status'>) {
  return runPresence(run, [], []);
}

function presenceOf(session: WorkSession, latest: RunSummary | undefined, terminal: boolean) {
  return sessionPresence(latest ? listedRunPresence(latest) : null, {
    terminalAttention: terminal,
    hasContent: Boolean(session.entries.length || session.objective || session.meeting),
  });
}

/**
 * Each session's state by the presence rule (docs/specs/features/presence.md), before any exit
 * grace: the newest run's state, or `ready`/`empty` without a run.
 */
export function sessionPresences(
  sessions: readonly WorkSession[],
  runs: readonly RunSummary[],
): Map<string, Presence> {
  return new Map([...sessionLiveStates(sessions, runs)].map(([id, live]) => [id, live.presence]));
}

/** A session's live state and the run it is of (none without a run). */
export interface LivePresence {
  presence: Presence;
  runId: string | null;
}

/** `sessionPresences` with each state's run, which the exit grace keys its holds by. */
export function sessionLiveStates(
  sessions: readonly WorkSession[],
  runs: readonly RunSummary[],
): Map<string, LivePresence> {
  const latest = latestRunsBySession(runs);
  return new Map(
    sessions.map((session) => {
      const run = latest.get(session.sessionId);
      return [
        session.sessionId,
        { presence: presenceOf(session, run, false), runId: run?.runId ?? null },
      ];
    }),
  );
}

const ENDED_OR_NONE = new Set<Presence['kind']>([
  'succeeded',
  'failed',
  'interrupted',
  'cancelled',
  'ready',
  'empty',
]);

/** Whether a session's newest run has not ended yet. */
export function sessionRunOpen(presence: Pick<Presence, 'kind'>) {
  return !ENDED_OR_NONE.has(presence.kind);
}

type SessionAttention = Pick<InboxItemView, 'kind' | 'sessionId' | 'terminalId'>;

export function uncertainSessionTerminal(sessionId: string, items: readonly SessionAttention[]) {
  return items.find((item) => item.kind === 'uncertain_terminal' && item.sessionId === sessionId)
    ?.terminalId;
}

/**
 * The sidebar's Needs you badge: listed sessions whose newest run waits for the person, plus
 * terminals whose result needs checking. Queued requests and unreviewed files stay in the list
 * only (docs/specs/features/inbox.md). It reads the live runs: the exit grace never delays it.
 */
export function needsYouCount(
  sessions: readonly WorkSession[],
  runs: RunSummary[],
  attention: readonly SessionAttention[],
) {
  const latest = latestRunsBySession(runs);
  const waiting = sessions.filter((session) => {
    const run = latest.get(session.sessionId);
    return run ? listedRunPresence(run).kind === 'awaiting_user' : false;
  }).length;
  return waiting + attention.filter((item) => item.kind === 'uncertain_terminal').length;
}

/**
 * A session's group without the inbox: a terminal to check, else the group of its state.
 * `shown` is the state the screen holds through the exit grace; without it, the live state.
 */
export function sessionListState(
  session: WorkSession,
  runs: readonly RunSummary[],
  attention: readonly SessionAttention[] = [],
  shown?: Presence,
) {
  const terminal = Boolean(uncertainSessionTerminal(session.sessionId, attention));
  return sessionGroupOf(
    shown ?? presenceOf(session, latestSessionRun(session, runs), terminal),
    terminal,
  );
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

function attentionReasons(presence: Presence, has: ReadonlySet<InboxKind>): AttentionReason[] {
  const reasons: AttentionReason[] = [];
  if (has.has('uncertain_terminal')) reasons.push('uncertain_terminal');
  // Without a terminal, only a state that waits on the person is in the attention group.
  if (sessionGroupOf(presence, false) === 'attention')
    reasons.push(presence.kind as AttentionReason);
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
 * recently updated. The sidebar keeps `sessionListState`, which has no review state. `shown`
 * holds the states the screen keeps through the exit grace; a session missing from it is live.
 */
export function sessionGroups(
  sessions: readonly WorkSession[],
  runs: RunSummary[],
  attention: readonly SessionAttention[],
  shown?: ReadonlyMap<string, Presence>,
): { id: SessionGroupId; rows: SessionGroupRow[] }[] {
  const live = sessionPresences(sessions, runs);
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
    const presence = (shown?.get(session.sessionId) ?? live.get(session.sessionId)) as Presence;
    const state = sessionGroupOf(presence, has.has('uncertain_terminal'));
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
      attention: id === 'attention' ? attentionReasons(presence, has) : [],
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
