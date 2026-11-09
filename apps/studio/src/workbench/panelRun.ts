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
