import { z } from 'zod';
import { Identifier } from './ids.ts';
import { GitOid } from './user-git.ts';
import { VerificationReport } from './verification.ts';
export const CandidateView = z.strictObject({
  candidateId: Identifier,
  modelProfile: Identifier,
  state: z.enum(['pending', 'running', 'acceptable', 'failed', 'cancelled']),
  tree: GitOid.nullable(),
  artifactVersionId: Identifier.nullable(),
  checks: z.array(VerificationReport),
  reason: z.string().nullable(),
  executionIds: z.array(Identifier),
  usage: z.strictObject({
    outputTokens: z.int().min(0),
    modelCalls: z.int().min(0),
    unknownOutputTokens: z.int().min(0),
  }),
});
export type CandidateView = z.infer<typeof CandidateView>;
export const CandidateComparisonView = z.strictObject({
  runId: Identifier,
  baselineTree: GitOid,
  status: z.enum([
    'running',
    'awaiting_selection',
    'promoting',
    'selected',
    'no_acceptable_candidate',
    'interrupted',
  ]),
  selectedCandidateId: Identifier.nullable(),
  candidates: z.array(CandidateView).min(2).max(5),
});
export type CandidateComparisonView = z.infer<typeof CandidateComparisonView>;
