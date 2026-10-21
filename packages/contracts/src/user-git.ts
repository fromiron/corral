import { z } from 'zod';
import { ContentHash } from './harness.ts';
import { WorkspaceTarget } from './workbench.ts';

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
