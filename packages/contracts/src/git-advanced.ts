import { z } from 'zod';
import type { ErrorCode } from './errors.ts';
import { ContentHash } from './harness.ts';
import { Identifier } from './ids.ts';
import { GitAuthor, GitDiffRequest, type GitFileSide, GitOid } from './user-git.ts';
import { type WorkbenchOperation, WorkspaceTarget } from './workbench.ts';

export const GitHunksRequest = GitDiffRequest.extend({
  target: WorkspaceTarget.extend({ kind: z.literal('session') }),
  side: z.enum(['staged', 'unstaged']),
});
export type GitHunksRequest = z.infer<typeof GitHunksRequest>;
export type GitHunks = GitHunksRequest &
  (
    | {
        kind: 'hunks';
        identity: string;
        workingHash: string | null;
        hunks: { id: string; header: string; patch: string }[];
      }
    | { kind: 'unsupported'; reason: string }
  );
const ExpectGit = z.strictObject({ head: GitOid.nullable(), indexHash: ContentHash });
const GitHunkWriteBase = z.strictObject({
  operationId: Identifier,
  target: WorkspaceTarget,
  expect: ExpectGit,
  path: z.string().min(1).max(4096),
  identity: ContentHash,
  hunkIds: z.array(ContentHash).min(1).max(200),
});
export const GitHunkWrite = z.discriminatedUnion('kind', [
  GitHunkWriteBase.extend({ kind: z.literal('stage_hunks') }),
  GitHunkWriteBase.extend({ kind: z.literal('unstage_hunks') }),
]);
export type GitHunkWrite = z.infer<typeof GitHunkWrite>;
export interface GitSequence {
  kind: 'merge' | 'rebase' | 'unsupported';
  identity: string;
  originalHead: string | null;
  onto: string | null;
  headName: string | null;
  reason: string | null;
}
export interface GitSequenceState {
  target: WorkspaceTarget;
  head: string | null;
  indexHash: string;
  workingTreeHash: string;
  sequence: GitSequence | null;
  conflicts: string[];
  /** Null means this state was not started or continued by a Corral operation. */
  ownerOperationId: string | null;
  localBranches: { name: string; oid: string }[];
}
export const GitConflictRequest = z.strictObject({
  target: WorkspaceTarget,
  path: z.string().min(1).max(4096),
  head: GitOid.nullable(),
  indexHash: ContentHash,
  sequenceIdentity: ContentHash.nullable(),
});
export type GitConflictRequest = z.infer<typeof GitConflictRequest>;
export interface GitConflict {
  target: WorkspaceTarget;
  path: string;
  head: string | null;
  indexHash: string;
  sequenceIdentity: string | null;
  base: GitFileSide;
  ours: GitFileSide;
  theirs: GitFileSide;
  current: GitFileSide;
  currentHash: string | null;
  unsupported: string | null;
}
const SequenceBase = z.strictObject({
  operationId: Identifier,
  target: WorkspaceTarget,
  expect: ExpectGit,
  sequenceIdentity: ContentHash.nullable(),
  workingTreeHash: ContentHash,
});
const Branch = z
  .string()
  .min(1)
  .max(250)
  .regex(/^[^-\s][^\s]*$/);
export const GitSequenceCommand = z.discriminatedUnion('kind', [
  SequenceBase.extend({
    kind: z.enum(['merge', 'rebase']),
    branch: Branch,
    branchCommit: GitOid,
    runHooks: z.boolean(),
    author: GitAuthor.optional(),
  }),
  SequenceBase.extend({
    kind: z.literal('continue'),
    runHooks: z.boolean(),
    author: GitAuthor.optional(),
  }),
  SequenceBase.extend({ kind: z.literal('abort'), confirmed: z.literal(true) }),
]);
export type GitSequenceCommand = z.infer<typeof GitSequenceCommand>;
export type GitAdvancedCommand = GitHunkWrite | GitSequenceCommand;
export interface GitAdvancedIntent {
  command: GitAdvancedCommand;
  /** The exact index content prepared before publication or process start. */
  expectedIndexHash?: string;
  sequenceBefore?: GitSequence | null;
  /** Frozen local branch commit; never a remote operation. */
  branchCommit?: string;
}
export interface GitAdvancedOperation extends WorkbenchOperation {
  kind: `git.${GitAdvancedCommand['kind']}`;
  result: {
    kind: 'pending' | 'applied' | 'conflicted' | 'error';
    intent: GitAdvancedIntent;
    head?: string | null;
    indexHash?: string;
    sequence?: GitSequence | null;
    workingTreeHash?: string;
    cleanupConfirmed?: boolean;
    error?: { code: ErrorCode; message: string };
  };
}
export const GitAdvancedReconcile = z.strictObject({
  target: WorkspaceTarget,
  operationId: Identifier,
});
export type GitAdvancedReconcile = z.infer<typeof GitAdvancedReconcile>;
