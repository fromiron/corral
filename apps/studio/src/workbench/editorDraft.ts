import type { CorralRecord, CorralRepository } from '@corral/core';
import {
  createEditorStore,
  draftFromDefinition,
  type EditorDraft,
  type EditorStore,
} from '@corral/react';
import { createStore, type StoreApi } from 'zustand/vanilla';

interface EditorWorkingState {
  editor: EditorStore;
  saved: { record: CorralRecord; draft: EditorDraft };
  saving: boolean;
  message: { text: string; error: boolean } | null;
}
export type EditorWorkingCopy = StoreApi<EditorWorkingState>;

const copies = new WeakMap<CorralRepository, Map<string, EditorWorkingCopy>>();
const listeners = new WeakMap<CorralRepository, Set<() => void>>();
const keyOf = (record: Pick<CorralRecord, 'projectId' | 'corralId'>) =>
  JSON.stringify([record.projectId, record.corralId]);
const dirty = (copy: EditorWorkingCopy) => {
  const state = copy.getState();
  return state.saving || state.editor.getState().draft !== state.saved.draft;
};

/** Settings detours retain undo history and the revision against which Save must compare. */
export function editorWorkingCopy(
  repository: CorralRepository,
  record: CorralRecord,
): EditorWorkingCopy {
  let entries = copies.get(repository);
  if (!entries) {
    entries = new Map();
    copies.set(repository, entries);
  }
  const key = keyOf(record);
  const previous = entries.get(key);
  if (
    previous &&
    (dirty(previous) ||
      previous.getState().saved.record.definitionRevision >= record.definitionRevision)
  )
    return previous;
  const draft = draftFromDefinition(record.definition);
  const copy = createStore<EditorWorkingState>(() => ({
    editor: createEditorStore(draft),
    saved: { record, draft },
    saving: false,
    message: null,
  }));
  entries.set(key, copy);
  const notify = () => {
    for (const listener of listeners.get(repository) ?? []) listener();
  };
  copy.subscribe(notify);
  copy.getState().editor.subscribe(notify);
  if (previous) notify();
  return copy;
}

/** Called when any team draft of this repository changes, e.g. to mark its dock tab dirty. */
export function subscribeEditorCopies(repository: CorralRepository, listener: () => void) {
  let set = listeners.get(repository);
  if (!set) {
    set = new Set();
    listeners.set(repository, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}

export function editorCopyDirty(
  repository: CorralRepository,
  projectId: string,
  corralId: string,
): boolean {
  const copy = copies.get(repository)?.get(keyOf({ projectId, corralId }));
  return copy ? dirty(copy) : false;
}

/**
 * A team editor opened by its route asks before the person leaves with unsaved changes. Docked in
 * a session it keeps the same working copy whatever pane or address the session moves to, so it
 * never asks; reloading the page still warns.
 */
export const blocksLeaving = (unsaved: boolean, docked: boolean) => unsaved && !docked;

/**
 * Other dock tabs stay mounted beside a docked team, so Ctrl+S saves the team only while focus is
 * inside its view; a code document handles its own save.
 */
export const ownsSaveShortcut = (docked: boolean, view: Element | null, focused: Element | null) =>
  !docked || Boolean(view && focused && view.contains(focused));

export function discardEditorCopy(repository: CorralRepository, record: CorralRecord) {
  copies.get(repository)?.delete(keyOf(record));
}

export function hasUnsavedEditorCopy(repository: CorralRepository): boolean {
  return [...(copies.get(repository)?.values() ?? [])].some(dirty);
}

/**
 * Saves the working copy's draft as the team's next revision. Resolves to the saved record and
 * whether anything was written, or null when saving failed; the outcome is also left in
 * `message` for the view to show.
 */
export async function saveEditorCopy(
  copy: EditorWorkingCopy,
  repository: CorralRepository,
  text: {
    noChanges: string;
    saved: (changed: { definition: boolean }) => string;
  },
): Promise<{ record: CorralRecord; wrote: boolean } | null> {
  const { saved, saving, editor } = copy.getState();
  if (saving) return null;
  const current = editor.getState().draft;
  if (current === saved.draft) {
    copy.setState({ message: { text: text.noChanges, error: false } });
    return { record: saved.record, wrote: false };
  }
  copy.setState({ saving: true });
  try {
    const result = await repository.save({
      definition: current.definition,
      expectedDefinitionRevision: saved.record.definitionRevision,
    });
    if (!result.ok) {
      copy.setState({ message: { text: result.message, error: true } });
      return null;
    }
    copy.setState({
      saved: { record: result.record, draft: current },
      message: { text: text.saved(result.changed), error: false },
    });
    return { record: result.record, wrote: true };
  } catch (error) {
    copy.setState({
      message: { text: error instanceof Error ? error.message : String(error), error: true },
    });
    return null;
  } finally {
    copy.setState({ saving: false });
  }
}
