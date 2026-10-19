import { z } from 'zod';
import { ContentHash } from './harness.ts';
import { Identifier } from './ids.ts';

const Tree = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const CheckpointTarget = z.enum(['working_copy', 'original']);
export const HunkRequest = z.strictObject({
  from: Tree,
  to: Tree,
  path: z.string().min(1).max(1000),
});
export const HunkPlanRequest = HunkRequest.extend({
  planId: Identifier,
  patchHash: ContentHash,
  hunkIds: z
    .array(ContentHash)
    .min(1)
    .max(200)
    .refine((ids) => new Set(ids).size === ids.length),
  action: z.enum(['apply_original', 'revert_working_copy']),
});
export type HunkRequest = z.infer<typeof HunkRequest>;
export type HunkPlanRequest = z.infer<typeof HunkPlanRequest>;
export interface HunkSet {
  from: string;
  to: string;
  path: string;
  patchHash: string;
  hunks: { id: string; patch: string }[];
}
const HunkEvidence = HunkPlanRequest.omit({ planId: true }).extend({
  requestHash: ContentHash,
  expectedTree: Tree,
  beforeHash: ContentHash.nullable(),
  afterHash: ContentHash.nullable(),
});
export const CaptureCheckpoint = z.strictObject({
  checkpointId: Identifier,
  label: z.string().trim().min(1).max(120),
  target: CheckpointTarget.optional(),
});
export const CheckpointManifest = z
  .strictObject({
    version: z.union([z.literal(1), z.literal(2)]),
    target: CheckpointTarget.optional(),
    hunk: HunkEvidence.optional(),
    checkpointId: Identifier,
    sessionId: Identifier,
    runId: Identifier.nullable(),
    runSeq: z.int().min(0).nullable(),
    kind: z.enum([
      'manual',
      'before_run',
      'after_run',
      'before_restore',
      'hunk_proposal',
      'runtime',
    ]),
    label: z.string().max(120),
    tree: Tree,
    createdAt: z.iso.datetime(),
    files: z.literal('tracked_and_unignored'),
  })
  .refine(
    (value) =>
      value.version === 1
        ? !value.target && !value.hunk && value.kind !== 'hunk_proposal'
        : Boolean(value.target) && (value.kind !== 'hunk_proposal' || Boolean(value.hunk)),
    'checkpoint version and target must agree',
  );
export type CheckpointManifest = z.infer<typeof CheckpointManifest>;
export interface FileCheckpoint extends Omit<CheckpointManifest, 'tree'> {
  tree: string | null;
  manifestHash: string | null;
  state: 'incomplete' | 'ready' | 'expired';
  pinned: boolean;
}
export const RestoreCheckpoint = z.strictObject({
  operationId: Identifier,
  checkpointId: Identifier,
  manifestHash: ContentHash,
  expectedTree: Tree,
});
export type RestoreCheckpoint = z.infer<typeof RestoreCheckpoint>;
export interface CheckpointRestorePlan {
  target?: z.infer<typeof CheckpointTarget>;
  checkpointId: string;
  manifestHash: string;
  expectedTree: string;
  targetTree: string;
  files: { path: string; status: string }[];
}
export interface CheckpointRestore {
  target?: z.infer<typeof CheckpointTarget>;
  operationId: string;
  checkpointId: string;
  beforeCheckpointId: string | null;
  from: string;
  to: string;
  state: 'applying' | 'applied' | 'partial' | 'uncertain' | 'refused';
  createdAt: string;
}
