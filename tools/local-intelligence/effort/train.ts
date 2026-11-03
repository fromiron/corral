// Trains the effort classifier on frozen embeddings, then writes the weights and the report.
//
//   node tools/local-intelligence/effort/train.ts <samples.jsonl> <cpu.f32> [<gpu.f32>]
//
// CPU is the default device, so the CPU vectors train and calibrate the classifier; the optional
// GPU vectors only measure agreement. Training groups (a problem and its translations, a repository)
// never cross the train / calibration / test split. The output is deterministic for the same
// inputs: packages/local-intelligence/weights/effort-v1.json and report.md next to this script.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bundledManifest,
  EFFORT_PREPROCESS_VERSION,
  type EffortJudgment,
  type EffortWeights,
  loadEffortClassifier,
} from '../../../packages/local-intelligence/src/index.ts';
import type { EmbeddingInfo } from './embed.ts';

const LEVELS = ['low', 'medium', 'high', 'xhigh'] as const;
type Level = (typeof LEVELS)[number];
type Split = 'train' | 'calibration' | 'test' | 'eval';
const MEDIUM = 1;
const VERSION = 'effort-v1';
const WEIGHTS = fileURLToPath(
  new URL(`../../../packages/local-intelligence/weights/${VERSION}.json`, import.meta.url),
);
const REPORT = fileURLToPath(new URL('report.md', import.meta.url));

interface Sample {
  id: string;
  source: string;
  group: string;
  lang: string;
  label: Level;
  signal: string;
  use: 'train' | 'eval';
  request: string;
}

const [samplesPath, cpuPath, gpuPath] = process.argv.slice(2);
if (!samplesPath || !cpuPath) {
  console.error('usage: train.ts <samples.jsonl> <cpu.f32> [<gpu.f32>]');
  process.exit(2);
}

const bundle = bundledManifest();
const dims = bundle.embedding.dims;
const raw = readFileSync(samplesPath);
const samplesSha256 = createHash('sha256').update(raw).digest('hex');
const samples = raw
  .toString('utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line) as Sample);

function vectors(path: string, device: string): Float32Array {
  const info = JSON.parse(readFileSync(`${path}.json`, 'utf8')) as EmbeddingInfo;
  const expected = {
    release: bundle.release,
    baseModelSha256: bundle.model.sha256,
    preprocessVersion: EFFORT_PREPROCESS_VERSION,
    device,
    count: samples.length,
    dims,
    samplesSha256,
  };
  for (const [key, value] of Object.entries(expected))
    if (info[key as keyof EmbeddingInfo] !== value)
      throw new Error(`${path}: ${key} is ${info[key as keyof EmbeddingInfo]}, expected ${value}`);
  const bytes = readFileSync(path);
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}
const cpu = vectors(cpuPath, 'cpu');
const gpu = gpuPath ? vectors(gpuPath, 'gpu') : null;
const row = <T extends Float32Array | Float64Array>(all: T, index: number) =>
  all.subarray(index * dims, (index + 1) * dims) as T;

function split(sample: Sample): Split {
  if (sample.use === 'eval') return 'eval';
  const unit = createHash('sha256').update(sample.group).digest().readUInt32BE(0) / 2 ** 32;
  return unit < 0.7 ? 'train' : unit < 0.85 ? 'calibration' : 'test';
}
const splits = samples.map(split);
const indices = (name: Split) => samples.flatMap((_, i) => (splits[i] === name ? [i] : []));
const trainSet = indices('train');
const calibrationSet = indices('calibration');
const testSet = indices('test');
const evalSet = indices('eval');
const level = (index: number) => LEVELS.indexOf(samples[index]!.label);

// Each level counts equally: the sample's level mix comes from the caps, not from real requests.
function levelWeights(set: number[]): number[] {
  const counts = LEVELS.map((_, k) => set.filter((i) => level(i) === k).length);
  return LEVELS.map((_, k) => (counts[k] ? set.length / (LEVELS.length * counts[k]!) : 0));
}

// --- language directions ---

// Korean and Japanese text only comes with low and medium labels, so the language alone would
// predict the level. Each translation's mean offset from its English MMLU item (training groups
// only) is projected out of every vector; the projection is folded into the weights below.
const directions: Float64Array[] = [];
const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let sum = 0;
  for (let j = 0; j < dims; j++) sum += a[j]! * b[j]!;
  return sum;
};
function removeDirections(x: Float64Array) {
  for (const u of directions) {
    const along = dot(x, u);
    for (let j = 0; j < dims; j++) x[j]! -= along * u[j]!;
  }
}
const englishItem = new Map(
  trainSet
    .filter((i) => samples[i]!.source === 'mmlu' && samples[i]!.lang === 'en')
    .map((i) => [samples[i]!.group, i]),
);
for (const lang of ['ko', 'ja']) {
  const offset = new Float64Array(dims);
  for (const i of trainSet) {
    const english = englishItem.get(samples[i]!.group);
    if (samples[i]!.lang !== lang || english === undefined) continue;
    const [x, e] = [row(cpu, i), row(cpu, english)];
    for (let j = 0; j < dims; j++) offset[j]! += x[j]! - e[j]!;
  }
  removeDirections(offset);
  const norm = Math.sqrt(dot(offset, offset));
  if (norm === 0) throw new Error(`no ${lang} translations in the training split`);
  directions.push(offset.map((value) => value / norm));
}
const features = new Float64Array(samples.length * dims);
samples.forEach((_, i) => {
  const x = row(features, i);
  x.set(row(cpu, i));
  removeDirections(x);
});

