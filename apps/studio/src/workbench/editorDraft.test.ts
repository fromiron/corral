import { createKeyValueCorralRepository } from '@corral/core';
import { emptyDraft } from '@corral/react';
import { expect, it, vi } from 'vitest';
import {
  blocksLeaving,
  discardEditorCopy,
  editorCopyDirty,
  editorWorkingCopy,
  hasUnsavedEditorCopy,
  newEditorWorkingCopy,
  ownsSaveShortcut,
  saveEditorCopy,
  subscribeEditorCopies,
} from './editorDraft.ts';

async function setup() {
  const data = new Map<string, string>();
  const repository = createKeyValueCorralRepository(
    {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => {
        data.set(key, value);
      },
      removeItem: (key) => {
        data.delete(key);
      },
    },
    {
      clock: { nowIso: () => '2026-10-18T00:00:00.000Z', monotonicMs: () => 0 },
      newCorralId: () => 'corral_draft',
    },
  );
  const draft = emptyDraft();
  const saved = await repository.save({
    definition: draft.definition,
    expectedDefinitionRevision: null,
  });
  if (!saved.ok) throw new Error(saved.message);
  return { repository, record: saved.record };
}

it('retains a dirty baseline for revision conflicts, but refreshes a clean copy', async () => {
  const { repository, record } = await setup();
  const copy = editorWorkingCopy(repository, record);
  copy.getState().editor.getState().setName('Unsaved team');
  const newer = { ...record, definitionRevision: record.definitionRevision + 1 };
  expect(editorWorkingCopy(repository, newer)).toBe(copy);
  expect(copy.getState().saved.record?.definitionRevision).toBe(record.definitionRevision);
  expect(hasUnsavedEditorCopy(repository)).toBe(true);
  copy.getState().editor.getState().undo();
  expect(hasUnsavedEditorCopy(repository)).toBe(false);
  const refreshed = editorWorkingCopy(repository, newer);
  expect(refreshed).not.toBe(copy);
  expect(editorWorkingCopy(repository, record)).toBe(refreshed);
  refreshed.setState({ saving: true });
  expect(
    editorWorkingCopy(repository, { ...newer, definitionRevision: newer.definitionRevision + 1 }),
  ).toBe(refreshed);
});

it('isolates repository/project owners and discards only the confirmed copy', async () => {
  const { repository, record } = await setup();
  const other = await setup();
  const copy = editorWorkingCopy(repository, record);
  copy.getState().editor.getState().setName('Keep private draft');
  expect(editorWorkingCopy(other.repository, record)).not.toBe(copy);
  const moved = { ...record, projectId: 'project_other' };
  expect(editorWorkingCopy(repository, moved)).not.toBe(copy);
  discardEditorCopy(repository, moved);
  expect(hasUnsavedEditorCopy(repository)).toBe(true);
  discardEditorCopy(repository, record);
  expect(hasUnsavedEditorCopy(repository)).toBe(false);
});

it('a docked team keeps its draft through moves in the app and saves only from its own view', () => {
  // A route editor asks before leaving; a docked one keeps the same working copy, so it never asks.
  expect(blocksLeaving(true, false)).toBe(true);
  expect(blocksLeaving(true, true)).toBe(false);
  expect(blocksLeaving(false, false)).toBe(false);
  const view = { contains: (node: unknown) => node === 'inside' } as unknown as Element;
  // Other dock tabs stay mounted beside it, so Ctrl+S in a code document is not a team save.
  expect(ownsSaveShortcut(false, null, null)).toBe(true);
  expect(ownsSaveShortcut(true, view, 'inside' as unknown as Element)).toBe(true);
  expect(ownsSaveShortcut(true, view, 'outside' as unknown as Element)).toBe(false);
  expect(ownsSaveShortcut(true, null, 'inside' as unknown as Element)).toBe(false);
});

it('tab titles follow a team draft becoming dirty and clean again', async () => {
  const { repository, record } = await setup();
  const listener = vi.fn();
  const stop = subscribeEditorCopies(repository, listener);
  const copy = editorWorkingCopy(repository, record);
  expect(editorCopyDirty(repository, record.projectId, record.corralId)).toBe(false);
  copy.getState().editor.getState().setName('Draft name');
  expect(listener).toHaveBeenCalled();
  expect(editorCopyDirty(repository, record.projectId, record.corralId)).toBe(true);
  copy.getState().editor.getState().undo();
  expect(editorCopyDirty(repository, record.projectId, record.corralId)).toBe(false);
  stop();
  listener.mockClear();
  copy.getState().editor.getState().setName('Unheard');
  expect(listener).not.toHaveBeenCalled();
});

const saveText = {
  noChanges: 'No changes',
  saved: () => 'Saved',
  renamed: (name: string) => `Saved as ${name}`,
  invalid: 'Invalid definition',
};

