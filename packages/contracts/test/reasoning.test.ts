import { describe, expect, it } from 'vitest';
import {
  DecisionAnswer,
  DecisionApiId,
  ModelRequestIntent,
  ReasoningApplySettings,
  ReasoningResolution,
} from '../src/index.ts';

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

describe('external judgment (decision APIs)', () => {
  it('records an escalated request and where its level came from', () => {
    const resolution = {
      requested: { mode: 'auto' },
      resolved: 'xhigh',
      source: 'external-model',
      preparationId: 'prep_1',
      judged: 'xhigh',
      judgeVersion: 'jev-2026-09-15',
      ladder: ['low', 'medium', 'high', 'xhigh'],
      policyVersion: 'corral-effort-v1',
      escalated: true,
    };
    expect(ReasoningResolution.parse(resolution)).toEqual(resolution);
    expect(ReasoningResolution.safeParse({ ...resolution, escalated: false }).success).toBe(false);
  });

  it('fixes the external judge at run start, and only a supported decision API', () => {
    const apply = {
      enabled: true,
      maxCalls: 4,
      provider: 'local-model',
      version: 'corral-local-ai-1+effort-v1',
      external: { provider: 'jev', model: 'jev-latest' },
    };
    expect(ReasoningApplySettings.parse(apply)).toEqual(apply);
    const openai = { ...apply, external: { provider: 'openai-decisions', model: 'gpt-6-luna' } };
    expect(ReasoningApplySettings.parse(openai)).toEqual(openai);
    expect(DecisionApiId.options).toEqual(['jev', 'openai-decisions']);
    expect(
      ReasoningApplySettings.safeParse({ ...apply, external: { provider: 'other', model: 'x' } })
        .success,
    ).toBe(false);
  });

  it('owns a judge request by its decision effect', () => {
    expect(
      ModelRequestIntent.parse({
        requestId: 'effect_1',
        purpose: 'reasoning_effort',
        revision: 1,
        owner: { kind: 'judge', id: 'effect_1', runId: 'run_1', executionId: 'exec_1' },
      }),
    ).toMatchObject({ purpose: 'reasoning_effort', owner: { kind: 'judge' } });
  });
});
