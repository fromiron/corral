// Compare decisions from the same frozen probabilities. No model training or external calls.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import type { EffortLevel } from '../../../packages/contracts/src/index.ts';
import {
  effortExpectedCost,
  LOW_EFFORT_REVIEW_CEILING,
  lowEffortNeedsReview,
} from '../../../packages/core/src/reasoning-risk.ts';
import { loadEffortClassifier } from '../../../packages/local-intelligence/src/effort/classifier.ts';

const [samplesPath, vectorPath, weightPath, output] = process.argv.slice(2);
if (!samplesPath || !vectorPath || !weightPath || !output)
  throw new Error('usage: compare-policy.ts <original.jsonl> <cpu.f32> <weights.json> <out-base>');
const sha = (raw: Buffer | string) => createHash('sha256').update(raw).digest('hex');
const raw = readFileSync(samplesPath),
  metadata = JSON.parse(readFileSync(`${vectorPath}.json`, 'utf8'));
if (
  sha(raw) !== '2f3cea1d2ffac043ec8f886c6e57b30db35b5c73a52f6d4fa5ea0400ad5bd5f2' ||
  metadata.samplesSha256 !== sha(raw) ||
  metadata.device !== 'cpu'
)
  throw new Error('evaluation provenance differs');
const weights = JSON.parse(readFileSync(weightPath, 'utf8'));
const classifier = loadEffortClassifier(weights, metadata);
const levels: EffortLevel[] = ['low', 'medium', 'high', 'xhigh'];
const bytes = readFileSync(vectorPath),
  vectors = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
const samples = raw
  .toString()
  .trim()
  .split('\n')
  .map(
    (line) =>
      JSON.parse(line) as {
        id: string;
        group: string;
        source: string;
        label: EffortLevel;
        use: string;
      },
  );
if (vectors.length !== samples.length * metadata.dims || metadata.count !== samples.length)
  throw new Error('embedding size differs');
const rows = samples.map((sample, n) => {
  const unit = createHash('sha256').update(sample.group).digest().readUInt32BE(0) / 2 ** 32;
  return {
    sample,
    split:
      sample.use === 'eval' ? 'eval' : unit < 0.7 ? 'train' : unit < 0.85 ? 'calibration' : 'test',
    judgment: classifier.judge(vectors.subarray(n * metadata.dims, (n + 1) * metadata.dims)),
  };
});
type Row = (typeof rows)[number];
const coding = new Set(['commitpackft', 'taco', 'swe-rebench', 'swe-rebench-title']);
const reviewAt = (row: Row, ceiling: number) =>
  row.judgment.answer === 'low' &&
  row.judgment.probabilities.low < ceiling &&
  effortExpectedCost('low', row.judgment.probabilities) >
    effortExpectedCost('medium', row.judgment.probabilities) + 1e-12;
function decide(
  row: Row,
  policy: 'baseline' | 'full-cost' | 'guard',
  ceiling = LOW_EFFORT_REVIEW_CEILING,
): EffortLevel {
  if (row.judgment.abstain) return 'medium';
  if (policy === 'guard') return reviewAt(row, ceiling) ? 'medium' : row.judgment.answer;
  if (policy === 'baseline') return row.judgment.answer;
  // Preserve the reference's tie order: default, cheaper side, then the higher levels.
  return (['medium', 'low', 'high', 'xhigh'] as EffortLevel[]).reduce(
    (best, candidate) =>
      effortExpectedCost(candidate, row.judgment.probabilities) <
      effortExpectedCost(best, row.judgment.probabilities) - 1e-12
        ? candidate
        : best,
    'medium',
  );
}
function metrics(
  picked: Row[],
  policy: 'baseline' | 'full-cost' | 'guard',
  ceiling = LOW_EFFORT_REVIEW_CEILING,
) {
  let correct = 0,
    hardAsLow = 0,
    extraReview = 0,
    error = 0,
    veryHard = 0,
    veryHardCorrect = 0;
  for (const row of picked) {
    const actual = levels.indexOf(row.sample.label),
      chosen = decide(row, policy, ceiling),
      pred = levels.indexOf(chosen);
    correct += Number(actual === pred);
    hardAsLow += Number(actual >= 2 && pred === 0);
    error += Math.abs(actual - pred);
    veryHard += Number(actual === 3);
    veryHardCorrect += Number(actual === 3 && pred === 3);
    extraReview += Number(policy === 'guard' && !row.judgment.abstain && reviewAt(row, ceiling));
  }
  return {
    n: picked.length,
    accuracy: correct / picked.length,
    levelError: error / picked.length,
    hardAsLow,
    xhighRecall: veryHardCorrect / veryHard,
    extraReview,
  };
}
const calibration = rows.filter((r) => r.split === 'calibration'),
  codingCalibration = calibration.filter((r) => coding.has(r.sample.source));
