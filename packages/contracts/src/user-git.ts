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
  /** Local branch names (at most 200) and configured remotes. */
  branches?: string[];
  remotes?: string[];
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
/** Names are checked again by Git itself; this only keeps argv free of options. */
const RefName = z
  .string()
  .min(1)
  .max(250)
  .regex(/^[^-\s][^\s]*$/);
const RemoteName = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
export const GitWriteCommand = z.discriminatedUnion('kind', [
  GitWriteBase.extend({ kind: z.literal('stage'), paths: GitPaths }),
  GitWriteBase.extend({ kind: z.literal('unstage'), paths: GitPaths }),
  GitWriteBase.extend({
    kind: z.literal('commit'),
    message: z
      .string()
      .trim()
      .min(1)
      .max(64 * 1024),
    /** The staged list the person confirmed; the commit records exactly the index. */
    staged: GitPaths,
    runHooks: z.boolean(),
    author: GitAuthor.optional(),
  }),
  GitWriteBase.extend({ kind: z.literal('branch'), name: RefName }),
  GitWriteBase.extend({ kind: z.literal('switch'), branch: RefName }),
  GitWriteBase.extend({ kind: z.literal('fetch'), remote: RemoteName }),
  GitWriteBase.extend({ kind: z.literal('pull'), remote: RemoteName, branch: RefName }),
  GitWriteBase.extend({
    kind: z.literal('push'),
    remote: RemoteName,
    branch: RefName,
    runHooks: z.boolean(),
  }),
]);
export type GitWriteCommand = z.infer<typeof GitWriteCommand>;

export type GitWriteFailure =
  | 'locked'
  | 'hook_failed'
  | 'signing_unavailable'
  | 'author_missing'
  | 'branch_in_use'
  | 'dirty_tree'
  | 'non_fast_forward'
  | 'remote_unavailable';
export interface GitWriteIntent {
  kind: GitWriteCommand['kind'];
  expect: GitWriteCommand['expect'];
  paths: string[];
  /** For a commit: the tree the index held when it was confirmed. */
  tree?: GitOid;
  hooks?: boolean;
  /** branch/switch/pull/push: the branch acted on; switch also records where it came from. */
  branch?: string;
  fromBranch?: string | null;
  remote?: string;
  /** push: the remote branch before the push, read with ls-remote (null when absent). */
  remoteBefore?: GitOid | null;
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
  kind: `git.${GitWriteCommand['kind']}`;
  result: GitWriteResult | null;
}

/** Git config keys a commit may read from the person's own configuration. */
export const GIT_IDENTITY_KEYS = [
  'user.name',
  'user.email',
  'commit.gpgsign',
  'gpg.format',
  'user.signingkey',
  'gpg.program',
  'gpg.ssh.program',
] as const;
