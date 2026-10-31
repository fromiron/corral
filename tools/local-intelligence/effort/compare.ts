// Final comparison: loads frozen candidates through the shipped classifier. Does not train.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { loadEffortClassifier } from '../../../packages/local-intelligence/src/effort/classifier.ts';

type Sample = {
  id: string;
  group: string;
  source: string;
  lang: string;
  label: string;
  use: string;
  split?: string;
  input?: unknown;
};
const labels = ['low', 'medium', 'high', 'xhigh'];
const [original, originalVectors, added, addedVectors, candidate, output] = process.argv.slice(2);
if (!original || !originalVectors || !added || !addedVectors || !candidate || !output)
  throw new Error(
    'usage: compare.ts <original.jsonl> <original.f32> <added.jsonl> <added.f32> <candidate.json> <out-base>',
  );
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
function load(path: string, vectors: string) {
  const raw = readFileSync(path),
    info = JSON.parse(readFileSync(`${vectors}.json`, 'utf8'));
  const samples = raw
    .toString()
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Sample);
  if (info.samplesSha256 !== sha(raw) || info.count !== samples.length || info.device !== 'cpu')
    throw new Error('sample provenance changed');
  const bytes = readFileSync(vectors),
    values = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  if (values.length !== samples.length * info.dims) throw new Error('embedding size differs');
  return { samples, info, values };
}
const first = load(original, originalVectors),
  second = load(added, addedVectors);
if (first.info.samplesSha256 !== '2f3cea1d2ffac043ec8f886c6e57b30db35b5c73a52f6d4fa5ea0400ad5bd5f2')
  throw new Error('original evaluation corpus changed');
for (const key of ['dims', 'baseModelSha256', 'preprocessVersion'])
  if (first.info[key] !== second.info[key]) throw new Error('embedding pipeline differs');
const baselineRaw = readFileSync(
  new URL('../../../packages/local-intelligence/weights/effort-v1.json', import.meta.url),
);
const candidateRaw = readFileSync(candidate);
const models = [baselineRaw, candidateRaw].map((raw) =>
  loadEffortClassifier(JSON.parse(raw.toString()), first.info),
);
function split(row: Sample) {
  if (row.split) return row.split;
  if (row.use === 'eval') return 'eval';
  const unit = createHash('sha256').update(row.group).digest().readUInt32BE(0) / 2 ** 32;
  return unit < 0.7 ? 'train' : unit < 0.85 ? 'calibration' : 'test';
}
const rows = [first, second].flatMap((data) =>
  data.samples.map((sample, i) => ({
    sample,
    split: split(sample),
    truth: labels.indexOf(sample.label),
    judged: models.map((model) =>
      model.judge(data.values.subarray(i * data.info.dims, (i + 1) * data.info.dims)),
    ),
  })),
);
type Row = (typeof rows)[number];
function metrics(selected: Row[], model: number) {
  const matrix = labels.map(() => labels.map(() => 0));
  let correct = 0,
    error = 0,
    under = 0,
    covered = 0,
    coveredCorrect = 0,
    fallbackError = 0;
  for (const row of selected) {
    const judged = row.judged[model]!,
      pred = labels.indexOf(judged.answer);
    matrix[row.truth]![pred]!++;
    correct += Number(pred === row.truth);
    error += Math.abs(pred - row.truth);
    under += Number(pred < row.truth);
    if (!judged.abstain) {
      covered++;
      coveredCorrect += Number(pred === row.truth);
    }
    fallbackError += Math.abs((judged.abstain ? 1 : pred) - row.truth);
  }
  const present = labels.map((_, i) => i).filter((i) => selected.some((r) => r.truth === i));
  const macroF1 =
    present.reduce((sum, i) => {
      const tp = matrix[i]![i]!,
        total = matrix[i]!.reduce((a, b) => a + b, 0) + matrix.reduce((a, r) => a + r[i]!, 0);
      return sum + (total ? (2 * tp) / total : 0);
    }, 0) / present.length;
  return {
    n: selected.length,
    accuracy: correct / selected.length,
    macroF1,
    levelError: error / selected.length,
    underestimated: under / selected.length,
    coverage: covered / selected.length,
    coveredAccuracy: covered ? coveredCorrect / covered : null,
    fallbackLevelError: fallbackError / selected.length,
    confusion: matrix,
  };
}
function interval(selected: Row[]) {
  const groups = new Map<string, Row[]>();
  for (const row of selected)
    groups.set(row.sample.group, [...(groups.get(row.sample.group) ?? []), row]);
  const totals = [...groups.values()].map((group) => ({
    n: group.length,
    difference: group.reduce(
      (sum, r) =>
        sum +
        Number(labels.indexOf(r.judged[1]!.answer) === r.truth) -
        Number(labels.indexOf(r.judged[0]!.answer) === r.truth),
      0,
    ),
  }));
  let seed = 41;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const samples = Array.from({ length: 1000 }, () => {
    let n = 0,
      delta = 0;
    for (let i = 0; i < totals.length; i++) {
      const g = totals[Math.floor(random() * totals.length)]!;
      n += g.n;
      delta += g.difference;
    }
    return (100 * delta) / n;
  }).sort((a, b) => a - b);
  return [samples[25], samples[974]];
}
const coding = new Set(['commitpackft', 'swe-rebench', 'swe-rebench-title', 'taco']);
const subsets: [string, (r: Row) => boolean][] = [
  ['기존 전체 테스트', (r) => r.split === 'test' && r.sample.source !== 'coding-curriculum'],
  ['기존 코딩 테스트', (r) => r.split === 'test' && coding.has(r.sample.source)],
  ['SWE-bench Verified', (r) => r.split === 'eval'],
  ['작성한 코딩 시나리오', (r) => r.split === 'test' && r.sample.source === 'coding-curriculum'],
  [
    '작성한 코딩 요청',
    (r) => r.split === 'test' && r.sample.source === 'coding-curriculum' && !r.sample.input,
  ],
  [
    '작성한 실행 단계',
    (r) => r.split === 'test' && r.sample.source === 'coding-curriculum' && !!r.sample.input,
  ],
];
const results = subsets.map(([name, predicate]) => {
  const chosen = rows.filter(predicate);
  return {
    name,
    baseline: metrics(chosen, 0),
    candidate: metrics(chosen, 1),
    accuracyDelta95: interval(chosen),
  };
});
if (results[0]!.baseline.n !== 2182 || results[2]!.baseline.n !== 500)
  throw new Error('frozen evaluation split differs');
