import { describe, expect, it } from 'vitest';
import { DecisionApiId, ModelRequestIntent, ReasoningResolution } from '../src/index.ts';

describe('reasoning records', () => {
  it('records an automatic request sent with the provider default while the effort mode is off', () => {
    const off = {
      requested: { mode: 'auto' },
      resolved: null,
      source: 'off',
      preparationId: 'prep_1',
    };
    expect(ReasoningResolution.parse(off)).toEqual(off);
    expect(
      ReasoningResolution.safeParse({
        ...off,
        resolved: 'medium',
        source: 'internal-policy',
      }).success,
    ).toBe(true);
  });

  it('no longer reads the removed judge records', () => {
    const base = { requested: { mode: 'auto' }, resolved: 'high', preparationId: 'prep_1' };
    for (const source of ['local-model', 'external-model', 'provider_default', 'compaction'])
      expect(ReasoningResolution.safeParse({ ...base, source }).success).toBe(false);
    expect(
      ReasoningResolution.safeParse({ ...base, source: 'off', policyVersion: 'corral-effort-v4' })
        .success,
    ).toBe(false);
  });
});

describe('decision APIs', () => {
  it('supports Jev and OpenAI Decisions only', () => {
    expect(DecisionApiId.options).toEqual(['jev', 'openai-decisions']);
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