// --- training: softmax regression on standardized features, Adam, L2 ---

const mean = new Float64Array(dims);
const scale = new Float64Array(dims);
for (const i of trainSet) {
  const x = row(features, i);
  for (let j = 0; j < dims; j++) mean[j]! += x[j]! / trainSet.length;
}
for (const i of trainSet) {
  const x = row(features, i);
  for (let j = 0; j < dims; j++) scale[j]! += (x[j]! - mean[j]!) ** 2 / trainSet.length;
}
for (let j = 0; j < dims; j++) scale[j] = Math.sqrt(scale[j]!) || 1;
const standardized = (set: number[]) => {
  const out = new Float64Array(set.length * dims);
  set.forEach((i, n) => {
    const x = row(features, i);
    for (let j = 0; j < dims; j++) out[n * dims + j] = (x[j]! - mean[j]!) / scale[j]!;
  });
  return out;
};
const trainX = standardized(trainSet);
const calibrationX = standardized(calibrationSet);

interface Linear {
  weights: Float64Array; // LEVELS.length × dims
  bias: Float64Array;
}

function logitsOf(model: Linear, x: ArrayLike<number>, offset: number, out: Float64Array) {
  for (let k = 0; k < LEVELS.length; k++) {
    let sum = model.bias[k]!;
    const base = k * dims;
    for (let j = 0; j < dims; j++) sum += model.weights[base + j]! * x[offset + j]!;
    out[k] = sum;
  }
}

function softmax(logits: Float64Array, temperature = 1): Float64Array {
  const top = Math.max(...logits);
  const out = logits.map((value) => Math.exp((value - top) / temperature));
  const total = out.reduce((a, b) => a + b, 0);
  return out.map((value) => value / total);
}

