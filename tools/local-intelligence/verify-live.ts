// Opt-in local CPU verification. Uses an already installed bundle; no downloads or paid APIs.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MeetingSelectionInput } from '../../packages/contracts/src/index.ts';
import { createLocalIntelligence } from '../../packages/local-intelligence/src/index.ts';

const [work, root, output] = process.argv.slice(2);
if (!work || !root || !output)
  throw new Error('usage: verify-live.ts <experiment-dir> <installed-local-ai-dir> <report.json>');
const local = createLocalIntelligence({ root, device: 'cpu' });
const lines = (name: string) =>
  readFileSync(join(work, name), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
const ms: number[] = [];
try {
  await local.engine.warmUp();
  for (const sample of lines('meeting-cases.jsonl')) {
    if (sample.split !== 'test') continue;
    const start = performance.now();
    await local.meeting.select(sample.input as MeetingSelectionInput);
    ms.push(performance.now() - start);
  }
  ms.sort((a, b) => a - b);
  const result = {
    device: local.engine.status().actualDevice,
    mode: 'warm shared local CPU engine; three-participant authored meetings',
    meeting: {
      matched: ms.length,
      p50Ms: ms[Math.floor(ms.length * 0.5)],
      p95Ms: ms[Math.floor(ms.length * 0.95)],
      maxMs: ms.at(-1),
    },
  };
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
} finally {
  await local.close();
}
