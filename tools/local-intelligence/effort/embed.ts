// Embeds the effort sample through the product engine and preprocessing, so the classifier is
// trained on the same vectors Corral computes for a request at run time.
//
//   node tools/local-intelligence/effort/embed.ts <samples.jsonl> <local-ai-dir> <cpu|gpu> <out.f32>
//
// <local-ai-dir> holds the installed bundle (`corral local-ai install --data-dir <dir>`). The
// vectors are written in sample order as float32; <out.f32>.json records what produced them.
import { createHash } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import type { ReasoningInput } from '../../../packages/contracts/src/index.ts';
import {
  builtHelperPath,
  bundledManifest,
  cpuThreads,
  EFFORT_PREPROCESS_VERSION,
  effortRequest,
  LocalEmbeddingEngine,
  requestInput,
  runtimeTarget,
  spawnHelper,
} from '../../../packages/local-intelligence/src/index.ts';

export interface EmbeddingInfo {
  release: string;
  baseModelSha256: string;
  preprocessVersion: string;
  device: string;
  count: number;
  dims: number;
  samplesSha256: string;
}

const [samplesPath, root, device, out] = process.argv.slice(2);
if (!samplesPath || !root || (device !== 'cpu' && device !== 'gpu') || !out) {
  console.error('usage: embed.ts <samples.jsonl> <local-ai-dir> <cpu|gpu> <out.f32>');
  process.exit(2);
}

const raw = readFileSync(samplesPath);
const samples = raw
  .toString('utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line) as { request: string; input?: ReasoningInput });
const bundle = bundledManifest();
const dims = bundle.embedding.dims;
const engine = new LocalEmbeddingEngine({
  root,
  bundle,
  target: runtimeTarget(bundle, process.platform, process.arch),
  helperPath: process.env.CORRAL_LOCAL_AI_HELPER ?? builtHelperPath(),
  launch: spawnHelper,
  threads: cpuThreads(process.arch, availableParallelism()),
  device,
});
const vectors = new Float32Array(samples.length * dims);
const started = performance.now();
let actualDevice: string | null = null;
try {
  for (const [index, sample] of samples.entries()) {
    const [vector] = await engine.embed(
      effortRequest(sample.input ?? requestInput(sample.request)),
    );
    vectors.set(vector!, index * dims);
    if ((index + 1) % 500 === 0)
      console.error(
        `${index + 1}/${samples.length} ${((performance.now() - started) / 1000).toFixed(0)} s`,
      );
  }
  actualDevice = engine.status().actualDevice;
} finally {
  await engine.close();
}
if (actualDevice !== device) throw new Error(`embedded on ${actualDevice}, not ${device}`);

writeFileSync(`${out}.part`, new Uint8Array(vectors.buffer));
renameSync(`${out}.part`, out);
const info: EmbeddingInfo = {
  release: bundle.release,
  baseModelSha256: bundle.model.sha256,
  preprocessVersion: EFFORT_PREPROCESS_VERSION,
  device,
  count: samples.length,
  dims,
  samplesSha256: createHash('sha256').update(raw).digest('hex'),
};
writeFileSync(`${out}.json`, `${JSON.stringify(info, null, 2)}\n`);
console.error(
  `${samples.length} vectors in ${((performance.now() - started) / 1000).toFixed(0)} s`,
);
