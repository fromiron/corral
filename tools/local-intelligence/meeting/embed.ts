import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import type { MeetingSelectionInput } from '../../../packages/contracts/src/index.ts';
import {
  builtHelperPath,
  bundledManifest,
  cpuThreads,
  LocalEmbeddingEngine,
  runtimeTarget,
} from '../../../packages/local-intelligence/src/index.ts';
import {
  MEETING_PREPROCESS_VERSION,
  meetingTexts,
} from '../../../packages/local-intelligence/src/meeting/selector.ts';

const [path, root, out] = process.argv.slice(2);
if (!path || !root || !out)
  throw new Error('usage: embed.ts <cases.jsonl> <local-ai-dir> <out.json>');
const raw = readFileSync(path);
const cases = raw
  .toString()
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line) as { input: MeetingSelectionInput });
const bundle = bundledManifest();
const engine = new LocalEmbeddingEngine({
  root,
  bundle,
  target: runtimeTarget(bundle, process.platform, process.arch),
  helperPath: builtHelperPath(),
  threads: cpuThreads(process.arch, availableParallelism()),
  device: 'cpu',
});
const vectors: number[][][] = [];
try {
  for (const [n, item] of cases.entries()) {
    const rows: number[][] = [];
    for (const text of meetingTexts(item.input)) {
      const vector = text
        ? (
            await engine.embed({
              texts: [text],
              task: 'classification',
              priority: 'meeting',
              overflow: 'truncate',
            })
          )[0]
        : new Float32Array(bundle.embedding.dims);
      if (!vector) throw new Error('missing embedding');
      rows.push(Array.from(vector));
    }
    vectors.push(rows);
    if ((n + 1) % 50 === 0) console.error(`${n + 1}/${cases.length}`);
  }
} finally {
  await engine.close();
}
writeFileSync(
  out,
  JSON.stringify({
    samplesSha256: createHash('sha256').update(raw).digest('hex'),
    baseModelSha256: bundle.model.sha256,
    dims: bundle.embedding.dims,
    preprocessVersion: MEETING_PREPROCESS_VERSION,
    device: 'cpu',
    vectors,
  }),
);
