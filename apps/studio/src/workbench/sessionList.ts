import type { InboxItemView } from '@corral/client';
import { TERMINAL_RUN_STATUSES } from '@corral/contracts';
import type { RunSummary, WorkSession } from '@corral/core';

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
