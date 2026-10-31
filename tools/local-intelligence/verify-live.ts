// Opt-in local CPU verification. Uses an already installed bundle; no downloads or paid APIs.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MeetingSelectionInput, ReasoningInput } from '../../packages/contracts/src/index.ts';
import {
  bundledEffortWeights,
  bundledMeetingWeights,
  createLocalIntelligence,
  loadEffortClassifier,
  loadMeetingWeights,
  requestInput,
  selectMeetingVectors,
} from '../../packages/local-intelligence/src/index.ts';

const [work, root, output] = process.argv.slice(2);
if (!work || !root || !output)
  throw new Error('usage: verify-live.ts <experiment-dir> <installed-local-ai-dir> <report.json>');
const local = createLocalIntelligence({ root, device: 'cpu' });
const never = { aborted: false, onCancel: () => () => {} };
const read = (name: string) => JSON.parse(readFileSync(join(work, name), 'utf8'));
const lines = (name: string) =>
  readFileSync(join(work, name), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
const effortInfo = read('curriculum-cpu.f32.json');
const effortHead = loadEffortClassifier(bundledEffortWeights(), effortInfo);
const bytes = readFileSync(join(work, 'curriculum-cpu.f32'));
const effortVectors = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
const meetingData = read('meeting-vectors.json');
const meetingHead = loadMeetingWeights(bundledMeetingWeights(), meetingData);
const ms = { effort: [] as number[], meeting: [] as number[] };
try {
  await local.engine.warmUp();
  for (const [n, sample] of lines('curriculum.jsonl').entries()) {
    if (sample.split !== 'test') continue;
    const input = (sample.input as ReasoningInput | undefined) ?? requestInput(sample.request);
    const expected = effortHead.judge(
      effortVectors.subarray(n * effortInfo.dims, (n + 1) * effortInfo.dims),
    );
    const start = performance.now();
    const actual = await local.effort.decideRequest(input, never);
    ms.effort.push(performance.now() - start);
    if (actual.answer !== expected.answer || actual.abstain !== expected.abstain)
      throw new Error('live effort decision differs from frozen CPU evaluation');
  }
  for (const [n, sample] of lines('meeting-cases.jsonl').entries()) {
    if (sample.split !== 'test') continue;
    const input = sample.input as MeetingSelectionInput;
    const expected = selectMeetingVectors(
      input,
      meetingData.vectors[n].map((v: number[]) => Float32Array.from(v)),
      meetingHead,
    );
    const start = performance.now();
    const actual = await local.meeting.select(input);
    ms.meeting.push(performance.now() - start);
    if (JSON.stringify(actual?.toSorted() ?? null) !== JSON.stringify(expected?.toSorted() ?? null))
      throw new Error('live meeting selection differs from frozen CPU evaluation');
  }
  const summary = Object.fromEntries(
    Object.entries(ms).map(([kind, values]) => {
      values.sort((a, b) => a - b);
      return [
        kind,
        {
          matched: values.length,
          p50Ms: values[Math.floor(values.length * 0.5)],
          p95Ms: values[Math.floor(values.length * 0.95)],
          maxMs: values.at(-1),
        },
      ];
    }),
  );
  const digest = (value: unknown) =>
    createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const result = {
    device: local.engine.status().actualDevice,
    mode: 'warm shared local CPU engine; three-participant authored meetings',
    effortWeightsSha256: digest(bundledEffortWeights()),
    meetingWeightsSha256: digest(bundledMeetingWeights()),
    ...summary,
  };
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally {
  await local.close();
}
