import type { OutputNode } from '@corral/contracts';
import { Coordinator, compileDefinition, InMemoryRunStore, planRun } from '@corral/core';
import {
  FakeClock,
  linearCorral,
  ScriptedAgentAdapter,
  SequentialIdFactory,
} from '@corral/testkit';
import { expect, it } from 'vitest';
import {
  draftFromDefinition,
  type EditorDraft,
  exportDefinition,
  importDefinition,
} from '../src/editor/model.ts';
import { createEditorStore } from '../src/editor/store.ts';
import en from '../src/messages/en.json' with { type: 'json' };
import {
  type EditResult,
  patchNode,
  replaceOutputSource,
  setRequiredOutputReview,
} from '../src/team-editor/commands.ts';

const labels = en.Inspector.requiredReviewLabels;

function output(draft: EditorDraft) {
  return draft.definition.nodes.find((n): n is OutputNode => n.type === 'output')!;
}
function success(result: EditResult) {
  if (!result.ok) throw Error(result.reason);
  return result.draft;
}
function initial() {
  const definition = linearCorral(['planner', 'writer']);
  definition.sharedOutrider = {
    targets: { kind: 'all' },
    modelProfile: 'critic',
    principles: 'Check the source.',
  };
  return draftFromDefinition(definition);
}
function duplicate(draft: EditorDraft) {
  return patchNode(draft, 'output', {
    inputBindings: [
      ...output(draft).inputBindings,
      { kind: 'task_output', name: 'final', sourceNodeId: 'writer' },
    ],
  });
}
function drop(draft: EditorDraft, index: number) {
  return patchNode(draft, 'output', {
    inputBindings: output(draft).inputBindings.filter((_, i) => i !== index),
  });
}
function admitted(draft: EditorDraft) {
  return [compileDefinition(draft.definition).ok, planRun(draft.definition).ok];
}

it('blocks an unreviewed replacement even when a second identical result still reads the original producer', () => {
  const enabled = success(
    setRequiredOutputReview(initial(), 'output', 'final', 'writer', labels, 0),
  );
  const two = duplicate(enabled);
  const store = createEditorStore(two);
  const changed = success(replaceOutputSource(two, 'output', 0, 'planner'));
  store.getState().applyDraft(changed);
  expect(compileDefinition(changed.definition).diagnostics).toContainEqual(
    expect.objectContaining({ code: 'REQUIRED_OUTPUT_REVIEW', nodeId: 'output' }),
  );
  expect(admitted(changed)).toEqual([false, false]);
  const clock = new FakeClock();
  const coordinator = new Coordinator({
    store: new InMemoryRunStore(),
    clock,
    timers: clock,
    ids: new SequentialIdFactory(),
    agents: new ScriptedAgentAdapter({ turns: 1 }),
  });
  const started = coordinator.startRun({
    schemaVersion: '0.1',
    commandId: 'guarded-output',
    mode: 'mock',
    definition: changed.definition,
  });
  expect(started.runId).toBeNull();
  store.getState().undo();
  expect(admitted(store.getState().draft)).toEqual([true, true]);
  store.getState().redo();
  expect(admitted(store.getState().draft)).toEqual([false, false]);
  expect(admitted(success(replaceOutputSource(two, 'output', 1, 'planner')))).toEqual([true, true]);
});

it('keeps a selected duplicate distinct through deletion, save, removal of its orphan policy and re-enabling', () => {
  const two = duplicate(initial());
  const enabled = success(setRequiredOutputReview(two, 'output', 'final', 'writer', labels, 1));
  expect(admitted(drop(enabled, 0))).toEqual([true, true]);
  const orphaned = drop(enabled, 1);
  expect(admitted(orphaned)).toEqual([false, false]);
  const imported = importDefinition(exportDefinition(orphaned));
  if (!imported.ok) throw Error(imported.errors.join(', '));
  expect(admitted(imported.draft)).toEqual([false, false]);
  const gate = output(orphaned).requiredReviews![0]!;
  const replacement = success(
    setRequiredOutputReview(orphaned, 'output', 'final', 'writer', labels, 0),
  );
  expect(admitted(replacement)).toEqual([false, false]);
  const kept = success(
    setRequiredOutputReview(
      replacement,
      'output',
      'final',
      'writer',
      false,
      undefined,
      gate.bindingId,
    ),
  );
  expect(admitted(kept)).toEqual([true, true]);
  expect(output(kept).requiredReviews).toHaveLength(1);
  const cleared = success(
    setRequiredOutputReview(
      orphaned,
      'output',
      'final',
      'writer',
      false,
      undefined,
      gate.bindingId,
    ),
  );
  expect(admitted(cleared)).toEqual([true, true]);
  const fresh = success(setRequiredOutputReview(cleared, 'output', 'final', 'writer', labels, 0));
  expect(admitted(fresh)).toEqual([true, true]);
  const altered = success(replaceOutputSource(fresh, 'output', 0, 'planner'));
  expect(admitted(altered)).toEqual([false, false]);
});

it('reads older unambiguous policies and refuses to infer their row from a duplicated name', () => {
  const current = success(
    setRequiredOutputReview(initial(), 'output', 'final', 'writer', labels, 0),
  );
  const old = output(current);
  const untagged = patchNode(current, 'output', {
    inputBindings: old.inputBindings.map(({ bindingId: _id, ...binding }) => binding),
    requiredReviews: old.requiredReviews!.map(({ bindingId: _id, ...gate }) => gate),
  });
  expect(admitted(untagged)).toEqual([true, true]);
  const ambiguous = duplicate(untagged);
  expect(admitted(ambiguous)).toEqual([false, false]);
  expect(admitted(success(replaceOutputSource(ambiguous, 'output', 0, 'planner')))).toEqual([
    false,
    false,
  ]);
  expect(admitted(duplicate(initial()))).toEqual([true, true]);
});
