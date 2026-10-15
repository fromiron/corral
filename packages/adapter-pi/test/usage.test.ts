import { describe, expect, it } from 'vitest';
import { normalizeUsage } from '../src/usage.ts';

// pi-ai normalizes each provider's usage; these fixtures are what it produces for two APIs.
// Corral reports total input (including cached), and never turns a missing count into 0.

const cost = { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0, total: 0.31 };

describe('usage normalization (C-020, OBS-004)', () => {
  it('[TC-OBS-004-H] OpenAI Responses: cached input is part of input, reasoning part of output', () => {
    // input_tokens 1200 (1000 cached), output_tokens 300 (120 reasoning), total 1500.
    const result = normalizeUsage({
      stopReason: 'stop',
      usage: {
        input: 200,
        output: 300,
        cacheRead: 1000,
        cacheWrite: 0,
        reasoning: 120,
        totalTokens: 1500,
        cost,
      },
    });
    expect(result.usage).toEqual({
      inputTokens: 1200,
      outputTokens: 300,
      cachedInputTokens: 1000,
      reasoningTokens: 120,
    });
  });

  it('Anthropic Messages: cache writes count as input; no reasoning breakdown stays unknown', () => {
    const result = normalizeUsage({
      stopReason: 'toolUse',
      usage: { input: 50, output: 400, cacheRead: 2000, cacheWrite: 300, totalTokens: 2750, cost },
    });
    expect(result.usage).toEqual({
      inputTokens: 2350,
      outputTokens: 400,
      cachedInputTokens: 2000,
      reasoningTokens: null,
    });
  });

  it('[TC-OBS-004-N] an aborted or failed request with no reported usage is unknown, not zero', () => {
    for (const stopReason of ['aborted', 'error'] as const) {
      const result = normalizeUsage({
        stopReason,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { ...cost, total: 0 },
        },
      });
      expect(result.usage).toEqual({
        inputTokens: null,
        outputTokens: null,
        cachedInputTokens: null,
        reasoningTokens: null,
      });
    }
  });

  it('keeps the provider counts raw but drops the price Pi computes from list prices', () => {
    const result = normalizeUsage({
      stopReason: 'stop',
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost },
    });
    expect(result.rawUsage).toEqual({
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
    });
    expect(JSON.stringify(result)).not.toContain('cost');
  });
});
