import { z } from 'zod';
import { Identifier } from './ids.ts';

// Review artifact (contracts/review.schema.json, Spec §7.5). The runtime separately checks
// that target and criteria match what was actually reviewed (CRL-ART-003).

export const ReviewIssue = z.strictObject({
  criterionId: Identifier,
  reason: z.string().min(1),
  severity: z.enum(['required', 'advisory']),
  evidenceRefs: z.array(Identifier).max(30),
});
export type ReviewIssue = z.infer<typeof ReviewIssue>;

const common = {
  targetArtifactVersionId: Identifier,
  criteriaVersionId: Identifier,
  evidenceRefs: z.array(Identifier).max(30),
};

/** A revise verdict must give at least one reason; malformed reviews are never a pass. */
export const ReviewArtifact = z.discriminatedUnion('verdict', [
  z.strictObject({
    ...common,
    verdict: z.literal('revise'),
    issues: z.array(ReviewIssue).min(1).max(20),
  }),
  z.strictObject({
    ...common,
    verdict: z.enum(['pass', 'inconclusive']),
    issues: z.array(ReviewIssue).max(20),
  }),
]);
export type ReviewArtifact = z.infer<typeof ReviewArtifact>;
