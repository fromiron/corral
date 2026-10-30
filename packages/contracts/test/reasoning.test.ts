import { describe, expect, it } from 'vitest';
import { DecisionAnswer, ReasoningResolution } from '../src/index.ts';

const base = {
  requested: { mode: 'auto' },
  resolved: 'high',
  source: 'local-model',
  preparationId: 'prep_1',
} as const;

describe('reasoning records', () => {
  it('records corral-effort-v1 judgments and still reads mixdog-relative-v1 runs', () => {
    expect(
      ReasoningResolution.safeParse({ ...base, policyVersion: 'corral-effort-v1' }).success,
    ).toBe(true);
    expect(
      ReasoningResolution.safeParse({ ...base, policyVersion: 'mixdog-relative-v1' }).success,
    ).toBe(true);
    expect(ReasoningResolution.safeParse({ ...base, policyVersion: 'other-v1' }).success).toBe(
      false,
    );
  });

  it('names an abstained judgment as its own fallback reason', () => {
    expect(
      ReasoningResolution.safeParse({
        ...base,
        resolved: 'medium',
        source: 'fallback',
        fallback: 'abstained',
      }).success,
    ).toBe(true);
  });

  it('lets a provider say it abstains, and nothing else beyond the answer', () => {
    const answer = {
      answer: 'high',
      probabilities: { low: 0.1, medium: 0.3, high: 0.35, xhigh: 0.25 },
      evidenceLevel: 'model_probability',
    };
    expect(DecisionAnswer.safeParse({ ...answer, abstain: true }).success).toBe(true);
    expect(DecisionAnswer.safeParse(answer).success).toBe(true);
    expect(DecisionAnswer.safeParse({ ...answer, abstain: 'yes' }).success).toBe(false);
    expect(DecisionAnswer.safeParse({ ...answer, note: 'x' }).success).toBe(false);
  });
});
