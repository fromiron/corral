import { createKeyValueCorralRepository } from '@corral/core';
import { emptyDraft } from '@corral/react';
import { expect, it } from 'vitest';
import { discardEditorCopy, editorWorkingCopy, hasUnsavedEditorCopy } from './editorDraft.ts';

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
