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
const keyOf = (record: CorralRecord) => JSON.stringify([record.projectId, record.corralId]);
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
      (previous.getState().saved.record.definitionRevision >= record.definitionRevision &&
        previous.getState().saved.record.layoutRevision >= record.layoutRevision))
  )
    return previous;
  const draft = draftFromDefinition(record.definition, record.layout);
  const copy = createStore<EditorWorkingState>(() => ({
    editor: createEditorStore(draft),
    saved: { record, draft },
    saving: false,
    message: null,
  }));
  entries.set(key, copy);
  return copy;
}

export function discardEditorCopy(repository: CorralRepository, record: CorralRecord) {
  copies.get(repository)?.delete(keyOf(record));
}

export function hasUnsavedEditorCopy(repository: CorralRepository): boolean {
  return [...(copies.get(repository)?.values() ?? [])].some(dirty);
}
