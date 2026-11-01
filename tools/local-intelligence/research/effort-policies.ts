// Pure development-only policy comparison: no filesystem, model calls, or activation.
// Difficulty weights/probabilities stay unchanged. The learned table is a model-specific
// empirical success/cost policy, not a calibrated estimate of P(worker success).
import { createHash } from 'node:crypto';
import { EFFORT_LEVELS, type EffortLevel } from '../../../packages/contracts/src/index.ts';
import { lowEffortNeedsReview } from '../../../packages/core/src/reasoning-risk.ts';

export const MAP_ALGORITHM_VERSION = 'effort-development-monotone-v1';
export type Probabilities = Readonly<Record<EffortLevel, number>>;
export type ProbabilityInput = readonly number[] | Probabilities;
export type DifficultyMap = readonly [number, number, number, number];
export type EffortPolicy =
  | { kind: 'identity' | 'asymmetric' | 'relative-base-low' | 'asymmetric-relative-low' }
  | { kind: 'monotone'; map: readonly number[] }
  | { kind: 'constant'; level: 'low' | 'medium' | 'high' };

export interface AppliedDecision {
  rawDifficulty: EffortLevel;
  selectedDifficulty: EffortLevel;
  selectedLevel: EffortLevel;
  appliedLevel: EffortLevel;
  mappedProbabilities: Record<EffortLevel, number>;
  abstention: boolean;
}

export interface CompletedTrial {
  level: EffortLevel;
  repeat: 0 | 1;
  completed: boolean;
  passed: boolean;
  /** Provider-reported total; do not add reasoning/cache tokens a second time. */
  totalTokens: number;
}

export interface DevelopmentCase {
  id: string;
  group: string;
  split: 'development';
  final?: boolean;
  probabilities: ProbabilityInput;
  trials: CompletedTrial[];
}

interface PolicyMetrics {
  cases: number;
  groups: number;
  trials: number;
  successes: number;
  totalTokens: number;
  /** Equal original-group means; variants cannot multiply a family's influence. */
  successRate: number;
  meanTotalTokens: number;
  abstentions: number;
}

export interface CaseDecision extends AppliedDecision {
  id: string;
  group: string;
}

export interface MapFit {
  algorithm: string;
  selectedMap: DifficultyMap | null;
  selectedPolicy: EffortPolicy;
  reason: 'minimum-feasible-cost' | 'no-feasible-map-constant-high';
  trainGroups: string[];
  trainCaseIds: string[];
  highReference: PolicyMetrics;
  metrics: PolicyMetrics;
  candidates: { map: DifficultyMap; feasible: boolean; metrics: PolicyMetrics }[];
}

const BASE_LOW: DifficultyMap = [0, 0, 1, 2];
const IDENTITY: DifficultyMap = [0, 1, 2, 3];
const TIE_ORDER: readonly EffortLevel[] = ['medium', 'low', 'high', 'xhigh'];
const EPSILON = 1e-12;

function levelAt(index: number): EffortLevel {
  const level = EFFORT_LEVELS[index];
  if (!level) throw new Error('invalid effort index');
  return level;
}

