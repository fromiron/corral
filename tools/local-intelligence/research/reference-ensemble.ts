// Offline replay of the published, frozen PR180 EG2 five-head reference; no fitting or outcomes.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EFFORT_LEVELS } from '../../../packages/contracts/src/decisions.ts';
import {
  builtHelperPath,
  bundleDir,
  bundledManifest,
  createLocalIntelligence,
  EFFORT_PREPROCESS_VERSION,
  loadEffortClassifier,
  runtimeTarget,
} from '../../../packages/local-intelligence/src/index.ts';
import { effortBaselineInput } from './baseline-inputs.ts';

export const REFERENCE_ARCHIVE_SHA256 =
  '6752a50618956d459a03f27f8eb8183f7c8166689a9c0fc92cc1822b49fa283d';
export const REFERENCE_BUNDLE_SHA256 =
  '9e66797ad6df3761ff1d826d5fc2db1ac5b14c2c0b7369436ac1e0efa97e27f4';
const INPUT_SHA256 = '67c1507656ee97d34df4b784d11c222ceeebd828c15230548b160f7f472b997d';
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

/** No calibration is invented: the artifact explicitly specifies arithmetic probability mean. */
export function meanProbabilities(members: number[][]) {
  if (
    members.length !== 5 ||
    members.some(
      (row) =>
        row.length !== 4 ||
        row.some((p) => !Number.isFinite(p) || p < 0 || p > 1) ||
        Math.abs(row.reduce((sum, p) => sum + p, 0) - 1) > 1e-10,
    )
  )
    throw new Error('reference requires five four-way probability distributions');
  return EFFORT_LEVELS.map((_, i) => members.reduce((sum, row) => sum + (row[i] ?? 0), 0) / 5);
}

