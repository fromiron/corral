import { EFFORT_LEVELS, type EffortLevel } from '@corral/contracts';

// Calibrated on the effort-v2 validation split; see the reproducible policy comparison.
export const LOW_EFFORT_REVIEW_CEILING = 0.6;

/** Reference loss: a step costs one; hard-as-low is worse than unnecessary extra reasoning. */
export function effortExpectedCost(
  level: EffortLevel,
  probabilities: Readonly<Record<EffortLevel, number>>,
): number {
  const predicted = EFFORT_LEVELS.indexOf(level);
  return EFFORT_LEVELS.reduce(
    (cost, actual, index) =>
      cost +
      probabilities[actual] *
        (Math.abs(predicted - index) +
          (predicted === 0 && index >= 2 ? 3 : 0) +
          (index === 0 && predicted >= 2 ? 1 : 0)),
    0,
  );
}

/** Review only an uncertain low call; do not turn a likely high/xhigh into a median choice. */
export function lowEffortNeedsReview(
  answer: EffortLevel,
  probabilities: Readonly<Record<EffortLevel, number>>,
): boolean {
  return (
    answer === 'low' &&
    probabilities.low < LOW_EFFORT_REVIEW_CEILING &&
    effortExpectedCost('low', probabilities) > effortExpectedCost('medium', probabilities) + 1e-12
  );
}
