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
/** One refinement round on the winner's copy (CR-048 §3). */
export const RefinementRoundView = z.strictObject({
  round: z.int().min(1).max(3),
  state: z.enum(['running', 'accepted', 'discarded', 'cancelled']),
  tree: GitOid.nullable(),
  artifactVersionId: Identifier.nullable(),
  reason: z.string().nullable(),
});
export type RefinementRoundView = z.infer<typeof RefinementRoundView>;

/** Version 2 Ultra's judgment, refinement and automatic apply (CR-048). */
export const TournamentView = z.strictObject({
  judgeProfile: Identifier,
  autoApply: z.boolean(),
  refinementRounds: z.int().min(0).max(3),
  winnerCandidateId: Identifier.nullable(),
  ranking: z.array(Identifier).max(5),
  judgment: z.strictObject({
    state: z.enum(['pending', 'skipped', 'valid', 'invalid']),
    artifactVersionId: Identifier.nullable(),
    reason: z.string().nullable(),
  }),
  rounds: z.array(RefinementRoundView).max(3),
  /** Why the automatic apply did not happen; manual selection stays open. */
  held: z.string().nullable(),
});
export type TournamentView = z.infer<typeof TournamentView>;

export const CandidateComparisonView = z.strictObject({
  runId: Identifier,
  baselineTree: GitOid,
  status: z.enum([
    'running',
    'judging',
    'refining',
    'awaiting_selection',
    'judgment_failed',
    'auto_apply_held',
    'promoting',
    'selected',
    'no_acceptable_candidate',
    'interrupted',
  ]),
  selectedCandidateId: Identifier.nullable(),
  candidates: z.array(CandidateView).min(2).max(5),
  tournament: TournamentView.optional(),
});
export type CandidateComparisonView = z.infer<typeof CandidateComparisonView>;
/** Statuses in which a person may pick the candidate to apply. */
export const MANUAL_SELECTION_STATUSES: ReadonlySet<CandidateComparisonView['status']> = new Set([
  'awaiting_selection',
  'judgment_failed',
  'auto_apply_held',
]);

const Label = z.enum(['A', 'B', 'C', 'D', 'E']);
/** What the judge submits when choosing among anonymous passing candidates. */
export const SelectionJudgment = z.strictObject({
  version: z.literal(1),
  kind: z.literal('selection'),
  winner: Label,
  ranking: z.array(Label).min(1).max(5),
  reasons: z
    .array(
      z.strictObject({
        candidate: Label,
        criterion: z.string().min(1).max(500),
        evidence: z.string().min(1).max(2000),
      }),
    )
    .max(50),
  improvements: z.array(z.string().min(1).max(2000)).max(20),
  borrow: z
    .array(
      z.strictObject({
        from: Label,
        what: z.string().min(1).max(2000),
        paths: z.array(z.string().min(1).max(1000)).min(1).max(20),
      }),
    )
    .max(20),
});
export type SelectionJudgment = z.infer<typeof SelectionJudgment>;
/** What the judge submits when comparing a refinement round with the accepted version. */
export const RefinementJudgment = z.strictObject({
  version: z.literal(1),
  kind: z.literal('refinement'),
  verdict: z.enum(['improved', 'equal', 'worse']),
  done: z.boolean(),
  reasons: z.array(z.string().min(1).max(2000)).max(20),
  improvements: z.array(z.string().min(1).max(2000)).max(20),
});
export type RefinementJudgment = z.infer<typeof RefinementJudgment>;
