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
