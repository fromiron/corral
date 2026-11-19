import { type CorralDefinition, CorralDefinitionDraft, canonicalJson } from '@corral/contracts';
import { type CorralRecord, type CorralRepository, definitionHash } from '@corral/core';
import {
  createEditorStore,
  draftFromDefinition,
  type EditorDraft,
  type EditorStore,
} from '@corral/react';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { templateCopyName } from '../templates.ts';

interface EditorWorkingState {
  projectId: string;
  editor: EditorStore;
  /** A seeded template has neither a saved record nor a clean draft until first save. */
  saved: { record: CorralRecord | null; draft: EditorDraft | null };
  unconfirmedCreate: boolean;
  saving: boolean;
  message: { text: string; error: boolean; visible?: boolean; problems?: boolean } | null;
}
export type EditorWorkingCopy = StoreApi<EditorWorkingState>;

const copies = new WeakMap<CorralRepository, Map<string, EditorWorkingCopy>>();
const listeners = new WeakMap<CorralRepository, Set<() => void>>();
type CopyKey = { projectId: string; corralId: string | null };
const keyOf = ({ projectId, corralId }: CopyKey) => JSON.stringify([projectId, corralId]);

/** An empty entry counts content, not undo steps: typing and clearing a field is clean. */
export function editorDraftChanged(draft: EditorDraft, saved: EditorWorkingState['saved']) {
  if (draft === saved.draft) return false;
  if (saved.record || !saved.draft) return true;
  const baseline = saved.draft.definition;
  const current = draft.definition;
  return (
    current.name !== baseline.name ||
    current.input.brief !== baseline.input.brief ||
    current.nodes.length !== baseline.nodes.length ||
    canonicalJson(current) !== canonicalJson(baseline)
  );
}

const dirty = (copy: EditorWorkingCopy) => {
  const state = copy.getState();
  return state.saving || editorDraftChanged(state.editor.getState().draft, state.saved);
};

function createWorkingCopy(
  repository: CorralRepository,
  key: CopyKey,
  record: CorralRecord | null,
  definition: CorralDefinition,
  seeded: boolean,
): EditorWorkingCopy {
  let entries = copies.get(repository);
  if (!entries) {
    entries = new Map();
    copies.set(repository, entries);
  }
  const draft = draftFromDefinition(definition);
  const copy = createStore<EditorWorkingState>(() => ({
    projectId: key.projectId,
    editor: createEditorStore(draft),
    saved: { record, draft: seeded ? null : draft },
    unconfirmedCreate: false,
    saving: false,
    message: null,
  }));
  entries.set(keyOf(key), copy);
  const notify = () => {
    for (const listener of listeners.get(repository) ?? []) listener();
  };
  copy.subscribe(notify);
  copy.getState().editor.subscribe(notify);
  return copy;
}

/** A new entry and a saved entry share a store across the first save. Settings reuse it too. */
export function newEditorWorkingCopy(
  repository: CorralRepository,
  projectId: string,
  seeded: boolean,
  seed: () => CorralDefinition,
): EditorWorkingCopy {
  const key = { projectId, corralId: null };
  return (
    copies.get(repository)?.get(keyOf(key)) ??
    createWorkingCopy(repository, key, null, seed(), seeded)
  );
}

export function newEditorName(repository: CorralRepository, projectId: string) {
  return copies
    .get(repository)
    ?.get(keyOf({ projectId, corralId: null }))
    ?.getState()
    .editor.getState().draft.definition.name;
}

export function editorWorkingCopy(
  repository: CorralRepository,
  record: CorralRecord,
): EditorWorkingCopy {
  const previous = copies.get(repository)?.get(keyOf(record));
  if (
    previous &&
    (dirty(previous) ||
      (previous.getState().saved.record?.definitionRevision ?? 0) >= record.definitionRevision)
  )
    return previous;
  const copy = createWorkingCopy(repository, record, record, record.definition, false);
  if (previous) for (const listener of listeners.get(repository) ?? []) listener();
  return copy;
}

/** The old creation fields required a non-blank name and request. Keep that validation
 * without trimming a person's draft while they type. Criteria fields already trim lines. */
export function firstSaveDefinition(definition: CorralDefinition): CorralDefinition {
  const name = definition.name.trim();
  const brief = definition.input.brief.trim() ? definition.input.brief : '';
  if (name === definition.name && brief === definition.input.brief) return definition;
  return { ...definition, name, input: { ...definition.input, brief } };
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

export function discardEditorCopy(repository: CorralRepository, record: CopyKey) {
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
    renamed: (name: string) => string;
    invalid: string;
  },
): Promise<{ record: CorralRecord; draft: EditorDraft; wrote: boolean } | null> {
  const { saved, saving, editor, projectId, unconfirmedCreate } = copy.getState();
  if (saving) return null;
  const current = editor.getState().draft;
  if (!editorDraftChanged(current, saved)) {
    copy.setState({ message: { text: text.noChanges, error: false } });
    return saved.record ? { record: saved.record, draft: current, wrote: false } : null;
  }
  copy.setState({ saving: true });
  let creating = false;
  try {
    let definition = current.definition;
    if (!saved.record) {
      definition = firstSaveDefinition(definition);
      if (!CorralDefinitionDraft.safeParse(definition).success) {
        copy.setState({ message: { text: text.invalid, error: true, problems: true } });
        return null;
      }
      const teams = await repository.list();
      const name = templateCopyName(
        definition.name,
        projectId,
        teams.filter((team) => team.corralId !== definition.id),
      );
      if (name !== definition.name) definition = { ...definition, name };
      creating = true;
    }
    let result = await repository.save({
      definition,
      expectedDefinitionRevision: saved.record?.definitionRevision ?? null,
      ...(creating ? { projectId, createId: definition.id } : {}),
    });
    // Only recover an ambiguous create that this copy actually sent. An unrelated id
    // collision on the first press is an error, never permission to overwrite that team.
    if (creating && unconfirmedCreate) {
      const existing =
        !result.ok && result.error === 'revision_conflict'
          ? await repository.get(definition.id)
          : result.ok &&
              !result.changed.definition &&
              result.record.definitionHash !== definitionHash(definition)
            ? result.record
            : null;
      if (existing?.projectId === projectId) {
        result = await repository.save({
          definition,
          expectedDefinitionRevision: existing.definitionRevision,
        });
      }
    }
    if (!result.ok) {
      copy.setState({
        ...(creating && result.error === 'storage_unavailable' ? { unconfirmedCreate: true } : {}),
        message: { text: result.message, error: true },
      });
      return null;
    }
    // A suffix is part of saving, not a new undo step. Concurrent edits stay dirty.
    const committed = definition === current.definition ? current : { ...current, definition };
    if (committed !== current && editor.getState().draft === current)
      editor.setState({ draft: committed });
    if (creating) {
      const entries = copies.get(repository);
      const key = keyOf({ projectId, corralId: null });
      if (entries?.get(key) === copy) {
        entries.delete(key);
        entries.set(keyOf(result.record), copy);
      }
    }
    const renamed = creating && current.definition.name !== definition.name;
    copy.setState({
      saved: { record: result.record, draft: committed },
      unconfirmedCreate: false,
      message: renamed
        ? { text: text.renamed(definition.name), error: false, visible: true }
        : { text: text.saved(result.changed), error: false },
    });
    return { record: result.record, draft: committed, wrote: true };
  } catch (error) {
    copy.setState({
      ...(creating ? { unconfirmedCreate: true } : {}),
      message: { text: error instanceof Error ? error.message : String(error), error: true },
    });
    return null;
  } finally {
    copy.setState({ saving: false });
  }
}
