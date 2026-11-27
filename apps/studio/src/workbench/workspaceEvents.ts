/** Refreshes file lists and change views after a working copy or its saved files change. */
export const WORKSPACE_CHANGED = 'corral:workspace-changed';

export function readWorkspaceAgain() {
  window.dispatchEvent(new Event(WORKSPACE_CHANGED));
}
