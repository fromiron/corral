// A linear softmax classifier over the frozen embedding, with temperature calibration and an
// abstain threshold chosen on held-out data (tools/local-intelligence/effort). The weights only
// fit the base model, embedding size and preprocessing they were trained with.
import { EFFORT_LEVELS, type EffortLevel } from '@corral/contracts';

export interface EffortWeights {
  schemaVersion: 1;
  version: string;
  labels: EffortLevel[];
  dims: number;
  baseModelSha256: string;
  preprocessVersion: string;
  task: 'classification';
  /** One row per label. */
  weights: number[][];
  bias: number[];
  temperature: number;
  /** Below this top probability the judgment is withheld. */
  abstainBelow: number;
}

export interface EffortJudgment {
  answer: EffortLevel;
  probabilities: Record<EffortLevel, number>;
  abstain: boolean;
}

export interface EffortClassifier {
  version: string;
  judge(vector: Float32Array): EffortJudgment;
}

const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value);

export function loadEffortClassifier(
  raw: unknown,
  expected: { dims: number; baseModelSha256: string; preprocessVersion: string },
): EffortClassifier {
  const weights = raw as EffortWeights;
  if (
    weights?.schemaVersion !== 1 ||
    typeof weights.version !== 'string' ||
    weights.task !== 'classification'
  )
    throw new Error('effort weights are invalid');
  if (weights.labels?.join() !== EFFORT_LEVELS.join())
    throw new Error('effort weights have other labels');
  if (weights.dims !== expected.dims)
    throw new Error(
      `effort weights expect ${weights.dims} dimensions, the engine gives ${expected.dims}`,
    );
  if (weights.baseModelSha256 !== expected.baseModelSha256)
    throw new Error('effort weights were trained for another base model');
  if (weights.preprocessVersion !== expected.preprocessVersion)
    throw new Error(`effort weights expect preprocessing ${weights.preprocessVersion}`);
  if (
    weights.weights?.length !== EFFORT_LEVELS.length ||
    weights.weights.some((row) => row?.length !== weights.dims || !row.every(finite)) ||
    weights.bias?.length !== EFFORT_LEVELS.length ||
    !weights.bias.every(finite) ||
    !finite(weights.temperature) ||
    weights.temperature <= 0 ||
    !finite(weights.abstainBelow) ||
    weights.abstainBelow < 0 ||
    weights.abstainBelow > 1
  )
    throw new Error('effort weights are invalid');
  const rows = weights.weights.map((row) => Float64Array.from(row));
  return {
    version: weights.version,
    judge(vector) {
      if (vector.length !== weights.dims)
        throw new Error(`expected ${weights.dims} dimensions, got ${vector.length}`);
      const logits = rows.map((row, label) => {
        let sum = weights.bias[label]!;
        for (let i = 0; i < row.length; i++) sum += row[i]! * vector[i]!;
        return sum / weights.temperature;
      });
      const top = Math.max(...logits);
      const exp = logits.map((value) => Math.exp(value - top));
      const total = exp.reduce((a, b) => a + b, 0);
      const probabilities = exp.map((value) => value / total);
      let best = 0;
      for (let i = 1; i < probabilities.length; i++)
        if (probabilities[i]! > probabilities[best]!) best = i;
      return {
        answer: EFFORT_LEVELS[best]!,
        probabilities: {
          low: probabilities[0]!,
          medium: probabilities[1]!,
          high: probabilities[2]!,
          xhigh: probabilities[3]!,
        },
        abstain: probabilities[best]! < weights.abstainBelow,
      };
    },
  };
}
