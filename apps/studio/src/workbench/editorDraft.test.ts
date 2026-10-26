import { createKeyValueCorralRepository } from '@corral/core';
import { emptyDraft } from '@corral/react';
import { expect, it, vi } from 'vitest';
import {
  blocksLeaving,
  discardEditorCopy,
  editorCopyDirty,
  editorWorkingCopy,
  hasUnsavedEditorCopy,
  ownsSaveShortcut,
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
    layout: { nodes: draft.layout, viewport: draft.viewport },
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
  expect(copy.getState().saved.record.definitionRevision).toBe(record.definitionRevision);
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
