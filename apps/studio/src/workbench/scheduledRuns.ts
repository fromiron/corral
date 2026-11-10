import { type ScheduledOccurrence, TERMINAL_RUN_STATUSES } from '@corral/contracts';
import type { RunSummary, WorkSession } from '@corral/core';
import { createStore } from 'zustand/vanilla';

export type ScheduledRunOutcome = Pick<RunSummary, 'runId' | 'status'> & { sessionId: string };

/**
 * The scheduled runs whose final status Automation shows on screen now: each listed schedule's
 * last result and the shown schedule's history. On Automation their banners are dismissed; a
 * result the page did not show (its schedule is gone, or the page's read failed) keeps its
 * banner for the next screen.
 */
export const automationShownRuns = createStore<{ runIds: readonly string[] }>(() => ({
  runIds: [],
}));

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