async function fileHash(path: string) {
  const hash = createHash('sha256');
  const handle = await open(path, 'r');
  try {
    for await (const bytes of handle.createReadStream()) hash.update(bytes);
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

async function main() {
  const [artifact, input, installed, output] = process.argv.slice(2);
  if (!artifact || !input || !installed || !output)
    throw new Error('artifact JSON, development input, installed root, and output required');
  if (existsSync(output)) throw new Error('reference output already exists');
  for (let at = dirname(resolve(output)); ; at = dirname(at)) {
    if (existsSync(join(at, '.git'))) throw new Error('reference evidence must remain private');
    if (at === dirname(at)) break;
  }
  const artifactBytes = readFileSync(artifact);
  if (sha(artifactBytes) !== REFERENCE_BUNDLE_SHA256)
    throw new Error('reference artifact differs from frozen archive');
  const source = JSON.parse(artifactBytes.toString());
  const bundle = bundledManifest();
  if (bundle.embedding.maxInputTokens !== 256) throw new Error('reference requires native 256');
  const heads = source.bundles.map((head: unknown) =>
    loadEffortClassifier(head, {
      dims: bundle.embedding.dims,
      baseModelSha256: bundle.model.sha256,
      preprocessVersion: EFFORT_PREPROCESS_VERSION,
    }),
  );
  const inputBytes = readFileSync(input);
  if (sha(inputBytes) !== INPUT_SHA256) throw new Error('only frozen development59 is authorized');
  const rows = inputBytes
    .toString()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  if (rows.length !== 59 || rows.some((r) => r.task !== 'effort' || r.split !== 'policy'))
    throw new Error('unexpected development input cohort');
  const views = rows.map((row) => {
    const view = effortBaselineInput(row);
    if (view.source !== 'runtimeView.legacyText') throw new Error('explicit Core view required');
    return view;
  });
  const target = runtimeTarget(bundle, process.platform, process.arch);
  const helper = builtHelperPath();
  if (!target || !helper) throw new Error('native CPU helper unavailable');
  const directory = bundleDir(installed, bundle);
  const runtime = bundle.runtime.targets[target];
  if (!runtime) throw new Error('native runtime unavailable');
  const runtimeHashes: Record<string, string> = {};
  for (const [name, pinned] of Object.entries({
    [bundle.model.file]: bundle.model,
    ...runtime.files,
  })) {
    const actual = await fileHash(join(directory, name));
    if (actual !== pinned.sha256) throw new Error('installed native artifact hash mismatch');
    runtimeHashes[name] = actual;
  }
  const ai = createLocalIntelligence({ root: installed, device: 'cpu', env: {} });
  const predictions = [];
  const began = performance.now();
  let warmupMilliseconds = 0;
  try {
    const start = performance.now();
    await ai.effort.warmUp();
    warmupMilliseconds = performance.now() - start;
    if (ai.engine.status().actualDevice !== 'cpu') throw new Error('reference requires CPU');
    for (const [index, row] of rows.entries()) {
      const view = views[index];
      if (!view) throw new Error('development view missing');
      const start = performance.now();
      const [vector] = await ai.engine.embed({
        texts: [view.text],
        task: 'classification',
        overflow: 'truncate',
        priority: 'effort',
      });
      if (!vector?.every(Number.isFinite)) throw new Error('invalid native embedding');
      const memberProbabilities = heads.map((head: ReturnType<typeof loadEffortClassifier>) => {
        const judgment = head.judge(vector);
        return EFFORT_LEVELS.map((label) => judgment.probabilities[label]);
      });
      const mean = meanProbabilities(memberProbabilities);
      predictions.push({
        id: row.id,
        task: 'effort',
        raw: EFFORT_LEVELS[mean.indexOf(Math.max(...mean))],
        probabilities: Object.fromEntries(EFFORT_LEVELS.map((level, i) => [level, mean[i]])),
        memberProbabilities,
        calibrationApplied: false,
        inputView: view.source,
        inputTextSha256: sha(view.text),
        embeddingSha256: sha(new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength)),
        milliseconds: performance.now() - start,
      });
    }
  } finally {
    await ai.close();
  }
  const sources = [
    'reference-ensemble.ts',
    'baseline-inputs.ts',
    '../../../packages/local-intelligence/src/effort/classifier.ts',
    '../../../packages/local-intelligence/src/engine/engine.ts',
    '../../../packages/core/src/reasoning-risk.ts',
    '../effort/train-v2.py',
  ].map((path) => ({ path, sha256: sha(readFileSync(new URL(path, import.meta.url))) }));
  writeFileSync(
    output,
    JSON.stringify(
      {
        protocol: 'frozen-pr180-eg2-five-head-reference-v1',
        archiveUrl:
          'https://github.com/user-attachments/files/34227867/effort-v3-artifacts-2026-10-31.zip',
        archiveSha256: REFERENCE_ARCHIVE_SHA256,
        bundleSha256: REFERENCE_BUNDLE_SHA256,
        inputSha256: INPUT_SHA256,
        manifest: source.manifest,
        native: {
          release: bundle.release,
          maxInputTokens: 256,
          runtimeHashes,
          helperSha256: await fileHash(helper),
          device: 'cpu',
        },
        sources,
        inference:
          'Existing schema-v2 classifier: folded input scaler, ReLU64, four-way softmax; arithmetic mean of five member probabilities. No new normalization, training or fitting.',
        calibrationStatus:
          'Unresolved: manifest gives T=0.603 and abstainBelow=0.303 but archive omits the exact ensemble temperature transform/clipping formula. Raw means and argmax only; no applied-policy claim.',
        scope:
          'Frozen input-only CoreV3 development59; no evaluated worker outcomes, H, or final fixture data read.',
        timing: { warmupMilliseconds, totalMilliseconds: performance.now() - began },
        predictions,
      },
      null,
      2,
    ),
    { mode: 0o600, flag: 'wx' },
  );
  console.log(
    JSON.stringify({
      predictions: predictions.length,
      calibrationApplied: false,
      outputSha256: await fileHash(output),
    }),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
