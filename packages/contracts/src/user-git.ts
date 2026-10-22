import { z } from 'zod';
import type { ErrorCode } from './errors.ts';
import { ContentHash } from './harness.ts';
import { Identifier } from './ids.ts';
import { type WorkbenchOperation, WorkspaceTarget } from './workbench.ts';

export const GitOid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export type GitOid = z.infer<typeof GitOid>;

export const UserGitTarget = z.discriminatedUnion('kind', [
  WorkspaceTarget.extend({ kind: z.literal('session') }),
  WorkspaceTarget.pick({ hostId: true, projectId: true, bindingId: true }).extend({
    kind: z.literal('project'),
  }),
]);
export type UserGitTarget = z.infer<typeof UserGitTarget>;

export const GitDiffRequest = z.strictObject({
  target: UserGitTarget,
  side: z.enum(['staged', 'unstaged', 'untracked']),
  path: z.string().min(1).max(4096),
  head: GitOid.nullable(),
  indexHash: ContentHash,
});
export type GitDiffRequest = z.infer<typeof GitDiffRequest>;

export interface GitHead {
  oid: GitOid | null;
  branch: string | null;
  detached: boolean;
  unborn: boolean;
  shallow: boolean;
  upstream: { name: string; ahead: number | null; behind: number | null } | null;
}

export interface GitStatusEntry {
  kind: 'ordinary' | 'renamed' | 'unmerged' | 'untracked';
  path: string;
  originalPath?: string;
  indexStatus: string;
  worktreeStatus: string;
  submodule: boolean;
}

export interface GitStatus {
  target: UserGitTarget;
  head: GitHead;
  indexHash: string;
  entries: GitStatusEntry[];
  truncated: boolean;
  filtersDisabled: boolean;
}

export type GitFileSide =
  | { kind: 'text'; text: string }
  | { kind: 'binary'; bytes: number }
  | { kind: 'too_large'; bytes: number }
  | { kind: 'absent' };

export type GitDiff = GitDiffRequest & {
  originalPath?: string;
  filtersDisabled: boolean;
} & (
    | { kind: 'diff'; before: GitFileSide; after: GitFileSide }
    | { kind: 'unsupported'; reason: 'symlink' | 'gitlink' | 'unmerged' }
  );

/** P13 writes act on a session's managed copy only; the linked original stays read-only. */
const GitPaths = z.array(z.string().min(1).max(4096)).min(1).max(2000);
const GitWriteBase = z.strictObject({
  operationId: Identifier,
  target: WorkspaceTarget,
  expect: z.strictObject({ head: GitOid.nullable(), indexHash: ContentHash }),
});
export const GitAuthor = z.strictObject({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().min(3).max(320),
});
export type GitAuthor = z.infer<typeof GitAuthor>;
export const GitWriteCommand = z.discriminatedUnion('kind', [
  GitWriteBase.extend({ kind: z.literal('stage'), paths: GitPaths }),
  GitWriteBase.extend({ kind: z.literal('unstage'), paths: GitPaths }),
  GitWriteBase.extend({
    kind: z.literal('commit'),
    message: z.string().trim().min(1).max(64 * 1024),
    /** The staged list the person confirmed; the commit records exactly the index. */
    staged: GitPaths,
    runHooks: z.boolean(),
    author: GitAuthor.optional(),
  }),
]);
export type GitWriteCommand = z.infer<typeof GitWriteCommand>;

export type GitWriteFailure = 'locked' | 'hook_failed' | 'signing_unavailable' | 'author_missing';
export interface GitWriteIntent {
  kind: GitWriteCommand['kind'];
  expect: GitWriteCommand['expect'];
  paths: string[];
  /** For a commit: the tree the index held when it was confirmed. */
  tree?: GitOid;
  hooks?: boolean;
}
export type GitWriteResult = (
  | { kind: 'pending' }
  | {
      kind: 'applied';
      head: GitOid | null;
      indexHash: string;
      commit?: GitOid;
      signed?: boolean;
      hooksRan?: boolean;
    }
  | { kind: 'error'; code: ErrorCode; message: string; reason?: GitWriteFailure }
) & { intent: GitWriteIntent };
export interface GitOperation extends WorkbenchOperation {
  kind: 'git.stage' | 'git.unstage' | 'git.commit';
  result: GitWriteResult | null;
}

/** Git config keys a commit may read from the person's own configuration (D5). */
export const GIT_IDENTITY_KEYS = [
  'user.name',
  'user.email',
  'commit.gpgsign',
  'gpg.format',
  'user.signingkey',
  'gpg.program',
  'gpg.ssh.program',
] as const;
