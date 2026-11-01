import assert from 'node:assert/strict';
import test from 'node:test';
import { lowEffortNeedsReview } from '../../../packages/core/src/reasoning-risk.ts';
import {
  applyEffortPolicy,
  compareDevelopmentPolicies,
  crossValidateMonotoneMap,
  type DevelopmentCase,
  enumerateMonotoneMaps,
  fitTrainingMap,
  pushProbabilities,
  refitSelectedAlgorithm,
} from './effort-policies.ts';

function example(id: string, group = id): DevelopmentCase {
  return {
    id,
    group,
    split: 'development',
    probabilities: [0, 0, 0, 1],
    trials: (['low', 'medium', 'high', 'xhigh'] as const).flatMap((level, index) =>
      ([0, 1] as const).map((repeat) => ({
        level,
        repeat,
        completed: true,
        passed: true,
        totalTokens: 10 * (index + 1),
      })),
    ),
  };
}

test('pushforward conserves mass and mapped decision does not re-argmax merged bins', () => {
  const p = [0.2, 0.25, 0.35, 0.2];
  const pushed = pushProbabilities(p, [0, 0, 1, 2]);
  assert.deepEqual(pushed, { low: 0.45, medium: 0.35, high: 0.2, xhigh: 0 });
  assert.equal(
    Object.values(pushed).reduce((a, b) => a + b, 0),
    1,
  );
  const result = applyEffortPolicy(p, { kind: 'relative-base-low' });
  assert.equal(result.rawDifficulty, 'high');
  assert.equal(result.selectedLevel, 'medium');
  assert.equal(result.appliedLevel, 'medium');
});

test('all mapped policies use the actual core low review guard', () => {
  for (const p of [
    [0.4, 0.3, 0.2, 0.1],
    [0.7, 0.1, 0.1, 0.1],
    [0.6, 0.2, 0.1, 0.1],
  ]) {
    for (const policy of [{ kind: 'identity' }, { kind: 'relative-base-low' }] as const) {
      const result = applyEffortPolicy(p, policy);
      const review = lowEffortNeedsReview(result.selectedLevel, result.mappedProbabilities);
      assert.equal(result.abstention, review);
      assert.equal(result.appliedLevel, review ? 'medium' : result.selectedLevel);
    }
  }
  assert.equal(
    applyEffortPolicy([0, 0, 0, 1], { kind: 'constant', level: 'low' }).appliedLevel,
    'low',
  );
});

test('asymmetric reference tie order and relative combination are explicit', () => {
  const tie = applyEffortPolicy([0.75, 0.25, 0, 0], { kind: 'asymmetric' });
  assert.equal(tie.selectedDifficulty, 'medium');
  const combination = applyEffortPolicy([0.75, 0.25, 0, 0], { kind: 'asymmetric-relative-low' });
  assert.equal(combination.selectedDifficulty, 'medium');
  assert.equal(combination.selectedLevel, 'low');
  assert.equal(combination.mappedProbabilities.low, 1);
});

test('exactly sixteen maps obey fixed monotone endpoints', () => {
  const maps = enumerateMonotoneMaps();
  assert.equal(maps.length, 16);
  assert.equal(new Set(maps.map((map) => map.join())).size, 16);
  for (const map of maps) {
    assert.equal(map[0], 0);
    assert.ok(map[3] >= 2);
    assert.ok(map.every((value, i) => i === 0 || value >= (map[i - 1] ?? 0)));
  }
  assert.throws(() => applyEffortPolicy([1, 0, 0, 0], { kind: 'monotone', map: [0, 3, 1, 2] }));
});

test('fit chooses cheapest map that preserves observed training success', () => {
  const item = example('a');
  item.probabilities = [0.1, 0.8, 0.1, 0];
  for (const trial of item.trials) if (trial.level === 'low') trial.passed = false;
  const data = [item];
  const fitted = fitTrainingMap(data);
  assert.deepEqual(fitted.selectedMap, [0, 1, 1, 2]);
  assert.equal(fitted.metrics.meanTotalTokens, 20);
  assert.equal(fitted.metrics.successRate, 1);
});

