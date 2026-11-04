// A classifier over the embedding: linear or one ReLU hidden layer (schema 1 and 2), or, in
// schema 3, a LayerNorm + GELU level head with a logistic openness head. An open request (one with
// no fixed end, where more thinking finds more) is raised to high; otherwise the level head's top
// answer stands. The weights only fit the model, embedding size and preprocessing they were
// trained with.
import { EFFORT_LEVELS, type EffortLevel } from '@corral/contracts';

export interface EffortWeights {
  schemaVersion: 1 | 2 | 3;
  version: string;
  labels: EffortLevel[];
  dims: number;
  baseModelSha256: string;
  preprocessVersion: string;
  task: 'classification';
  /** One row per label. */
  weights: number[][];
  bias: number[];
  /** Schema 3: LayerNorm over the embedding ahead of the hidden layer. */
  layerNorm?: { weight: number[]; bias: number[]; eps: number };
  /**
   * Schema 2: optional ReLU hidden layer whose affine map includes training-time input
   * normalization. Schema 3: required GELU (erf) hidden layer after the LayerNorm.
   */
  hidden?: { weights: number[][]; bias: number[]; activation?: 'gelu' };
  temperature: number;
  /** Below this top probability the judgment is withheld. */
  abstainBelow: number;
  /** Schema 3: logistic openness over the embedding; at or above `raiseAt` the answer is high. */
  open?: { weights: number[]; bias: number; raiseAt: number };
}

export interface EffortJudgment {
  answer: EffortLevel;
  /** The level head's distribution, also when openness raised the answer. */
  probabilities: Record<EffortLevel, number>;
  abstain: boolean;
  /** Schema 3: the probability that the request is open. */
  open?: number;
}

export interface EffortClassifier {
  version: string;
  /** False when the weights have no abstain threshold: every judgment answers. */
  abstains: boolean;
  judge(vector: Float32Array): EffortJudgment;
}

const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value);
const vectorOf = (value: unknown, length: number): value is number[] =>
  Array.isArray(value) && value.length === length && value.every(finite);

/** Abramowitz and Stegun 7.1.26; its error (under 1.5e-7) is far below the weights' precision. */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const poly =
    t *
    (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return sign * (1 - poly * Math.exp(-a * a));
}

const gelu = (x: number) => 0.5 * x * (1 + erf(x / Math.SQRT2));

export function loadEffortClassifier(
  raw: unknown,
  expected: { dims: number; baseModelSha256: string; preprocessVersion: string },
): EffortClassifier {
  const weights = raw as EffortWeights;
  if (
    ![1, 2, 3].includes(weights?.schemaVersion) ||
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
  const v3 = weights.schemaVersion === 3;
  const { layerNorm, open } = weights;
  if (
    v3 !== Boolean(layerNorm) ||
    v3 !== Boolean(open) ||
    (layerNorm &&
      (!vectorOf(layerNorm.weight, expected.dims) ||
        !vectorOf(layerNorm.bias, expected.dims) ||
        !finite(layerNorm.eps) ||
        layerNorm.eps <= 0)) ||
    (open &&
      (!vectorOf(open.weights, expected.dims) ||
        !finite(open.bias) ||
        !finite(open.raiseAt) ||
        open.raiseAt < 0 ||
        open.raiseAt > 1))
  )
    throw new Error('effort openness or normalization weights are invalid');
  const hidden = weights.hidden;
  if ((v3 && !hidden) || (hidden && hidden.activation !== (v3 ? 'gelu' : undefined)))
    throw new Error('effort hidden weights are invalid');
  if (
    hidden &&
    (weights.schemaVersion === 1 ||
      !Array.isArray(hidden.weights) ||
      hidden.weights.length < 1 ||
      hidden.weights.length > 128 ||
      hidden.weights.some(
        (row) => !Array.isArray(row) || row.length !== expected.dims || !row.every(finite),
      ) ||
      !Array.isArray(hidden.bias) ||
      hidden.bias.length !== hidden.weights.length ||
      !hidden.bias.every(finite))
  )
    throw new Error('effort hidden weights are invalid');
  const outputDims = hidden?.weights.length ?? weights.dims;
  if (
    weights.weights?.length !== EFFORT_LEVELS.length ||
    weights.weights.some((row) => row?.length !== outputDims || !row.every(finite)) ||
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
  const hiddenRows = hidden?.weights.map((row) => Float64Array.from(row));
  const activate = v3 ? gelu : (value: number) => Math.max(0, value);
  const normalize = (vector: Float32Array): ArrayLike<number> => {
    if (!layerNorm) return vector;
    let mean = 0;
    for (const value of vector) mean += value;
    mean /= vector.length;
    let variance = 0;
    for (const value of vector) variance += (value - mean) ** 2;
    const scale = 1 / Math.sqrt(variance / vector.length + layerNorm.eps);
    return Float64Array.from(
      vector,
      (value, i) => (value - mean) * scale * layerNorm.weight[i]! + layerNorm.bias[i]!,
    );
  };
  return {
    version: weights.version,
    abstains: weights.abstainBelow > 0,
    judge(vector) {
      if (vector.length !== weights.dims)
        throw new Error(`expected ${weights.dims} dimensions, got ${vector.length}`);
      const input = normalize(vector);
      const features = hiddenRows
        ? Float64Array.from(hiddenRows, (row, unit) => {
            let value = hidden!.bias[unit]!;
            for (let i = 0; i < row.length; i++) value += row[i]! * input[i]!;
            return activate(value);
          })
        : input;
      const logits = rows.map((row, label) => {
        let sum = weights.bias[label]!;
        for (let i = 0; i < row.length; i++) sum += row[i]! * features[i]!;
        return sum / weights.temperature;
      });
      const top = Math.max(...logits);
      const exp = logits.map((value) => Math.exp(value - top));
      const total = exp.reduce((a, b) => a + b, 0);
      const probabilities = exp.map((value) => value / total);
      let best = 0;
      for (let i = 1; i < probabilities.length; i++)
        if (probabilities[i]! > probabilities[best]!) best = i;
      let openness: number | undefined;
      if (open) {
        let z = open.bias;
        for (let i = 0; i < vector.length; i++) z += open.weights[i]! * vector[i]!;
        openness = 1 / (1 + Math.exp(-z));
      }
      const raised = openness !== undefined && openness >= open!.raiseAt;
      return {
        answer: raised ? 'high' : EFFORT_LEVELS[best]!,
        probabilities: {
          low: probabilities[0]!,
          medium: probabilities[1]!,
          high: probabilities[2]!,
          xhigh: probabilities[3]!,
        },
        abstain: !raised && probabilities[best]! < weights.abstainBelow,
        ...(openness === undefined ? {} : { open: openness }),
      };
    },
  };
}