function train(lambda: number, iterations: number, rate: number): Linear {
  const k = LEVELS.length;
  const model: Linear = { weights: new Float64Array(k * dims), bias: new Float64Array(k) };
  const size = model.weights.length + k;
  const m = new Float64Array(size);
  const v = new Float64Array(size);
  const grad = new Float64Array(size);
  const weightOf = levelWeights(trainSet);
  const total = trainSet.reduce((sum, i) => sum + weightOf[level(i)]!, 0);
  const logits = new Float64Array(k);
  for (let step = 1; step <= iterations; step++) {
    grad.fill(0);
    for (let n = 0; n < trainSet.length; n++) {
      const truth = level(trainSet[n]!);
      logitsOf(model, trainX, n * dims, logits);
      const p = softmax(logits);
      const w = weightOf[truth]! / total;
      for (let c = 0; c < k; c++) {
        const g = w * (p[c]! - (c === truth ? 1 : 0));
        grad[model.weights.length + c]! += g;
        const base = c * dims;
        for (let j = 0; j < dims; j++) grad[base + j]! += g * trainX[n * dims + j]!;
      }
    }
    for (let j = 0; j < model.weights.length; j++) grad[j]! += lambda * model.weights[j]!;
    for (let j = 0; j < size; j++) {
      m[j] = 0.9 * m[j]! + 0.1 * grad[j]!;
      v[j] = 0.999 * v[j]! + 0.001 * grad[j]! ** 2;
      const update =
        (rate * (m[j]! / (1 - 0.9 ** step))) / (Math.sqrt(v[j]! / (1 - 0.999 ** step)) + 1e-8);
      if (j < model.weights.length) model.weights[j]! -= update;
      else model.bias[j - model.weights.length]! -= update;
    }
  }
  return model;
}

function predictStandardized(model: Linear, x: Float64Array, count: number): number[] {
  const logits = new Float64Array(LEVELS.length);
  return Array.from({ length: count }, (_, n) => {
    logitsOf(model, x, n * dims, logits);
    return argmax(logits);
  });
}

const argmax = (values: ArrayLike<number>) => {
  let best = 0;
  for (let i = 1; i < values.length; i++) if (values[i]! > values[best]!) best = i;
  return best;
};

// --- metrics ---

function confusion(truth: number[], predicted: number[]): number[][] {
  const matrix = LEVELS.map(() => LEVELS.map(() => 0));
  for (const [n, t] of truth.entries()) matrix[t]![predicted[n]!]!++;
  return matrix;
}

function macroF1(truth: number[], predicted: number[]): number {
  const matrix = confusion(truth, predicted);
  const present = LEVELS.map((_, k) => k).filter((k) => truth.includes(k));
  const f1 = present.map((k) => {
    const tp = matrix[k]![k]!;
    const fp = matrix.reduce((sum, r, t) => sum + (t === k ? 0 : r[k]!), 0);
    const fn = matrix[k]!.reduce((a, b) => a + b, 0) - tp;
    return tp === 0 ? 0 : (2 * tp) / (2 * tp + fp + fn);
  });
  return f1.reduce((a, b) => a + b, 0) / Math.max(1, f1.length);
}

const accuracy = (truth: number[], predicted: number[]) =>
  truth.filter((t, n) => t === predicted[n]).length / Math.max(1, truth.length);
const meanError = (truth: number[], predicted: number[]) =>
  truth.reduce((sum, t, n) => sum + Math.abs(t - predicted[n]!), 0) / Math.max(1, truth.length);

function calibrationError(truth: number[], judgments: EffortJudgment[], bins = 15): number {
  const sums = Array.from({ length: bins }, () => ({ n: 0, confidence: 0, correct: 0 }));
  judgments.forEach((judgment, n) => {
    const top = judgment.probabilities[judgment.answer];
    const bin = sums[Math.min(bins - 1, Math.floor(top * bins))]!;
    bin.n++;
    bin.confidence += top;
    bin.correct += LEVELS.indexOf(judgment.answer) === truth[n] ? 1 : 0;
  });
  return sums.reduce(
    (sum, b) => sum + (b.n ? Math.abs(b.correct - b.confidence) / truth.length : 0),
    0,
  );
}

// --- model selection, temperature and abstain threshold on the calibration split ---

const calibrationTruth = calibrationSet.map(level);
const candidates = [1e-4, 1e-3, 1e-2, 1e-1].map((lambda) => {
  const model = train(lambda, 600, 0.005);
  const predicted = predictStandardized(model, calibrationX, calibrationSet.length);
  const score = macroF1(calibrationTruth, predicted);
  console.error(`lambda ${lambda}: calibration macro-F1 ${score.toFixed(4)}`);
  return { lambda, model, score };
});
const chosen = candidates.reduce((best, c) => (c.score > best.score ? c : best));