test('OOF keeps every original group disjoint and never drops no-feasible folds', () => {
  const data = Array.from({ length: 10 }, (_, i) =>
    example(`case-${i}`, `group-${Math.floor(i / 2)}`),
  );
  for (const item of data) {
    item.probabilities = [1, 0, 0, 0];
    for (const trial of item.trials) if (trial.level === 'low') trial.passed = false;
  }
  const report = crossValidateMonotoneMap(data);
  assert.equal(report.predictions.length, data.length);
  assert.equal(new Set(report.predictions.map((item) => item.id)).size, data.length);
  assert.equal(report.noFeasibleFolds, 5);
  for (const fold of report.folds) {
    assert.ok(fold.heldoutGroups.every((group) => !fold.fit.trainGroups.includes(group)));
    assert.equal(fold.fit.selectedMap, null);
  }
  assert.ok(report.predictions.every((item) => item.appliedLevel === 'high'));
});

test('missing, duplicate, unsettled and zero-usage outcomes cannot fit', () => {
  const missing = example('a');
  missing.trials.pop();
  const duplicate = example('a');
  const first = duplicate.trials[0];
  assert.ok(first);
  duplicate.trials[1] = { ...first };
  const unsettled = example('a');
  const unsettledTrial = unsettled.trials[0];
  assert.ok(unsettledTrial);
  unsettledTrial.completed = false;
  const zero = example('a');
  const zeroTrial = zero.trials[0];
  assert.ok(zeroTrial);
  zeroTrial.totalTokens = 0;
  for (const item of [missing, duplicate, unsettled, zero])
    assert.throws(() => fitTrainingMap([item]));
});

test('non-development data is rejected by every fitting/evaluation entry point', () => {
  for (const split of ['fit', 'calibration', 'policy', 'final']) {
    const item = { ...example('a'), split } as DevelopmentCase;
    for (const run of [
      fitTrainingMap,
      crossValidateMonotoneMap,
      compareDevelopmentPolicies,
      refitSelectedAlgorithm,
    ]) {
      assert.throws(() => run([item]));
    }
  }
  assert.throws(() => fitTrainingMap([{ ...example('a'), final: true }]));
});

test('constant low domination and exact ties are reported separately', () => {
  const data = Array.from({ length: 5 }, (_, i) => example(`case-${i}`));
  const report = compareDevelopmentPolicies(data);
  const identity = report.comparisons.find((entry) => entry.name === 'identity');
  const low = report.comparisons.find((entry) => entry.name === 'constant-low');
  assert.equal(identity?.constantLowComparison, 'dominated');
  assert.equal(low?.constantLowComparison, 'equivalent');
  assert.equal(report.learnedOOF.constantLowComparison, 'dominated');
  assert.equal(report.fullDevelopmentRefit, null);
});

test('many variants cannot hide a failure on another original family', () => {
  const fragile = example('fragile', 'family-a');
  fragile.probabilities = [0, 1, 0, 0];
  for (const trial of fragile.trials) if (trial.level === 'low') trial.passed = false;
  const variants = Array.from({ length: 100 }, (_, index) => ({
    ...example(`variant-${index}`, 'family-b'),
    probabilities: [0, 1, 0, 0],
  }));
  const fit = fitTrainingMap([fragile, ...variants]);
  assert.equal(fit.metrics.groups, 2);
  assert.equal(fit.selectedMap?.[1], 1);
});

test('malformed probabilities and unknown serialized policies are rejected', () => {
  const sparse = new Array<number>(4);
  sparse[0] = 1;
  for (const p of [sparse, [0.5, 0, 0, 0], [NaN, 0, 0, 1], [-0.1, 0.1, 0, 1]])
    assert.throws(() => applyEffortPolicy(p, { kind: 'identity' }));
  assert.throws(() => applyEffortPolicy([1, 0, 0, 0], { kind: 'typo' } as never));
});
