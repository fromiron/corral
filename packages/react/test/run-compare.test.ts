import { describe, expect, it } from 'vitest';
import { compareRuns } from '../src/run/compare.ts';
import { projectionWith } from '../src/stories/fixtures.tsx';

// Roadmap 16: two runs side by side, on the figures the eval report uses.

const run = (overrides: Parameters<typeof projectionWith>[0]) =>
  projectionWith({
    status: 'succeeded',
    mode: 'live',
    startedAt: '2026-10-16T00:00:00.000Z',
    endedAt: '2026-10-16T00:00:30.000Z',
    ...overrides,
  });

describe('compareRuns (roadmap 16)', () => {
  it('[TC-OBS-004-H] lines up status, time, calls, tokens, rounds and models, and marks what differs', () => {
    const a = run({
      runId: 'run_a',
      budget: { ...projectionWith({}).budget, spent: 1_200, modelCalls: 6 },
      modelProfiles: {
        'model-a': { profile: 'model-a', provider: 'openai', modelId: 'gpt-a', auth: 'api_key' },
      },
      iterations: {
        i1: {
          iterationId: 'i1',
          loopNodeId: 'l',
          no: 1,
          criteriaVersionId: 'c',
          outcome: 'revise',
        },
        i2: { iterationId: 'i2', loopNodeId: 'l', no: 2, criteriaVersionId: 'c', outcome: 'pass' },
      },
    });
    const b = run({
      runId: 'run_b',
      endedAt: '2026-10-16T00:01:15.000Z',
      budget: { ...projectionWith({}).budget, spent: 800, modelCalls: 6 },
      modelProfiles: {
        'model-a': { profile: 'model-a', provider: 'openai', modelId: 'gpt-b', auth: 'api_key' },
      },
    });
    const rows = Object.fromEntries(compareRuns(a, b).map((r) => [r.key, r]));
    expect(rows.elapsed).toMatchObject({ a: 30_000, b: 75_000, differs: true });
    expect(rows.modelCalls).toMatchObject({ a: 6, b: 6, differs: false });
    expect(rows.outputTokens).toMatchObject({ a: 1_200, b: 800, differs: true });
    expect(rows.reviewRounds).toMatchObject({ a: 2, b: 0, differs: true });
    expect(rows.models).toMatchObject({
      a: 'model-a: openai/gpt-a',
      b: 'model-a: openai/gpt-b',
      differs: true,
    });
  });

  it('[TC-OBS-004-N] an unfinished run has no elapsed time rather than a made-up one', () => {
    const a = run({ runId: 'run_a', status: 'running', endedAt: null });
    const b = run({ runId: 'run_b' });
    const elapsed = compareRuns(a, b).find((r) => r.key === 'elapsed');
    expect(elapsed).toMatchObject({ a: null, b: 30_000 });
  });
});