// Fold the projection and the standardization into the weights, so the runtime applies one
// affine map to the raw vector. The projection is symmetric, so it moves onto each weight row.
const folded: Linear = {
  weights: new Float64Array(LEVELS.length * dims),
  bias: new Float64Array(LEVELS.length),
};
for (let k = 0; k < LEVELS.length; k++) {
  const w = row(folded.weights, k);
  let bias = chosen.model.bias[k]!;
  for (let j = 0; j < dims; j++) {
    w[j] = chosen.model.weights[k * dims + j]! / scale[j]!;
    bias -= w[j]! * mean[j]!;
  }
  removeDirections(w);
  folded.bias[k] = bias;
}

const calibrationLogits = calibrationSet.map((i) => {
  const out = new Float64Array(LEVELS.length);
  logitsOf(folded, row(cpu, i), 0, out);
  return out;
});
const nll = (temperature: number) =>
  calibrationLogits.reduce(
    (sum, logits, n) => sum - Math.log(softmax(logits, temperature)[calibrationTruth[n]!]!),
    0,
  ) / calibrationLogits.length;
let [lo, hi] = [Math.log(0.05), Math.log(20)];
for (let step = 0; step < 80; step++) {
  const a = lo + (hi - lo) * 0.382;
  const b = lo + (hi - lo) * 0.618;
  if (nll(Math.exp(a)) < nll(Math.exp(b))) hi = b;
  else lo = a;
}
const temperature = Math.exp((lo + hi) / 2);

// Abstaining costs the medium fallback's error; keep the threshold with the lowest total
// level-weighted error on the calibration split (ties keep more judgments).
const thresholdWeights = levelWeights(calibrationSet);
const ranked = calibrationLogits
  .map((logits, n) => {
    const p = softmax(logits, temperature);
    const answer = argmax(p);
    const truth = calibrationTruth[n]!;
    const weight = thresholdWeights[truth]!;
    return {
      top: p[answer]!,
      judged: weight * Math.abs(answer - truth),
      fallback: weight * Math.abs(MEDIUM - truth),
    };
  })
  .sort((a, b) => b.top - a.top);
let cost = ranked.reduce((sum, r) => sum + r.fallback, 0);
let best = { cost, covered: 0 };
ranked.forEach((r, n) => {
  cost += r.judged - r.fallback;
  const boundary = n === ranked.length - 1 || ranked[n + 1]!.top < r.top;
  if (boundary && cost <= best.cost) best = { cost, covered: n + 1 };
});
const abstainBelow =
  best.covered === ranked.length
    ? 0
    : best.covered === 0
      ? 1
      : Math.floor(ranked[best.covered - 1]!.top * 1e6) / 1e6;

const round = (value: number) => Number(value.toPrecision(7));
const output: EffortWeights = {
  schemaVersion: 1,
  version: VERSION,
  labels: [...LEVELS],
  dims,
  baseModelSha256: bundle.model.sha256,
  preprocessVersion: EFFORT_PREPROCESS_VERSION,
  task: 'classification',
  weights: LEVELS.map((_, k) =>
    Array.from(folded.weights.subarray(k * dims, (k + 1) * dims), round),
  ),
  bias: Array.from(folded.bias, round),
  temperature: round(temperature),
  abstainBelow,
};
mkdirSync(dirname(WEIGHTS), { recursive: true });
writeFileSync(WEIGHTS, `${JSON.stringify(output)}\n`);

// --- evaluation through the shipped classifier code ---

const classifier = loadEffortClassifier(JSON.parse(readFileSync(WEIGHTS, 'utf8')), {
  dims,
  baseModelSha256: bundle.model.sha256,
  preprocessVersion: EFFORT_PREPROCESS_VERSION,
});
const judgeAll = (set: number[], all: Float32Array) =>
  set.map((i) => classifier.judge(row(all, i)));

