import type { TeamEditorView } from '@corral/react';
import type { UseNavigateResult } from '@tanstack/react-router';

// A refused write still counts for this tab, even if storage can read its older value.
const unsavedViews = new Map<string, TeamEditorView>();
const viewKey = (corralId: string) => `corral:editor-view:v1:${corralId}`;

export function readEditorView(corralId: string): TeamEditorView {
  const unsaved = unsavedViews.get(corralId);
  if (unsaved) return unsaved;
  try {
    return window.localStorage.getItem(viewKey(corralId)) === 'composition'
      ? 'composition'
      : 'graph';
  } catch {
    return 'graph';
  }
}

export function rememberEditorView(corralId: string, view: TeamEditorView): void {
  try {
    window.localStorage.setItem(viewKey(corralId), view);
    unsavedViews.delete(corralId);
  } catch {
    unsavedViews.set(corralId, view);
  }
}

/** Imports, duplicates and demo seeds are existing definitions, not newly composed teams. */
export function openNewTeam(navigate: UseNavigateResult<string>, corralId: string) {
  rememberEditorView(corralId, 'composition');
  return navigate({ to: '/corrals/$corralId/edit', params: { corralId } });
}