function probabilityRecord(input: ProbabilityInput): Record<EffortLevel, number> {
  const vector = EFFORT_LEVELS.map((level, index) =>
    Array.isArray(input) ? input[index] : (input as Probabilities)[level],
  );
  if (
    (Array.isArray(input) ? input.length !== 4 : Object.keys(input).length !== 4) ||
    vector.some(
      (value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1,
    ) ||
    Math.abs(vector.reduce((sum, value) => sum + value, 0) - 1) > 1e-6
  )
    throw new Error('four finite calibrated difficulty probabilities summing to one required');
  const [low, medium, high, xhigh] = vector as [number, number, number, number];
  return { low, medium, high, xhigh };
}

function checkedMap(map: readonly number[], constrained: boolean): DifficultyMap {
  if (
    map.length !== 4 ||
    Array.from(map).some((value) => !Number.isInteger(value) || value < 0 || value > 3)
  )
    throw new Error('map requires four effort indices');
  const result = [...map] as [number, number, number, number];
  if (
    constrained &&
    (result[0] !== 0 ||
      result[3] < 2 ||
      result.some((value, i) => i > 0 && value < (result[i - 1] ?? 0)))
  )
    throw new Error('learned map must be monotone with low fixed and top at least high');
  return result;
}

export function pushProbabilities(
  input: ProbabilityInput,
  mapping: readonly number[],
): Record<EffortLevel, number> {
  const probabilities = probabilityRecord(input);
  const map = checkedMap(mapping, false);
  const pushed = { low: 0, medium: 0, high: 0, xhigh: 0 };
  for (const [index, label] of EFFORT_LEVELS.entries())
    pushed[levelAt(map[index] ?? -1)] += probabilities[label];
  return pushed;
}

function argmax(probabilities: Probabilities): EffortLevel {
  return EFFORT_LEVELS.reduce(
    (best, level) => (probabilities[level] > probabilities[best] ? level : best),
    'low',
  );
}

function asymmetric(probabilities: Probabilities): EffortLevel {
  const costs = EFFORT_LEVELS.map((_, chosen) =>
    EFFORT_LEVELS.reduce(
      (sum, level, actual) =>
        sum + probabilities[level] * Math.abs(chosen - actual) * (chosen < actual ? 3 : 1),
      0,
    ),
  );
  const minimum = Math.min(...costs);
  return (
    TIE_ORDER.find(
      (level) => (costs[EFFORT_LEVELS.indexOf(level)] ?? Infinity) <= minimum + EPSILON,
    ) ?? 'medium'
  );
}

/** Maps the selected difficulty bin; it never re-argmaxes merged probability bins. */
export function applyEffortPolicy(input: ProbabilityInput, policy: EffortPolicy): AppliedDecision {
  if (
    ![
      'identity',
      'asymmetric',
      'relative-base-low',
      'asymmetric-relative-low',
      'monotone',
      'constant',
    ].includes(policy.kind)
  )
    throw new Error('unknown effort policy');
  const probabilities = probabilityRecord(input);
  const rawDifficulty = argmax(probabilities);
  const selectedDifficulty =
    policy.kind === 'asymmetric' || policy.kind === 'asymmetric-relative-low'
      ? asymmetric(probabilities)
      : rawDifficulty;
  let selectedLevel: EffortLevel;
  let mappedProbabilities: Record<EffortLevel, number>;
  if (policy.kind === 'constant') {
    if (!['low', 'medium', 'high'].includes(policy.level))
      throw new Error('unsupported constant comparator');
    selectedLevel = policy.level;
    mappedProbabilities = { low: 0, medium: 0, high: 0, xhigh: 0 };
    mappedProbabilities[selectedLevel] = 1;
  } else {
    const map =
      policy.kind === 'monotone'
        ? checkedMap(policy.map, true)
        : policy.kind === 'relative-base-low' || policy.kind === 'asymmetric-relative-low'
          ? BASE_LOW
          : IDENTITY;
    selectedLevel = levelAt(map[EFFORT_LEVELS.indexOf(selectedDifficulty)] ?? -1);
    mappedProbabilities = pushProbabilities(probabilities, map);
  }
  const abstention = lowEffortNeedsReview(selectedLevel, mappedProbabilities);
  return {
    rawDifficulty,
    selectedDifficulty,
    selectedLevel,
    mappedProbabilities,
    appliedLevel: abstention ? 'medium' : selectedLevel,
    abstention,
  };
}

export function enumerateMonotoneMaps(): DifficultyMap[] {
  const maps: DifficultyMap[] = [];
  for (let second = 0; second <= 3; second++)
    for (let third = second; third <= 3; third++)
      for (let fourth = Math.max(2, third); fourth <= 3; fourth++)
        maps.push([0, second, third, fourth]);
  return maps;
}

function validateDevelopment(cases: readonly DevelopmentCase[]): void {
  if (!cases.length) throw new Error('development cases are required');
  const ids = new Set<string>();
  for (const item of cases) {
    if (
      item.split !== 'development' ||
      item.final === true ||
      typeof item.id !== 'string' ||
      !item.id.trim() ||
      ids.has(item.id) ||
      typeof item.group !== 'string' ||
      !item.group.trim()
    )
      throw new Error('only unique explicitly development cases may fit or compare policies');
    ids.add(item.id);
    probabilityRecord(item.probabilities);
    if (!Array.isArray(item.trials) || item.trials.length !== 8)
      throw new Error('exactly two completed repeats at each of four levels required');
    const keys = new Set<string>();
    for (const trial of item.trials) {
      const key = `${trial.level}:${trial.repeat}`;
      if (
        !EFFORT_LEVELS.includes(trial.level) ||
        ![0, 1].includes(trial.repeat) ||
        keys.has(key) ||
        trial.completed !== true ||
        typeof trial.passed !== 'boolean' ||
        !Number.isSafeInteger(trial.totalTokens) ||
        trial.totalTokens <= 0
      )
        throw new Error('missing, duplicate, unsettled or invalid worker outcome/usage');
      keys.add(key);
    }
  }
}

function predictionsFor(cases: readonly DevelopmentCase[], policy: EffortPolicy): CaseDecision[] {
  return cases.map((item) => ({
    id: item.id,
    group: item.group,
    ...applyEffortPolicy(item.probabilities, policy),
  }));
}

function summarize(
  cases: readonly DevelopmentCase[],
  predictions: readonly CaseDecision[],
): PolicyMetrics {
  const lookup = new Map(predictions.map((item) => [item.id, item]));
  if (lookup.size !== cases.length || predictions.length !== cases.length)
    throw new Error('missing or duplicate policy predictions');
  const groups = new Map<string, { successes: number; tokens: number; trials: number }>();
  let successes = 0;
  let totalTokens = 0;
  let abstentions = 0;
  for (const item of cases) {
    const decision = lookup.get(item.id);
    if (!decision || decision.group !== item.group) throw new Error('prediction group mismatch');
    const selected = item.trials.filter((trial) => trial.level === decision.appliedLevel);
    if (selected.length !== 2) throw new Error('selected effort has missing paired outcomes');
    const pairSuccesses = selected.reduce((sum, trial) => sum + Number(trial.passed), 0);
    const pairTokens = selected.reduce((sum, trial) => sum + trial.totalTokens, 0);
    const group = groups.get(item.group) ?? { successes: 0, tokens: 0, trials: 0 };
    group.successes += pairSuccesses;
    group.tokens += pairTokens;
    group.trials += 2;
    groups.set(item.group, group);
    successes += pairSuccesses;
    totalTokens += pairTokens;
    abstentions += Number(decision.abstention);
  }
  const means = [...groups.values()];
  return {
    cases: cases.length,
    groups: groups.size,
    trials: cases.length * 2,
    successes,
    totalTokens,
    abstentions,
    successRate:
      means.reduce((sum, group) => sum + group.successes / group.trials, 0) / groups.size,
    meanTotalTokens:
      means.reduce((sum, group) => sum + group.tokens / group.trials, 0) / groups.size,
  };
}

export function evaluateDevelopmentPolicy(cases: readonly DevelopmentCase[], policy: EffortPolicy) {
  validateDevelopment(cases);
  const predictions = predictionsFor(cases, policy);
  return { predictions, metrics: summarize(cases, predictions) };
}

/** Fixed algorithm: 16 maps, empirical high−.02 constraint, minimum group-weighted cost.
 * Ties prefer higher success, then lexicographically smaller map. No final/C/P data.
 */
export function fitTrainingMap(cases: readonly DevelopmentCase[]): MapFit {
  validateDevelopment(cases);
  const highReference = evaluateDevelopmentPolicy(cases, {
    kind: 'constant',
    level: 'high',
  }).metrics;
  const candidates = enumerateMonotoneMaps().map((map) => {
    const metrics = evaluateDevelopmentPolicy(cases, { kind: 'monotone', map }).metrics;
    return {
      map,
      metrics,
      feasible: metrics.successRate + EPSILON >= highReference.successRate - 0.02,
    };
  });
  const feasible = candidates
    .filter((candidate) => candidate.feasible)
    .sort((a, b) => {
      const cost = a.metrics.meanTotalTokens - b.metrics.meanTotalTokens;
      if (Math.abs(cost) > EPSILON) return cost;
      const success = b.metrics.successRate - a.metrics.successRate;
      if (Math.abs(success) > EPSILON) return success;
      return a.map.join().localeCompare(b.map.join());
    });
  const selected = feasible[0];
  return {
    algorithm: MAP_ALGORITHM_VERSION,
    selectedMap: selected?.map ?? null,
    selectedPolicy: selected
      ? { kind: 'monotone', map: selected.map }
      : { kind: 'constant', level: 'high' },
    reason: selected ? 'minimum-feasible-cost' : 'no-feasible-map-constant-high',
    trainGroups: [...new Set(cases.map((item) => item.group))].sort(),
    trainCaseIds: cases.map((item) => item.id).sort(),
    highReference,
    metrics: selected?.metrics ?? highReference,
    candidates,
  };
}

function lowComparison(
  candidate: PolicyMetrics,
  low: PolicyMetrics,
): 'dominated' | 'equivalent' | 'not-dominated' {
  const successDifference = low.successRate - candidate.successRate;
  const costDifference = candidate.meanTotalTokens - low.meanTotalTokens;
  if (Math.abs(successDifference) <= EPSILON && Math.abs(costDifference) <= EPSILON)
    return 'equivalent';
  return successDifference >= -EPSILON && costDifference >= -EPSILON
    ? 'dominated'
    : 'not-dominated';
}

/** Five deterministic group folds; assignment uses only group IDs, never outcomes.
 * Balanced hash-sorted round robin avoids empty folds in small development corpora.
 */
export function crossValidateMonotoneMap(cases: readonly DevelopmentCase[]) {
  validateDevelopment(cases);
  const hash = (group: string) =>
    createHash('sha256').update(`${MAP_ALGORITHM_VERSION}:${group}`).digest('hex');
  const groups = [...new Set(cases.map((item) => item.group))].sort((a, b) =>
    hash(a).localeCompare(hash(b)),
  );
  if (groups.length < 5)
    throw new Error('five-fold OOF requires at least five independent development groups');
  const assignment = new Map(groups.map((group, index) => [group, index % 5]));
  const predictions: (CaseDecision & { fold: number })[] = [];
  const folds: { fold: number; heldoutGroups: string[]; fit: MapFit }[] = [];
  for (let fold = 0; fold < 5; fold++) {
    const train = cases.filter((item) => assignment.get(item.group) !== fold);
    const heldout = cases.filter((item) => assignment.get(item.group) === fold);
    const fit = fitTrainingMap(train);
    predictions.push(
      ...predictionsFor(heldout, fit.selectedPolicy).map((decision) => ({ ...decision, fold })),
    );
    folds.push({
      fold,
      heldoutGroups: [...new Set(heldout.map((item) => item.group))].sort(),
      fit,
    });
  }
  const metrics = summarize(cases, predictions);
  const constantLow = evaluateDevelopmentPolicy(cases, { kind: 'constant', level: 'low' }).metrics;
  return {
    algorithm: MAP_ALGORITHM_VERSION,
    folds,
    predictions,
    metrics,
    noFeasibleFolds: folds.filter((fold) => fold.fit.selectedMap === null).length,
    constantLowComparison: lowComparison(metrics, constantLow),
  };
}

/** Call separately only AFTER selecting this fixed algorithm from development OOF.
 * Comparison below deliberately never performs this full-development refit.
 */
export function refitSelectedAlgorithm(cases: readonly DevelopmentCase[]): MapFit {
  return fitTrainingMap(cases);
}

export function compareDevelopmentPolicies(cases: readonly DevelopmentCase[]) {
  validateDevelopment(cases);
  const policies: { name: string; policy: EffortPolicy }[] = [
    { name: 'identity', policy: { kind: 'identity' } },
    { name: 'asymmetric', policy: { kind: 'asymmetric' } },
    { name: 'relative-base-low', policy: { kind: 'relative-base-low' } },
    { name: 'asymmetric-relative-low', policy: { kind: 'asymmetric-relative-low' } },
    ...(['low', 'medium', 'high'] as const).map((level) => ({
      name: `constant-${level}`,
      policy: { kind: 'constant' as const, level },
    })),
  ];
  const constantLow = evaluateDevelopmentPolicy(cases, { kind: 'constant', level: 'low' }).metrics;
  const comparisons = policies.map(({ name, policy }) => {
    const result = evaluateDevelopmentPolicy(cases, policy);
    return {
      name,
      policy,
      ...result,
      constantLowComparison: lowComparison(result.metrics, constantLow),
    };
  });
  return {
    algorithm: MAP_ALGORITHM_VERSION,
    comparisons,
    learnedOOF: crossValidateMonotoneMap(cases),
    fullDevelopmentRefit: null,
    scope:
      'model-specific empirical development success/cost; not calibrated P(success) or final evidence',
    limitation:
      'small development samples can give unstable maps; training feasibility is not a confidence bound',
  };
}