it('holds an untouched project draft only until leaving; a change or template counts as content', async () => {
  const { repository, record } = await setup();
  const write = vi.spyOn(repository, 'save');
  const seed = () => emptyDraft('corral_new', 'New team').definition;
  const copy = newEditorWorkingCopy(repository, record.projectId, false, seed);
  expect(copy.getState().saved.record).toBeNull();
  expect(newEditorWorkingCopy(repository, record.projectId, false, seed)).toBe(copy);
  expect(hasUnsavedEditorCopy(repository)).toBe(false);
  expect(await saveEditorCopy(copy, repository, saveText)).toBeNull();
  copy.getState().editor.getState().setName('Changed');
  expect(hasUnsavedEditorCopy(repository)).toBe(true);
  copy.getState().editor.getState().undo();
  expect(hasUnsavedEditorCopy(repository)).toBe(false);
  copy.getState().editor.getState().setName('Changed');
  copy.getState().editor.getState().setName('New team');
  expect(hasUnsavedEditorCopy(repository)).toBe(false);
  expect(await saveEditorCopy(copy, repository, saveText)).toBeNull();
  discardEditorCopy(repository, { projectId: record.projectId, corralId: null });
  expect(newEditorWorkingCopy(repository, record.projectId, true, seed)).not.toBe(copy);
  expect(hasUnsavedEditorCopy(repository)).toBe(true);
  expect(write).not.toHaveBeenCalled();
  expect(await repository.list()).toHaveLength(1);
});

it('promotes the same store on first save, announces an adjusted name, and ignores a concurrent save', async () => {
  const { repository, record } = await setup();
  const copy = newEditorWorkingCopy(
    repository,
    record.projectId,
    true,
    () => emptyDraft('corral_new', 'Template').definition,
  );
  const editor = copy.getState().editor;
  editor.getState().setName(record.name);
  const save = vi.spyOn(repository, 'save');
  const pending = saveEditorCopy(copy, repository, saveText);
  expect(await saveEditorCopy(copy, repository, saveText)).toBeNull();
  const result = await pending;
  expect(save).toHaveBeenCalledTimes(1);
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({
      projectId: record.projectId,
      createId: 'corral_new',
      expectedDefinitionRevision: null,
    }),
  );
  if (!result) throw Error('Expected first save to create a team');
  expect(editorWorkingCopy(repository, result.record)).toBe(copy);
  expect(copy.getState().editor).toBe(editor);
  expect(copy.getState().message?.text).toBe(`Saved as ${record.name} (2)`);
  expect(editor.getState().draft.definition.name).toBe(`${record.name} (2)`);
  expect(hasUnsavedEditorCopy(repository)).toBe(false);
  expect(await repository.list()).toHaveLength(2);
  editor.getState().undo();
  expect(editor.getState().draft.definition.name).toBe('Template');
});

it('keeps a failed first save open and reconciles a lost successful response after a further edit', async () => {
  const { repository, record } = await setup();
  const copy = newEditorWorkingCopy(
    repository,
    record.projectId,
    true,
    () => emptyDraft('corral_retry', 'First').definition,
  );
  const write = repository.save.bind(repository);
  const save = vi.spyOn(repository, 'save').mockImplementationOnce(async (request) => {
    await write(request);
    throw Error('Lost response');
  });
  const draft = copy.getState().editor.getState().draft;
  expect(await saveEditorCopy(copy, repository, saveText)).toBeNull();
  expect(copy.getState().editor.getState().draft).toBe(draft);
  expect(copy.getState().saved.record).toBeNull();
  expect(copy.getState().message).toMatchObject({ text: 'Lost response', error: true });
  copy.getState().editor.getState().setBrief('Edited after lost response');
  const result = await saveEditorCopy(copy, repository, saveText);
  expect(result?.record.definition.input.brief).toBe('Edited after lost response');
  expect(result?.record.definitionRevision).toBe(2);
  expect(save.mock.calls.map(([r]) => [r.definition.id, r.expectedDefinitionRevision])).toEqual([
    ['corral_retry', null],
    ['corral_retry', null],
    ['corral_retry', 1],
  ]);
  expect(await repository.list()).toHaveLength(2);
});

it('reconciles a lost create if an intervening revision no longer matches the retried draft', async () => {
  const { repository, record } = await setup();
  const definition = emptyDraft('corral_replay', 'First').definition;
  const copy = newEditorWorkingCopy(repository, record.projectId, true, () => definition);
  const write = repository.save.bind(repository);
  vi.spyOn(repository, 'save').mockImplementationOnce(async (request) => {
    await write(request);
    throw Error('Lost response');
  });
  expect(await saveEditorCopy(copy, repository, saveText)).toBeNull();
  await write({
    definition: { ...definition, name: 'Other editor' },
    expectedDefinitionRevision: 1,
  });
  const saved = await saveEditorCopy(copy, repository, saveText);
  expect(saved?.record.name).toBe('First');
  expect(saved?.record.definitionRevision).toBe(3);
  expect(await repository.list()).toHaveLength(2);
});
