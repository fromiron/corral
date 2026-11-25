import { z } from 'zod';
import { Identifier } from './ids.ts';

export const PullRequestSummary = z.strictObject({
  number: z.number().int().positive(),
  url: z.string().url(),
  title: z.string(),
  state: z.enum(['open', 'merged', 'closed']),
  isDraft: z.boolean(),
  checks: z
    .strictObject({
      passed: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      pending: z.number().int().nonnegative(),
    })
    .nullable(),
  review: z.enum(['approved', 'changes_requested', 'review_required']).nullable(),
  conflicting: z.boolean(),
});
export type PullRequestSummary = z.infer<typeof PullRequestSummary>;

export const PullRequestHead = z.strictObject({
  branch: z.string().min(1).max(255),
  commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
});
export type PullRequestHead = z.infer<typeof PullRequestHead>;

export const PullRequestView = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('hidden'),
    reason: z.enum(['no_paddock', 'detached', 'not_github', 'default_branch', 'nothing_to_open']),
  }),
  z.strictObject({ kind: z.literal('gh_missing') }),
  z.strictObject({ kind: z.literal('gh_signed_out') }),
  z.strictObject({ kind: z.literal('read_failed') }),
  z.strictObject({
    kind: z.literal('open'),
    branch: z.string(),
    base: z.string(),
    pr: PullRequestSummary,
    push: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('none'),
    branch: z.string(),
    base: z.string(),
    action: z.enum(['push_and_open', 'open', 'sync']).nullable(),
    previous: PullRequestSummary.nullable(),
  }),
]);
export type PullRequestView = z.infer<typeof PullRequestView>;

export const PullRequestDraftRequest = z.strictObject({ operationId: Identifier });
export type PullRequestDraftRequest = z.infer<typeof PullRequestDraftRequest>;

export const PullRequestDraft = z.strictObject({
  title: z.string(),
  body: z.string(),
  head: PullRequestHead,
  base: z.string(),
  source: z.enum(['model', 'commits']),
});
export type PullRequestDraft = z.infer<typeof PullRequestDraft>;

export const OpenPullRequest = z.strictObject({
  operationId: Identifier,
  title: z.string().trim().min(1).max(256),
  body: z.string().max(65_536),
  head: PullRequestHead,
});
export type OpenPullRequest = z.infer<typeof OpenPullRequest>;
