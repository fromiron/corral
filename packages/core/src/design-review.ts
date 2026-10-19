import { DesignReviewLink } from '@corral/contracts';
import { z } from 'zod';

// Adapt only scope, required findings and provenance. Full upstream schema validation and
// browser verification remain separate evidence; accepting this shape proves neither.
const Report = z.object({
  scope: z
    .object({
      verification: z.enum(['targeted', 'release']),
      changed_surfaces: z.array(z.string().min(1)).max(100).optional(),
      rationale: z.string().min(1).optional(),
    })
    .optional(),
  checks: z
    .array(
      z.object({
        id: z.string().min(1).max(120),
        required: z.boolean(),
        status: z.enum(['pass', 'fail', 'unknown', 'not-applicable', 'out-of-scope']),
        evidence_state: z.enum(['observed', 'measured', 'inferred', 'unknown']),
      }),
    )
    .min(1)
    .max(500),
});

export function adaptDesignReview(
  raw: unknown,
  context: {
    scope: 'targeted' | 'release';
    verdict: 'pass' | 'revise' | 'inconclusive';
    readArtifact(id: string): string | null;
    answered(requestId: string, questionId: string): boolean;
  },
) {
  const link = DesignReviewLink.safeParse(raw);
  const refuse = (problem: string) => ({ problem, evidence: null });
  if (!link.success) return refuse('invalid design report references');
  try {
    const text = context.readArtifact(link.data.reportVersionId);
    const report = Report.safeParse(text === null ? null : JSON.parse(text));
    if (!report.success) return refuse('design report is missing or its scope/checks are invalid');
    const scope = report.data.scope?.verification ?? 'release';
    if (
      scope === 'targeted' &&
      (!report.data.scope?.changed_surfaces?.length || !report.data.scope.rationale)
    )
      return refuse('targeted report requires changed surfaces and rationale');
    if (context.verdict === 'pass') {
      if (scope === 'targeted' && context.scope === 'release')
        return refuse('targeted verification cannot pass a release review');
      if (
        !report.data.checks.some((check) => check.status !== 'out-of-scope') ||
        report.data.checks.some(
          (check) =>
            check.required &&
            ((check.status !== 'pass' && check.status !== 'not-applicable') ||
              check.evidence_state === 'unknown'),
        )
      )
        return refuse('required design checks have not passed');
    }
    if (
      link.data.preferences.some(
        (preference) =>
          preference.origin === 'user_answer' &&
          !context.answered(preference.requestId, preference.questionId),
      )
    )
      return refuse('claimed preference has no recorded user answer');
    if (link.data.tokenProposalVersionId) {
      const text = context.readArtifact(link.data.tokenProposalVersionId);
      const proposal = text === null ? null : JSON.parse(text);
      if (!proposal || !['auto', 'guided', undefined].includes(proposal.approach))
        return refuse('invalid token proposal');
      if (
        proposal.approach === 'guided' &&
        !link.data.preferences.some((preference) => preference.origin === 'user_answer')
      )
        return refuse('guided token proposal requires recorded user answers');
    }
    const { preferences, ...references } = link.data;
    const preferenceSources = preferences.map((preference) =>
      preference.origin === 'user_answer'
        ? {
            origin: preference.origin,
            requestId: preference.requestId,
            questionId: preference.questionId,
          }
        : { origin: preference.origin },
    );
    return {
      problem: null,
      evidence: {
        ...references,
        preferenceSources,
        scope,
        observations: 'reported_only' as const,
        releaseReady: false as const,
      },
    };
  } catch {
    return refuse('invalid design report or token proposal JSON');
  }
}
