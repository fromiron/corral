// F-only structured effort embeddings through the installed, unchanged LiteRT CPU engine.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  builtHelperPath,
  bundleDir,
  bundledManifest,
  cpuThreads,
  createLocalIntelligence,
  runtimeTarget,
  TASK_PREFIX,
} from '../../../packages/local-intelligence/src/index.ts';
import { INPUT_VERSION, LEVELS } from './data.ts';

interface FitRow {
  id: string;
  group: string;
  split: 'fit';
  task: 'effort';
  inputVersion: string;
  text: string;
  target: { level: string; acceptableLevels: string[] };
}

export function fitEffortRows(input: unknown[]): FitRow[] {
  if (!input.length || input.some((row) => !row || (row as FitRow).split !== 'fit'))
    throw new Error('native feature extraction accepts F rows only');
  const rows = input.filter((row) => (row as FitRow).task === 'effort') as FitRow[];
  const ids = new Set<string>();
  for (const row of rows) {
    if (
      !row.id ||
      ids.has(row.id) ||
      typeof row.group !== 'string' ||
      !row.group.trim() ||
      row.inputVersion !== INPUT_VERSION ||
      typeof row.text !== 'string' ||
      !row.text.trim() ||
      !LEVELS.some((label) => label === row.target?.level) ||
      !Array.isArray(row.target.acceptableLevels) ||
      !row.target.acceptableLevels.includes(row.target.level)
    )
      throw new Error('invalid or duplicate structured F effort row');
    ids.add(row.id);
  }
  if (!rows.length) throw new Error('no F effort rows');
  return rows;
}

const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

async function fileHash(path: string): Promise<string> {
  const hash = createHash('sha256');
  const handle = await open(path, 'r');
  try {
    for await (const part of handle.createReadStream()) hash.update(part);
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

async function main() {
  const [input, installed, out] = process.argv.slice(2);
  if (!input || !installed || !out)
    throw new Error('fit.jsonl, installed root, output.f32 required');
  if ([out, `${out}.part`, `${out}.json`].some(existsSync))
    throw new Error('native cache already exists');
  const raw = readFileSync(input);
  const rows = fitEffortRows(
    raw
      .toString()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  );
  const bundle = structuredClone(bundledManifest());
  bundle.embedding.maxInputTokens = 1024;
  const target = runtimeTarget(bundle, process.platform, process.arch);
  const helper = builtHelperPath();
  if (!target || !helper) throw new Error('installed native CPU helper is unavailable');
  const dir = bundleDir(installed, bundle);
  if ((await fileHash(join(dir, bundle.model.file))) !== bundle.model.sha256)
    throw new Error('installed base model hash differs from shipped embedding');
  const runtimeHashes: Record<string, string> = {};
  const runtime = bundle.runtime.targets[target];
  if (!runtime) throw new Error('installed native CPU runtime is unavailable');
  for (const [name, pinned] of Object.entries(runtime.files)) {
    const digest = await fileHash(join(dir, name));
    if (digest !== pinned.sha256) throw new Error('installed native runtime hash mismatch');
    runtimeHashes[name] = digest;
  }
  const helperHash = await fileHash(helper);
  const ai = createLocalIntelligence({
    root: installed,
    bundle,
    device: 'cpu',
    logicalCores: 12,
    env: {},
  });
  const vectors = new Float32Array(rows.length * bundle.embedding.dims);
  const metadata: {
    id: string;
    group: string;
    textSha256: string;
    prefixedTextSha256: string;
    milliseconds: number;
  }[] = [];
  let warmupMilliseconds = 0;
  try {
    const start = performance.now();
    await ai.engine.embed({
      texts: ['Native feature extraction warm-up.'],
      task: 'classification',
      overflow: 'truncate',
      priority: 'effort',
    });
    warmupMilliseconds = performance.now() - start;
    if (ai.engine.status().actualDevice !== 'cpu')
      throw new Error('native feature extraction requires CPU');
    for (const [index, row] of rows.entries()) {
      const began = performance.now();
      const [vector] = await ai.engine.embed({
        texts: [row.text],
        task: 'classification',
        overflow: 'truncate',
        priority: 'effort',
      });
      if (!vector || vector.length !== bundle.embedding.dims || !vector.every(Number.isFinite))
        throw new Error('invalid native embedding');
      metadata.push({
        id: row.id,
        group: row.group,
        textSha256: sha(row.text),
        prefixedTextSha256: sha(TASK_PREFIX.classification + row.text),
        milliseconds: performance.now() - began,
      });
      vectors.set(vector, index * bundle.embedding.dims);
      if ((index + 1) % 100 === 0)
        console.log(JSON.stringify({ embedded: index + 1, total: rows.length }));
    }
  } finally {
    await ai.close();
  }
  mkdirSync(dirname(resolve(out)), { recursive: true, mode: 0o700 });
  const bytes = new Uint8Array(vectors.buffer);
  writeFileSync(`${out}.part`, bytes, { mode: 0o600, flag: 'wx' });
  renameSync(`${out}.part`, out);
  writeFileSync(
    `${out}.json`,
    JSON.stringify(
      {
        protocol: 'native-frozen-effort-F-v1',
        split: 'fit',
        task: 'effort',
        sourceSha256: sha(raw),
        vectorsSha256: sha(bytes),
        count: rows.length,
        dims: bundle.embedding.dims,
        baseModelSha256: bundle.model.sha256,
        release: bundle.release,
        runtimeVersion: bundle.runtime.version,
        runtimeHashes,
        helperSha256: helperHash,
        extractorSha256: sha(readFileSync(fileURLToPath(import.meta.url))),
        engineSha256: sha(
          readFileSync(
            new URL('../../../packages/local-intelligence/src/engine/engine.ts', import.meta.url),
          ),
        ),
        inputVersion: INPUT_VERSION,
        preprocessVersion: `${INPUT_VERSION}:native-litert:1024`,
        taskPrefix: TASK_PREFIX.classification,
        maxInputTokens: 1024,
        overflow: 'truncate',
        device: 'cpu',
        threads: cpuThreads(process.arch, 12),
        warmupMilliseconds,
        nativeTokenCounts: null,
        tokenCountNote: 'Product embedding helper does not expose native token counts.',
        timingScope:
          'raw resident native engine.embed calls, including cache lookup/IPC; excludes classifier and production total deadline; concurrent research jobs may contend',
        rows: metadata,
      },
      null,
      2,
    ),
    { mode: 0o600, flag: 'wx' },
  );
  console.log(JSON.stringify({ embedded: rows.length, complete: true, device: 'cpu' }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
