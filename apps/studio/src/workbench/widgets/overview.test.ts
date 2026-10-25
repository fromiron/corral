import { emptyProjection, type RunProjection } from '@corral/core';
import { describe, expect, it } from 'vitest';
import { overviewWidgets, sessionStats, usageSummary } from './selectors.ts';

const limits = { maxOutputTokens: 64_000, maxModelCalls: 40 };

function call(
  id: string,
  outputTokens: number | null,
  finished = true,
  input: { inputTokens: number | null; cachedInputTokens: number | null } = {
    inputTokens: 100,
    cachedInputTokens: null,
  },
) {
  return {
    modelCallId: id,
    executionId: 'exec',
    contextSnapshotId: 'ctx',
    profile: 'model-a',
    configRevision: 0,
    directiveIds: [],
    inputArtifactVersionIds: [],
    finished,
    usage: {
      ...input,
      outputTokens,
      reasoningTokens: null,
    },
    rawUsage: null,
    certainty: 'reported' as const,
  };
}

function run(): RunProjection {
  const projection = emptyProjection('run_overview');
  projection.status = 'succeeded';
  projection.budget.spent = 930;
  projection.budget.reserved = 0;
  projection.budget.modelCalls = 4;
  projection.modelCalls = {
    a: call('a', 194),
    b: call('b', 63),
    c: call('c', null),
    d: call('d', 500, false),
  };
  return projection;
}

describe('overview usage widget (CR-053)', () => {
  it('[TC-RAIL-001-H] states output tokens and calls against their limits with a per-call chart', () => {
    expect(usageSummary(run(), limits)).toEqual({
      spent: 930,
      reserved: 0,
      unknown: 0,
      tokenLimit: 64_000,
      calls: 4,
      callLimit: 40,
      // Finished calls with reported output, oldest first; a call still streaming is not a bar.
      perCall: [194, 63],
      // CR-054: input of the finished calls; none of them reported cached input.
      input: { tokens: 300, cached: null, cacheShare: null, cacheUnreported: 3 },
    });
  });

  it('[TC-LLM-007-N] totals reported cached input and names calls that did not report it', () => {
    const projection = run();
    projection.modelCalls = {
      a: call('a', 10, true, { inputTokens: 2_000, cachedInputTokens: 1_500 }),
      b: call('b', 10, true, { inputTokens: 1_000, cachedInputTokens: 0 }),
      c: call('c', 10, true, { inputTokens: 500, cachedInputTokens: null }),
      d: call('d', 10, true, { inputTokens: null, cachedInputTokens: null }),
      e: call('e', null, false, { inputTokens: 9_000, cachedInputTokens: 9_000 }),
    };
    // The share counts only calls that reported both figures; an unreported cache is not zero.
    expect(usageSummary(projection, limits)?.input).toEqual({
      tokens: 3_500,
      cached: 1_500,
      cacheShare: 0.5,
      cacheUnreported: 2,
    });
    projection.modelCalls = { d: call('d', 10, true, { inputTokens: null, cachedInputTokens: 5 }) };
    expect(usageSummary(projection, limits)?.input).toBeNull();
  });

  it('[TC-RAIL-001-N] names unconfirmed usage and a run without limits, never as zero', () => {
    const projection = run();
    projection.budget.unknownOutstanding = 256;
    projection.usageLimits = 'none';
    expect(usageSummary(projection, limits)).toMatchObject({
      unknown: 256,
      tokenLimit: null,
      callLimit: null,
    });
    const empty = emptyProjection('run_empty');
    expect(usageSummary(empty, limits)).toBeNull();
  });

  it('[TC-RAIL-001-N] keeps the per-call chart to the latest twelve calls', () => {
    const projection = run();
    projection.modelCalls = Object.fromEntries(
      Array.from({ length: 15 }, (_, index) => [`c${index}`, call(`c${index}`, index + 1)]),
    );
    expect(usageSummary(projection, limits)?.perCall).toEqual([
      4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    ]);
  });
});

describe('overview widget order (CR-053)', () => {
  const base = {
    chips: [] as ('context' | 'agents' | 'changes' | 'environment')[],
    usage: null as ReturnType<typeof usageSummary>,
    results: [] as { id: string; label: string }[],
  };

  it('[TC-RAIL-001-H] stacks context, usage, results, changes, agents and environment in order', () => {
    expect(
      overviewWidgets({
        chips: ['environment', 'changes', 'agents', 'context'],
        usage: usageSummary(run(), limits),
        results: [{ id: 'r', label: 'draft v1' }],
      }),
    ).toEqual(['context', 'usage', 'results', 'changes', 'agents', 'environment']);
  });

  it('[TC-RAIL-001-N] hides a widget with nothing to say', () => {
    expect(overviewWidgets(base)).toEqual([]);
    const idle = emptyProjection('run_idle');
    expect(overviewWidgets({ ...base, usage: usageSummary(idle, limits) })).toEqual([]);
    expect(overviewWidgets({ ...base, results: [{ id: 'r', label: 'draft v1' }] })).toEqual([
      'results',
    ]);
  });
});

describe('session statistics (CR-055)', () => {
  it('[TC-TURN-001-N] totals turns, steps and tokens, and names calls without a cache report', () => {
    const one = run();
    one.modelCalls = {
      a: call('a', 10, true, { inputTokens: 1_000, cachedInputTokens: 900 }),
      b: call('b', 20, true, { inputTokens: 1_000, cachedInputTokens: null }),
    };
    const two = run();
    two.modelCalls = { c: call('c', 30, true, { inputTokens: 1_000, cachedInputTokens: 100 }) };
    expect(sessionStats([one, two], () => 2)).toEqual({
      turns: 2,
      steps: 4,
      tokens: 3_060,
      cacheShare: 0.5,
      cacheUnreported: 1,
    });
    expect(sessionStats([], () => 0)).toBeNull();
  });
});
