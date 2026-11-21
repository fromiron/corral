import type { ControlEdge } from '@corral/contracts';
import { boxBoundaryViolation } from '@corral/core';
import type { EditorDraft } from '../editor/model.ts';
import type { EditResult, StepKind, TeamReference } from './commands.ts';

export type AppliedEdit = Extract<EditResult, { ok: true }>;

export interface PlacementDiff {
  removed: ControlEdge[];
  added: ControlEdge[];
  boundary: ControlEdge[];
  disconnects: boolean;
}

export type PlacementPrompt =
  | {
      kind: 'output';
      base: EditorDraft;
      outputId: string;
      step: StepKind;
      reference?: TeamReference;
    }
  | {
      kind: 'preview';
      base: EditorDraft;
      result: AppliedEdit;
      diff: PlacementDiff;
      wrap?: AppliedEdit;
      wrapping?: true;
      location: string;
    };

/** Compare the actual command result, including rewrites which keep the same edge ID. */
export function placementDiff(
  base: EditorDraft,
  result: AppliedEdit,
  checkBoundary = false,
): PlacementDiff {
  const previous = base.definition.controlEdges;
  const next = result.draft.definition.controlEdges;
  const signature = (e: ControlEdge) =>
    JSON.stringify([e.id, e.source, e.sourcePort, e.target, e.targetPort]);
  const previousEdges = new Set(previous.map(signature));
  const nextEdges = new Set(next.map(signature));
  const removed = previous.filter((e) => !nextEdges.has(signature(e)));
  const added = next.filter((e) => !previousEdges.has(signature(e)));
  const boundary: ControlEdge[] = [];
  if (checkBoundary) {
    const before = new Map(base.definition.nodes.map((n) => [n.id, n]));
    const after = new Map(result.draft.definition.nodes.map((n) => [n.id, n]));
    for (const e of next)
      if (boxBoundaryViolation(after, e) && !boxBoundaryViolation(before, e)) boundary.push(e);
  }
  const disconnects = removed.some(
    (old) =>
      !added.some(
        (e) =>
          e.source === result.nodeId && e.target === old.target && e.targetPort === old.targetPort,
      ),
  );
  return { removed, added, boundary, disconnects };
}
