import { expect, it } from 'vitest';
import { adaptDesignReview } from '../src/design-review.ts';

it('targeted findings and preference provenance cannot become release evidence', () => {
  const report = {
    scope: {
      operation: 'review',
      verification: 'targeted',
      changed_surfaces: ['button'],
      rationale: 'Label only',
    },
    checks: [{ id: 'label', required: true, status: 'pass', evidence_state: 'observed' }],
    limitations: ['No browser run'],
  };
  const request = {
    reportVersionId: 'report_1',
    preferences: [{ origin: 'ai_delegated' as const, appliedTo: ['color'] }],
  };
  const adapt = (
    scope: 'targeted' | 'release',
    input: unknown = request,
    source: unknown = report,
  ) =>
    adaptDesignReview(input, {
      scope,
      verdict: 'pass',
      readArtifact: (id) => (id === 'report_1' ? JSON.stringify(source) : null),
      answered: () => false,
    });
  expect(adapt('targeted')).toMatchObject({
    problem: null,
    evidence: {
      scope: 'targeted',
      releaseReady: false,
      reportVersionId: 'report_1',
      observations: 'reported_only',
    },
  });
  expect(adapt('release').problem).toMatch(/targeted/);
  expect(adapt('targeted', { ...request, reportVersionId: 'missing' }).problem).toMatch(/report/);
  expect(
    adapt('targeted', {
      ...request,
      preferences: [
        { origin: 'user_answer', requestId: 'fake', questionId: 'q', appliedTo: ['color'] },
      ],
    }).problem,
  ).toMatch(/answer/);
  expect(
    adapt('targeted', request, { ...report, checks: [{ ...report.checks[0], status: 'unknown' }] })
      .problem,
  ).toMatch(/required/);
  const actual = adaptDesignReview(
    {
      ...request,
      tokenProposalVersionId: 'tokens',
      preferences: [
        {
          origin: 'user_answer',
          requestId: 'question',
          questionId: 'palette',
          appliedTo: ['private design preference'],
        },
      ],
    },
    {
      scope: 'targeted',
      verdict: 'pass',
      readArtifact: (id) => JSON.stringify(id === 'tokens' ? { approach: 'guided' } : report),
      answered: (requestId, questionId) => requestId === 'question' && questionId === 'palette',
    },
  );
  expect(actual.problem).toBeNull();
  expect(actual.evidence?.preferenceSources).toEqual([
    { origin: 'user_answer', requestId: 'question', questionId: 'palette' },
  ]);
  expect(JSON.stringify(actual.evidence)).not.toContain('private design preference');
});