interface Result {
  n: number;
  accuracy: number;
  macroF1: number;
  error: number;
  ece: number;
  coverage: number;
  selective: number;
  withFallback: number;
  allMedium: number;
}

function evaluate(set: number[], judgments: EffortJudgment[]): Result {
  const truth = set.map(level);
  const predicted = judgments.map((j) => LEVELS.indexOf(j.answer));
  const covered = judgments.flatMap((j, n) => (j.abstain ? [] : [n]));
  const applied = judgments.map((j, n) => (j.abstain ? MEDIUM : predicted[n]!));
  return {
    n: set.length,
    accuracy: accuracy(truth, predicted),
    macroF1: macroF1(truth, predicted),
    error: meanError(truth, predicted),
    ece: calibrationError(truth, judgments),
    coverage: covered.length / Math.max(1, set.length),
    selective: accuracy(
      covered.map((n) => truth[n]!),
      covered.map((n) => predicted[n]!),
    ),
    withFallback: meanError(truth, applied),
    allMedium: meanError(
      truth,
      truth.map(() => MEDIUM),
    ),
  };
}

const testCpu = judgeAll(testSet, cpu);
const testGpu = gpu ? judgeAll(testSet, gpu) : null;
const evalCpu = judgeAll(evalSet, cpu);

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
const num = (value: number) => value.toFixed(3);
const header =
  '| 범위 | n | 정확도 | macro-F1 | 평균 수준 오차 | ECE | 판정 비율 | 판정한 것의 정확도 | 오차(보류→medium) | 오차(항상 medium) |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|';
const line = (name: string, r: Result) =>
  `| ${name} | ${r.n} | ${pct(r.accuracy)} | ${num(r.macroF1)} | ${num(r.error)} | ${num(r.ece)} | ${pct(r.coverage)} | ${pct(r.selective)} | ${num(r.withFallback)} | ${num(r.allMedium)} |`;

function table(set: number[], judgments: EffortJudgment[], key: (s: Sample) => string): string {
  const names = [...new Set(set.map((i) => key(samples[i]!)))].sort();
  return names
    .map((name) => {
      const picked = set.flatMap((i, n) => (key(samples[i]!) === name ? [n] : []));
      return line(
        name,
        evaluate(
          picked.map((n) => set[n]!),
          picked.map((n) => judgments[n]!),
        ),
      );
    })
    .join('\n');
}

function matrix(set: number[], judgments: EffortJudgment[]): string {
  const m = confusion(
    set.map(level),
    judgments.map((j) => LEVELS.indexOf(j.answer)),
  );
  return [
    `| 정답 \\ 판정 | ${LEVELS.join(' | ')} |`,
    `|---|${LEVELS.map(() => '---:').join('|')}|`,
    ...m.map((r, t) => `| ${LEVELS[t]} | ${r.join(' | ')} |`),
  ].join('\n');
}

function counts(): string {
  const keys = [...new Set(samples.map((s) => `${s.source}|${s.lang}`))].sort();
  return [
    `| 출처 | 언어 | ${LEVELS.join(' | ')} | 학습 | 보정 | 테스트 | 평가 전용 |`,
    `|---|---|${LEVELS.map(() => '---:').join('|')}|---:|---:|---:|---:|`,
    ...keys.map((key) => {
      const [source, lang] = key.split('|');
      const picked = samples.flatMap((s, i) => (s.source === source && s.lang === lang ? [i] : []));
      const byLevel = LEVELS.map((l) => picked.filter((i) => samples[i]!.label === l).length);
      const bySplit = (['train', 'calibration', 'test', 'eval'] as const).map(
        (name) => picked.filter((i) => splits[i] === name).length,
      );
      return `| ${source} | ${lang} | ${byLevel.join(' | ')} | ${bySplit.join(' | ')} |`;
    }),
  ].join('\n');
}

