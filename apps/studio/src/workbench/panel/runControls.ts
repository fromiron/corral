// Where pause, resume, stop and whole-run receipts stand (features/session-panel.md
// "실행 조작이 서는 곳"): the run in progress is operable in one place on screen.
import { type RunStatus, TERMINAL_RUN_STATUSES } from '@corral/contracts';
import { conversationOperable, type PanelState, panelOnScreen, runTabHeadRun } from './model.ts';

export { runTabHeadRun };

export type RunControlPlace =
  /** The conversation can be operated: the composer carries them, no run tab does. */
  | { readonly at: 'composer' }
  /** 넓힘 or 서랍 with a running run's tab selected: that tab's head, for that run. */
  | { readonly at: 'run-tab'; readonly runId: string }
  /** 넓힘 or 서랍 with another tab, a finished run's tab, or a run not read yet selected. */
  | { readonly at: 'nowhere' };

/**
 * Where the stop command (palette entry, `/stop`, its shortcut) goes: the head carrying the
 * controls of the run in progress, else the composer, after bringing the conversation forward
 * when it cannot be operated.
 */
export type StopCommandRoute =
  | { readonly at: 'composer'; readonly bringForward: boolean }
  | { readonly at: 'run-tab'; readonly runId: string };

const finished = (status: RunStatus | undefined) =>
  status !== undefined && TERMINAL_RUN_STATUSES.has(status);

export function runControlPlace(
  state: PanelState,
  status: (runId: string) => RunStatus | undefined,
): RunControlPlace {
  if (conversationOperable(state.presentation)) return { at: 'composer' };
  const runId = runTabHeadRun(state);
  const current = runId ? status(runId) : undefined;
  return runId && current && !finished(current) ? { at: 'run-tab', runId } : { at: 'nowhere' };
}

/**
 * The run whose selected tab head shows only its whole-run receipts that still need confirming:
 * a finished run's tab, whenever the panel is on screen (옆 included), whatever stands where for
 * the run in progress. Null otherwise.
 */
export function receiptsOnlyHead(
  state: PanelState,
  status: (runId: string) => RunStatus | undefined,
): string | null {
  if (!panelOnScreen(state.presentation) || !state.selected?.startsWith('run:')) return null;
  const runId = state.selected.slice('run:'.length);
  return finished(status(runId)) ? runId : null;
}

/** The stop command always targets the conversation's run in progress; null when there is none. */
export function stopCommandRoute(
  state: PanelState,
  status: (runId: string) => RunStatus | undefined,
  runInProgress: string | null,
): StopCommandRoute | null {
  if (!runInProgress) return null;
  const place = runControlPlace(state, status);
  if (place.at === 'run-tab' && place.runId === runInProgress)
    return { at: 'run-tab', runId: runInProgress };
  return { at: 'composer', bringForward: !conversationOperable(state.presentation) };
}

/**
 * The run tab head that could ask a whole-run cancel confirmation loses that place between two
 * states. `PanelResult.dropHeadConfirmation` carries this for every event, and is also true on
 * entering a conversation; a run ending releases a confirmation under its own contract.
 */
export function headLosesControls(previous: PanelState, next: PanelState): boolean {
  const head = runTabHeadRun(previous);
  return head !== null && runTabHeadRun(next) !== head;
}
