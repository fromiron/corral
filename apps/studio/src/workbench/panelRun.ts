import { type RunStatus, TERMINAL_RUN_STATUSES } from '@corral/contracts';

/**
 * The run the session's history panel shows: the requested one while the session lists it,
 * otherwise the newest. A run that has gone (a reloaded browser demo, a stale link) falls back to
 * the newest, or to none, instead of a dead run. Until the list has loaded the request is kept,
 * so a run that was just started is not replaced by an older one.
 */
export function panelRunId(
  runs: readonly { runId: string }[],
  requested: string | undefined,
  loaded: boolean,
): string | undefined {
  if (!loaded) return requested ?? runs.at(-1)?.runId;
  if (requested && runs.some((run) => run.runId === requested)) return requested;
  return runs.at(-1)?.runId;
}

export interface SessionRunViews {
  /** The run the conversation's widgets and activity bar present (chat-widgets-contract.md 3.1). */
  presentationRunId: string | null;
  /** The presented run while it goes: the conversation follows and keeps its store open. */
  liveRunId: string | null;
}

/**
 * The run the conversation presents: the active run, else the last one, whatever a run tab
 * beside it shows.
 */
export function sessionRunViews(
  runs: readonly { runId: string; status: RunStatus }[],
  linkedRunIds: readonly string[],
): SessionRunViews {
  const presented =
    runs.findLast((run) => !TERMINAL_RUN_STATUSES.has(run.status)) ?? runs.at(-1) ?? null;
  const live = presented && !TERMINAL_RUN_STATUSES.has(presented.status) ? presented : null;
  return {
    presentationRunId: presented?.runId ?? linkedRunIds.at(-1) ?? null,
    liveRunId: live?.runId ?? null,
  };
}
