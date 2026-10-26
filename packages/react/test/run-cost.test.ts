import { describe, expect, it } from 'vitest';
import { estimateRunCost, type ModelPrices } from '../src/run/cost.ts';
import { projectionWith } from '../src/stories/fixtures.tsx';

// Roadmap 15: an estimate at list prices for API-key runs; subscriptions and unknowns say so.

const call = (
  modelCallId: string,
  profile: string,
  raw: Record<string, number> | null,
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    cachedInputTokens: number | null;
  } | null = null,
) => ({
  modelCallId,
  executionId: 'e',
  contextSnapshotId: 'x',
  profile,
  configRevision: 0,
  directiveIds: [],
  inputArtifactVersionIds: [],
  finished: true,
  usage: usage ? { ...usage, reasoningTokens: null } : null,
  rawUsage: raw,
  certainty: raw || usage ? ('reported' as const) : ('unknown' as const),
});

const prices: ModelPrices = (provider, modelId) =>
  provider === 'openai' && modelId === 'gpt-a'
    ? { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2.5 }
    : null;

const snapshot = (profile: string, auth: 'oauth' | 'api_key' | 'mock', modelId = 'gpt-a') => ({
  profile,
  provider: auth === 'mock' ? null : 'openai',
  modelId: auth === 'mock' ? null : modelId,
  auth,
});

describe('estimateRunCost', () => {
  it('prices each API-key call from its own token counts, cache reads at their rate', () => {
    const p = projectionWith({
      modelProfiles: { a: snapshot('a', 'api_key') },
      modelCalls: {
        c1: call('c1', 'a', {
          input: 1_000_000,
          output: 100_000,
          cacheRead: 200_000,
          cacheWrite: 0,
        }),
        // Without raw counts: cached input is a subset of input.
        c2: call('c2', 'a', null, {
          inputTokens: 500_000,
          outputTokens: 0,
          cachedInputTokens: 100_000,
        }),
      },
    });
    const estimate = estimateRunCost(p, prices);
    // c1: 2 + 0.8 + 0.1 = 2.9; c2: 0.4 × 2 + 0.1 × 0.5 = 0.85
    expect(estimate.usd).toBeCloseTo(3.75, 6);
    expect(estimate).toMatchObject({ pricedCalls: 2, unknownCalls: 0, subscriptionCalls: 0 });
  });

  it('subscription, simulated, unpriced and unreported calls are never priced as zero', () => {
    const p = projectionWith({
      modelProfiles: {
        sub: snapshot('sub', 'oauth'),
        mock: snapshot('mock', 'mock'),
        other: snapshot('other', 'api_key', 'unlisted'),
        a: snapshot('a', 'api_key'),
      },
      modelCalls: {
        s: call('s', 'sub', { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 }),
        m: call('m', 'mock', null),
        o: call('o', 'other', { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 }),
        u: call('u', 'a', null),
      },
    });
    const estimate = estimateRunCost(p, prices);
    expect(estimate).toEqual({
      usd: 0,
      pricedCalls: 0,
      unknownCalls: 2,
      subscriptionCalls: 1,
      simulated: true,
    });
  });
});

it('an unknown Pi zero placeholder remains unpriced', () => {
  const placeholder = call('u', 'a', { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  const p = projectionWith({
    modelProfiles: { a: snapshot('a', 'api_key') },
    modelCalls: { u: { ...placeholder, certainty: 'unknown' } },
  });
  expect(estimateRunCost(p, prices)).toMatchObject({ pricedCalls: 0, unknownCalls: 1 });
});
