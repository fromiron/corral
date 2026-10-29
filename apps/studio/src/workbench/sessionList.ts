import { TERMINAL_RUN_STATUSES } from '@corral/contracts';
import type { RunSummary, WorkSession } from '@corral/core';

export function latestSessionRun(session: WorkSession, runs: RunSummary[]) {
  return runs
    .filter((run) => run.sessionId === session.sessionId)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
}

export function sessionListState(session: WorkSession, runs: RunSummary[]) {
  const latest = latestSessionRun(session, runs);
  if (latest) {
    if (['failed', 'interrupted', 'awaiting_user', 'paused'].includes(latest.status))
      return 'attention';
    if (!TERMINAL_RUN_STATUSES.has(latest.status)) return 'running';
    return latest.status === 'cancelled' ? 'cancelled' : 'completed';
  }
  return session.entries.length || session.objective || session.meeting ? 'ready' : 'empty';
}