const report = {
  baselineSha256: sha(JSON.stringify(JSON.parse(baselineRaw.toString()))),
  candidateSha256: sha(JSON.stringify(JSON.parse(candidateRaw.toString()))),
  originalSamplesSha256: first.info.samplesSha256,
  addedSamplesSha256: second.info.samplesSha256,
  embedding: {
    model: first.info.baseModelSha256,
    device: 'cpu',
    dims: first.info.dims,
    preprocessing: first.info.preprocessVersion,
  },
  testIdsSha256: sha(
    rows
      .filter((r) => ['test', 'eval'].includes(r.split))
      .map((r) => r.sample.id)
      .join('\n'),
  ),
  results,
};
writeFileSync(`${output}.json`, JSON.stringify(report, null, 2) + '\n');
const pct = (n: number) => (100 * n).toFixed(1);
writeFileSync(
  `${output}.md`,
  '# 난이도 분류기 고정 평가 비교\n\n기반 임베딩과 CPU 전처리를 유지했다. 후보 선택은 검증 분할에서 끝내고, 아래 표본은 최종 비교에만 사용했다. 공개 데이터의 난이도 대리 라벨과 작성한 합성 시나리오의 라벨 일치율이며 실제 작업 성공률이 아니다. 합성 시나리오는 독립적인 사람 검수를 받지 않았다.\n\n| 평가 | n | 기존 정확도 | 후보 정확도 | 차이 (%p) | 그룹 bootstrap 95% 구간 (%p) | 기존 F1 | 후보 F1 | 기존 수준 오차 | 후보 수준 오차 |\n|---|---:|---:|---:|---:|---|---:|---:|---:|---:|\n' +
    results
      .map(
        (r) =>
          `| ${r.name} | ${r.baseline.n} | ${pct(r.baseline.accuracy)}% | ${pct(r.candidate.accuracy)}% | ${((r.candidate.accuracy - r.baseline.accuracy) * 100).toFixed(1)} | ${r.accuracyDelta95.map((v) => v!.toFixed(1)).join(' ~ ')} | ${r.baseline.macroF1.toFixed(3)} | ${r.candidate.macroF1.toFixed(3)} | ${r.baseline.levelError.toFixed(3)} | ${r.candidate.levelError.toFixed(3)} |`,
      )
      .join('\n') +
    `\n\n원본 표본 SHA256: \`${first.info.samplesSha256}\`. 전체 지표·혼동행렬·보류율과 가중치 해시는 동명 JSON에 기록한다.\n\nSWE-bench Verified는 원본 라벨 매핑 기준선을 정할 때 참조한 자료이므로 완전히 독립적인 외부 평가로 해석하지 않는다.\n`,
);
console.log(JSON.stringify(results, null, 2));
