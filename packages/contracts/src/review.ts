import { z } from 'zod';
import { Identifier } from './ids.ts';

// Review artifact (contracts/review.schema.json, product contract §7.5). The runtime separately checks
// that target and criteria match what was actually reviewed.

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
  design: z
    .strictObject({
      reportVersionId: Identifier,
      tokenProposalVersionId: Identifier.optional(),
      preferences: z
        .array(
          z.discriminatedUnion('origin', [
            z.strictObject({
              origin: z.literal('ai_delegated'),
              appliedTo: z.array(z.string().min(1).max(200)).min(1).max(30),
            }),
            z.strictObject({
              origin: z.literal('user_answer'),
              requestId: Identifier,
              questionId: Identifier,
              appliedTo: z.array(z.string().min(1).max(200)).min(1).max(30),
            }),
          ]),
        )
        .max(30),
    })
    .optional(),
};

export const DesignReviewLink = common.design.unwrap();
export type DesignReviewLink = z.infer<typeof DesignReviewLink>;
export const DesignReviewEvidence = DesignReviewLink.omit({ preferences: true }).extend({
  preferenceSources: z
    .array(
      z.discriminatedUnion('origin', [
        z.strictObject({ origin: z.literal('ai_delegated') }),
        z.strictObject({
          origin: z.literal('user_answer'),
          requestId: Identifier,
          questionId: Identifier,
        }),
      ]),
    )
    .max(30),
  scope: z.enum(['targeted', 'release']),
  observations: z.literal('reported_only'),
  releaseReady: z.literal(false),
});

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