// The same MMLU item in English, Korean and Japanese should get the same judgment.
function parallel(): string {
  const groups = new Map<string, Map<string, EffortJudgment>>();
  testSet.forEach((i, n) => {
    const sample = samples[i]!;
    if (sample.source !== 'mmlu') return;
    const group = groups.get(sample.group) ?? new Map<string, EffortJudgment>();
    group.set(sample.lang, testCpu[n]!);
    groups.set(sample.group, group);
  });
  return ['ko', 'ja']
    .map((lang) => {
      const pairs = [...groups.values()].filter((g) => g.has('en') && g.has(lang));
      const same = pairs.filter((g) => g.get('en')!.answer === g.get(lang)!.answer).length;
      const sameAbstain = pairs.filter((g) => g.get('en')!.abstain === g.get(lang)!.abstain).length;
      return `| en ↔ ${lang} | ${pairs.length} | ${pct(same / Math.max(1, pairs.length))} | ${pct(sameAbstain / Math.max(1, pairs.length))} |`;
    })
    .join('\n');
}

function devices(): string {
  if (!testGpu) return 'GPU 임베딩 없이 학습해 측정하지 않았다.';
  const same = testCpu.filter((j, n) => j.answer === testGpu[n]!.answer).length;
  const sameAbstain = testCpu.filter((j, n) => j.abstain === testGpu[n]!.abstain).length;
  const gaps = testCpu.map((j, n) =>
    Math.max(...LEVELS.map((l) => Math.abs(j.probabilities[l] - testGpu[n]!.probabilities[l]))),
  );
  return [
    '| 비교 | 값 |',
    '|---|---:|',
    `| 판정 수준 일치 | ${pct(same / testSet.length)} |`,
    `| 보류 여부 일치 | ${pct(sameAbstain / testSet.length)} |`,
    `| 확률 차이 평균 (수준별 최대) | ${num(gaps.reduce((a, b) => a + b, 0) / gaps.length)} |`,
    `| 확률 차이 최대 | ${num(Math.max(...gaps))} |`,
  ].join('\n');
}

const report = `# effort 분류기 검증 리포트 (${VERSION})

\`train.ts\`가 생성한다. 손으로 고치지 않는다. 절차와 한계는 [README](README.md)에 있다.

- 기반 모델: \`${bundle.model.file}\` (sha256 \`${bundle.model.sha256.slice(0, 12)}…\`), 번들 \`${bundle.release}\`, 전처리 \`${EFFORT_PREPROCESS_VERSION}\`
- 표본: ${samples.length}건 (sha256 \`${samplesSha256.slice(0, 12)}…\`). 학습 ${trainSet.length}, 보정 ${calibrationSet.length}, 테스트 ${testSet.length}, 평가 전용 ${evalSet.length}
- 언어 방향 제거: ko, ja (학습 세트의 MMLU 번역 쌍 평균 차이)
- 선택된 L2 계수: ${chosen.lambda} (보정 세트 macro-F1 ${candidates.map((c) => `${c.lambda}: ${num(c.score)}`).join(', ')})
- 온도: ${output.temperature}. 보류 기준(최대 확률): ${abstainBelow}
- 수치는 CPU 임베딩 기준이다. "평균 수준 오차"는 low=0 … xhigh=3으로 둔 절대 차이의 평균이다.

## 표본 구성

${counts()}

## 테스트 세트 (CPU)

${header}
${line('전체', evaluate(testSet, testCpu))}

### 출처별

${header}
${table(testSet, testCpu, (s) => s.source)}

### 언어별

${header}
${table(testSet, testCpu, (s) => s.lang)}

### 혼동행렬 (보류 전 판정)

${matrix(testSet, testCpu)}

## 번역 병렬 일관성 (MMLU 테스트 그룹)

| 쌍 | 그룹 수 | 같은 판정 | 같은 보류 여부 |
|---|---:|---:|---:|
${parallel()}

## CPU와 GPU 일치 (테스트 세트)

${devices()}

## SWE-bench Verified (평가 전용, 학습에 쓰지 않음)

${header}
${line('전체', evaluate(evalSet, evalCpu))}

${matrix(evalSet, evalCpu)}
`;
writeFileSync(REPORT, report);
console.error(`wrote ${WEIGHTS} and ${REPORT}`);