const validation = [0.4, 0.5, 0.6, 0.7, 1].map((ceiling) => ({
  ceiling,
  all: metrics(calibration, 'guard', ceiling),
  coding: metrics(codingCalibration, 'guard', ceiling),
}));
const baseValidation = {
  all: metrics(calibration, 'baseline'),
  coding: metrics(codingCalibration, 'baseline'),
};
const eligible = validation
  .filter(
    (v) =>
      v.all.accuracy >= baseValidation.all.accuracy &&
      v.coding.accuracy >= baseValidation.coding.accuracy,
  )
  .sort((a, b) => a.all.hardAsLow - b.all.hardAsLow || a.ceiling - b.ceiling);
if (eligible[0]?.ceiling !== LOW_EFFORT_REVIEW_CEILING)
  throw new Error('policy ceiling differs from validation selection');
for (const row of rows)
  if (
    lowEffortNeedsReview(row.judgment.answer, row.judgment.probabilities) !==
    reviewAt(row, LOW_EFFORT_REVIEW_CEILING)
  )
    throw new Error('product policy and evaluator differ');
const subsets: [string, Row[]][] = [
  ['기존 전체 테스트', rows.filter((r) => r.split === 'test')],
  ['기존 코딩 테스트', rows.filter((r) => r.split === 'test' && coding.has(r.sample.source))],
  ['SWE-bench Verified', rows.filter((r) => r.split === 'eval')],
];
const results = subsets.map(([name, picked]) => ({
  name,
  baseline: metrics(picked, 'baseline'),
  fullCost: metrics(picked, 'full-cost'),
  guard: metrics(picked, 'guard'),
}));
const report = {
  modelSha256: sha(JSON.stringify(weights)),
  samplesSha256: sha(raw),
  policyVersion: 'corral-effort-v2',
  ceiling: LOW_EFFORT_REVIEW_CEILING,
  selection:
    'validation only: minimize hard-as-low count with no accuracy regression on all/coding calibration sets; tie favors the lower ceiling',
  baseValidation,
  validation,
  results,
};
writeFileSync(`${output}.json`, JSON.stringify(report, null, 2) + '\n');
const pct = (n: number) => (100 * n).toFixed(1) + '%';
writeFileSync(
  `${output}.md`,
  '# 추론 수준 선택 정책 비교\n\n같은 effort-v2 확률을 사용한다. 외부 판정 API를 호출하지 않고 보류는 medium으로 계산했다. 분류 가중치·임베딩·라벨은 바꾸지 않았다. 기준은 argmax, 참조는 분포 전체의 비대칭 기대비용 최소화, 적용 정책은 불확실한 low만 보류한다. 공개 데이터의 난이도 대리 라벨이며 실제 답변 품질·토큰 비용은 측정하지 않았다.\n\n| 평가 | 정책 | n | 수준 일치율 | 수준 오차 | high/xhigh→low 건수 | xhigh 재현율 | 추가 보류 |\n|---|---|---:|---:|---:|---:|---:|---:|\n' +
    results
      .flatMap((r) =>
        [
          ['기존', r.baseline],
          ['전체 기대비용', r.fullCost],
          ['low 보호', r.guard],
        ].map(([name, value]) => {
          const m = value as typeof r.baseline;
          return `| ${r.name} | ${name} | ${m.n} | ${pct(m.accuracy)} | ${m.levelError.toFixed(3)} | ${m.hardAsLow} | ${pct(m.xhighRecall)} | ${m.extraReview} |`;
        }),
      )
      .join('\n') +
    '\n\n확률 상한 후보 0.4/0.5/0.6/0.7/1 중 기존 전체·코딩 검증 정확도를 낮추지 않으면서 심한 과소 판정을 가장 많이 줄이는 0.6을 선택했다. 최종 테스트는 선택에 사용하지 않았다. 보류 증가로 외부 판정 API가 활성화된 실행의 호출 빈도가 늘 수 있으며 이 경우의 품질과 비용은 별도다.\n',
);
console.log(JSON.stringify(results, null, 2));
