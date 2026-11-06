import { type ScheduledOccurrence, TERMINAL_RUN_STATUSES } from '@corral/contracts';
import type { RunSummary, WorkSession } from '@corral/core';

export type ScheduledRunOutcome = Pick<RunSummary, 'runId' | 'status'> & { sessionId: string };

/** The scheduler owns this command namespace; request text never identifies the source. */
export const isScheduledRequest = (entry: { commandId?: string | null }) =>
  entry.commandId?.startsWith('scheduled_') === true;

export function scheduledRunOutcomes(
  sessions: WorkSession[],
  runs: RunSummary[],
): ScheduledRunOutcome[] {
  const byId = new Map(runs.map((run) => [run.runId, run]));
  const outcomes = new Map<string, ScheduledRunOutcome>();
  for (const session of sessions) {
    for (const entry of session.entries) {
      if (!isScheduledRequest(entry) || !entry.runId) continue;
      const run = byId.get(entry.runId);
      if (run?.sessionId === session.sessionId)
        outcomes.set(run.runId, {
          runId: run.runId,
          status: run.status,
          sessionId: session.sessionId,
        });
    }
  }
  return [...outcomes.values()];
}

export function completedScheduleRuns(
  current: ScheduledRunOutcome[],
  previous: Pick<RunSummary, 'runId' | 'status'>[] | null,
) {
  if (!previous) return [];
  const statuses = new Map(previous.map((run) => [run.runId, run.status]));
  return current.filter(
    (run) => TERMINAL_RUN_STATUSES.has(run.status) && statuses.get(run.runId) !== run.status,
  );
}

/** Occurrence status records dispatch; only the Coordinator's run records the outcome. */
export function scheduleHistoryStatus(occurrence: ScheduledOccurrence, runs: RunSummary[]) {
  return runs.find((run) => run.runId === occurrence.runId)?.status ?? null;
}
