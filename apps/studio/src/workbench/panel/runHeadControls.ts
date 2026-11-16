import { createContext, useContext } from 'react';

/**
 * Whether the run screen's head carries the run's pause, resume and stop (features/session-panel.md
 * "실행 조작이 서는 곳"). A session's run tab provides it: true only while the conversation cannot
 * be operated and this tab is the selected one. Outside a run tab (the run's own page) the head
 * always carries them.
 */
export const RunHeadControlsContext = createContext<boolean | null>(null);

export function useRunHeadCarriesControls(): boolean {
  return useContext(RunHeadControlsContext) ?? true;
}

/**
 * The stop command (palette, `/stop`, its shortcut) as the session frame routes it: true when
 * the run tab head carrying the run's controls took it (it asks), false when the composer is
 * to ask, the conversation having been brought forward first if it had to be.
 */
export const StopCommandContext = createContext<(() => boolean) | null>(null);
