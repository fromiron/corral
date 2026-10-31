import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import type { MeetingSelectionInput } from '../../../packages/contracts/src/index.ts';
import {
  loadMeetingWeights,
  selectMeetingVectors,
} from '../../../packages/local-intelligence/src/meeting/selector.ts';

const [path, vectorPath, weightsPath, out] = process.argv.slice(2);
if (!path || !vectorPath || !weightsPath || !out)
  throw new Error('usage: compare.ts <cases.jsonl> <vectors.json> <weights.json> <out-base>');
const raw = readFileSync(path),
  data = JSON.parse(readFileSync(vectorPath, 'utf8'));
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
if (data.samplesSha256 !== sha(raw) || data.device !== 'cpu')
  throw new Error('evaluation input changed');
const rawWeights = readFileSync(weightsPath),
  weights = loadMeetingWeights(JSON.parse(rawWeights.toString()), data);
const cases = raw
  .toString()
  .trim()
  .split('\n')
  .map(
    (line) =>
      JSON.parse(line) as {
        id: string;
        split: string;
        kind: string;
        wanted: string[];
        input: MeetingSelectionInput;
      },
  );
const results = cases.flatMap((c, i) => {
  if (c.split !== 'test') return [];
  const vectors = (data.vectors[i] as number[][]).map((v) => Float32Array.from(v));
  const all = c.input.participants.map((p) => p.participantId);
  const scores = c.input.participants.map((_, n) =>
    Math.max(
      ...[vectors[n + 1]!, vectors[n + 1 + all.length]!].map((v) =>
        v.reduce((sum, x, j) => sum + x * vectors[0]![j]!, 0),
      ),
    ),
  );
  return [
    {
      ...c,
      predictions: [
        all,
        [all[scores.indexOf(Math.max(...scores))]!],
        selectMeetingVectors(c.input, vectors, weights) ?? all,
      ],
    },
  ];
});
const measure = (rows: typeof results, model: number) => {
  let exact = 0,
    precision = 0,
    recall = 0;
  for (const row of rows) {
    const p = row.predictions[model]!,
      correct = p.filter((id) => row.wanted.includes(id)).length;
    exact += Number(p.length === row.wanted.length && correct === p.length);
    precision += correct / p.length;
    recall += correct / row.wanted.length;
  }
  return {
    n: rows.length,
    exact: exact / rows.length,
    precision: precision / rows.length,
    recall: recall / rows.length,
  };
};
const summary = ['전체', ...new Set(results.map((r) => r.kind))].map((kind) => {
  const selected = kind === '전체' ? results : results.filter((r) => r.kind === kind);
  return {
    kind,
    baseline: measure(selected, 0),
    cosine: measure(selected, 1),
    learned: measure(selected, 2),
  };
});
const report = {
  samplesSha256: data.samplesSha256,
  weightsSha256: sha(JSON.stringify(JSON.parse(rawWeights.toString()))),
  summary,
  cases: results.map(({ id, wanted, predictions }) => ({ id, wanted, predictions })),
};
writeFileSync(`${out}.json`, JSON.stringify(report, null, 2) + '\n');
writeFileSync(
  `${out}.md`,
  '# 회의 응답자 선택 고정 평가\n\n작성한 합성 대화의 주제별 고정 테스트 분할이다. 실제 사용자 대화나 사람 검수의 정확도가 아니다. 기존 전체 참가자 응답, 학습 없는 코사인 유사도 1명 선택, 학습 선택기를 같은 대화로 비교한다. 이름으로 모델 능력을 추정하지 않는다.\n\n| 유형 | n | 기존 집합 일치 | 유사도 1명 | 학습 집합 일치 | 학습 정밀도 | 학습 재현율 |\n|---|---:|---:|---:|---:|---:|---:|\n' +
    summary
      .map(
        (r) =>
          `| ${r.kind} | ${r.learned.n} | ${(r.baseline.exact * 100).toFixed(1)}% | ${(r.cosine.exact * 100).toFixed(1)}% | ${(r.learned.exact * 100).toFixed(1)}% | ${(r.learned.precision * 100).toFixed(1)}% | ${(r.learned.recall * 100).toFixed(1)}% |`,
      )
      .join('\n') +
    '\n',
);
console.log(JSON.stringify(summary, null, 2));
