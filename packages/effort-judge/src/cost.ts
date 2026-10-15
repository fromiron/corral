// Level choice by expected cost under the judge's probabilities. Derived from mixdog
// `src/runtime/agent/orchestrator/providers/auto-effort.mjs` (Apache-2.0; see ../NOTICE.md).
// A miss costs one per level, plus extra for an opposite call (easy for a hard request is worse
// than hard for an easy one) and for calling a request very hard when it is not.

export const UNDER_OPPOSITE_COST = 3;
export const OVER_OPPOSITE_COST = 1;
export const FALSE_VERY_HARD_COST = 1;

function expectedCost(probs: readonly number[], level: number): number {
  let cost = 0;
  probs.forEach((p, actual) => {
    cost +=
      p *
      (Math.abs(level - actual) +
        (level === 0 && actual >= 2 ? UNDER_OPPOSITE_COST : 0) +
        (actual === 0 && level >= 2 ? OVER_OPPOSITE_COST : 0) +
        (level === 3 && actual < 3 ? FALSE_VERY_HARD_COST : 0));
  });
  return cost;
}

/** Index 0..3 (easy, normal, hard, very hard) with the lowest expected cost; ties go lower. */
export function chooseLevel(probs: readonly number[]): number {
  let level = 1;
  for (let candidate = 0; candidate < 4; candidate++) {
    if (expectedCost(probs, candidate) < expectedCost(probs, level) - 1e-12) level = candidate;
  }
  return level;
}
