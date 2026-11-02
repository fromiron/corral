/** Input-only bridge to tribgames/mixdog, Apache-2.0, Copyright (c) 2026 tribgames.
 * Upstream modules/license/notices remain in the private pinned checkout, outside Git.
 * No formatter or compact-tokenizer implementation is copied into this repository.
 */
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { runInNewContext } from 'node:vm';
import type { ReasoningInput } from '../../../packages/contracts/src/reasoning.ts';
import type { EffortInput } from '../../../packages/local-intelligence/src/decision/text.ts';
import { requiresExposure } from './evaluation-input.ts';

export const UPSTREAM_COMMIT = '7e6abe16b9ed9c0947661d843d64b96e5b22d981';
const BLOBS: Record<string, string> = {
  'src/runtime/effort-judge/judge-input.mjs': 'e277f15a2e1b127aacb6c828a3e597d7dec84f9f',
  'src/runtime/effort-judge/compact-tokenizer.mjs': 'bc3f81d5a2802bf0fd9df04fa343f3fc9e8a6fc0',
  'src/runtime/effort-judge/judge-worker.mjs': '3178ebd6929f4f624fde336ff407f0d87fd6a5eb',
  'src/runtime/effort-judge/model-manifest.json': '34e5221fa820fbf4ac86b8bb3e2e2a2dc95daee6',
  'src/runtime/shared/atomic-file.mjs': '13b0ad45c8030d0ac5c52c552c76dfc6cb92d203',
  'src/runtime/shared/file-lock.mjs': '09a2363299c06ba243cf57fb7d0660509332c224',
  'src/runtime/shared/file-permissions.mjs': '39af6068b692707cf0ccf7f64b199b3592bff46b',
  'src/runtime/shared/sleep.mjs': 'e39518e4bfb74fb1381f7dc6cca0db717557184b',
  'src/runtime/shared/keyed-serial-queue.mjs': 'd5ab1766a33e059c02146640aabba6ab7b32c7c5',
  LICENSE: '89ff06d7096963d1f645b20dfc967cbac76a9b54',
  'NOTICE.md': '8755e9b872c691841f94bf32bfca680f892fe821',
  'package.json': '32ad7061ef8dae14a9646297a66405ae1074bfe1',
};
const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
interface Step {
  request: string;
  step: number;
  plan: string;
  calls: { name: string; args: string; result: string }[];
}
interface WorkerInput {
  request: string;
  prev: string;
  prevRequest: string;
  step?: Step;
}
interface CompactTokenizer {
  prefix: number[];
  suffix: number[];
  encode(text: string): number[];
}
interface ReferenceRuntime {
  tokenizer: CompactTokenizer;
  inputIds(
    tokenizer: CompactTokenizer,
    format: string,
    limit: number,
    input: WorkerInput,
  ): number[];
  judgeText(format: string, request: string, prev: string, prevRequest: string): string;
  stepJudgeText(input: Step): string;
}
interface SourceRow {
  task: 'effort';
  split?: string;
  input?: EffortInput;
  coreReasoningInput?: ReasoningInput;
}

/** A supplied Core copy wins. Synthetic C/P has no observed step number: use explicit 1. */
export function referenceInput(row: SourceRow, unsealFinal = false) {
  if (row.task !== 'effort' || (row.split === 'final' && !unsealFinal))
    throw new Error('reference input is unsupported or sealed');
  const core = row.coreReasoningInput;
  const source = core ? undefined : row.input;
  const kind = core?.kind ?? source?.stage;
  if (kind !== 'turn' && kind !== 'step') throw new Error('reference requires a turn or step');
  const request = core ? core.request : [source?.goal, source?.request].filter(Boolean).join('\n');
  if (typeof request !== 'string' || (!core && typeof source?.request !== 'string'))
    throw new Error('reference request is missing');
  const value: WorkerInput = {
    request,
    prev: core?.prev ?? source?.previousReply ?? '',
    prevRequest: core?.prevRequest ?? source?.previousRequest ?? '',
  };
  if (kind === 'step')
    value.step = {
      request,
      step: core?.step ?? 1,
      plan: core?.plan ?? source?.plan ?? '',
      calls: core
        ? core.calls.map((call) => ({ name: call.name, args: call.args, result: call.result }))
        : (source?.tools ?? []).map((tool) => ({
            name: tool.name,
            args: tool.args ?? '',
            result: tool.content,
          })),
    };
  return {
    value,
    kind,
    view: core ? 'coreReasoningInput' : 'synthetic-input',
    stepNumberSource: kind === 'turn' ? 'not-applicable' : core ? 'core' : 'assumed-one',
  };
}

export function prepareRecord(
  row: SourceRow & { id: string; group: string },
  runtime: ReferenceRuntime,
  unsealFinal = false,
) {
  const input = referenceInput(row, unsealFinal);
  const start = performance.now();
  // Execute the exact pinned worker's inputIds, including its UTF-16 rp branch.
  const tokenIds = Array.from(runtime.inputIds(runtime.tokenizer, 'rp', 256, input.value));
  const formattedText = input.value.step
    ? runtime.stepJudgeText(input.value.step)
    : runtime.judgeText('rp', input.value.request, input.value.prev, input.value.prevRequest);
  if (
    tokenIds.length > 256 ||
    tokenIds.length < 2 ||
    tokenIds.some((id) => !Number.isSafeInteger(id) || id < 0)
  )
    throw new Error('reference token IDs are invalid');
  return {
    id: row.id,
    group: row.group,
    ...(row.split === 'final' ? { split: 'final' as const } : {}),
    kind: input.kind,
    view: input.view,
    stepNumberSource: input.stepNumberSource,
    tokenIds,
    formattedText,
    // Compact's TextEncoder replaces unpaired UTF-16 surrogates when encoding bytes.
    hfDiagnosticText: Buffer.from(formattedText, 'utf8').toString('utf8'),
    preparationMs: performance.now() - start,
  };
}

export async function loadPinnedUpstream(directory: string) {
  const root = realpathSync(directory);
  const sources = Object.entries(BLOBS).map(([path, blob]) => {
    const bytes = readFileSync(join(root, path));
    const actual = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if (actual !== blob) throw new Error('upstream source blob differs from pin');
    return { path, blob, sha256: sha(bytes), bytes: bytes.length };
  });
  const path = join(root, 'src/runtime/effort-judge');
  const formatter = await import(pathToFileURL(join(path, 'judge-input.mjs')).href);
  const tokenizer = await import(pathToFileURL(join(path, 'compact-tokenizer.mjs')).href);
  const worker = readFileSync(join(path, 'judge-worker.mjs'), 'utf8');
  const start = worker.indexOf('function judgeText(');
  const end = worker.indexOf('\nfunction feeds(');
  if (start < 0 || end <= start) throw new Error('pinned worker function boundary differs');
  // Evaluate only its pure formatter/ID functions, avoiding worker startup and ORT loading.
  const functions = runInNewContext(
    `${worker.slice(start, end)}\n({judgeText,inputIds})`,
    {
      judgeInputClean: formatter.judgeInputClean,
      packJudgeIds: formatter.packJudgeIds,
      stepJudgeText: formatter.stepJudgeText,
    },
    { timeout: 1000 },
  ) as Pick<ReferenceRuntime, 'inputIds' | 'judgeText'>;
  return {
    ...functions,
    stepJudgeText: formatter.stepJudgeText as ReferenceRuntime['stepJudgeText'],
    loadTokenizer: tokenizer.loadCompactTokenizer as (directory: string) => CompactTokenizer,
    sources,
    manifest: JSON.parse(readFileSync(join(path, 'model-manifest.json'), 'utf8')),
    originalOrtVersion: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).dependencies[
      'onnxruntime-node'
    ] as string,
  };
}

function privatePath(path: string) {
  let at = dirname(path);
  while (!existsSync(at)) at = dirname(at);
  at = realpathSync(at);
  for (;;) {
    if (existsSync(join(at, '.git')))
      throw new Error('reference artifacts must stay outside a repository');
    if (at === dirname(at)) return;
    at = dirname(at);
  }
}

/** Authorization metadata only; row labels and worker artifacts are never read. */
export function recordFinalExposure(
  rows: { split?: string }[],
  output: string,
  unsealFinal: boolean,
  identity: Record<string, unknown>,
) {
  const final = requiresExposure(
    rows.map((row) => ({ split: row.split ?? '' })),
    unsealFinal,
  );
  if (final) {
    privatePath(output);
    mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
    writeFileSync(
      `${output}.exposure.json`,
      JSON.stringify(
        {
          at: new Date().toISOString(),
          scope: 'final reference input preparation only',
          unsealFinal: true,
          workerOutcomesRead: false,
          ...identity,
        },
        null,
        2,
      ),
      { flag: 'wx', mode: 0o600 },
    );
  }
  return final;
}

export async function prepareReference(options: {
  upstream: string;
  assets: string;
  copy: string;
  input: string;
  out: string;
  unsealFinal?: boolean;
}) {
  const started = performance.now();
  const sourceDir = realpathSync(options.assets);
  const copyDir = resolve(options.copy);
  const out = resolve(options.out);
  privatePath(copyDir);
  privatePath(out);
  if (existsSync(out)) throw new Error('reference output must be new');
  mkdirSync(copyDir, { recursive: true, mode: 0o700 });
  const fromSource = relative(sourceDir, realpathSync(copyDir));
  if (fromSource === '' || !fromSource.startsWith('..'))
    throw new Error('cache copy must be outside source assets');
  const upstream = await loadPinnedUpstream(options.upstream);
  const assets = [];
  for (const name of ['model.onnx', 'tokenizer.json', 'calibration.json']) {
    const original = join(sourceDir, name);
    const target = join(copyDir, name);
    const bytes = readFileSync(original);
    const checksum = sha(bytes);
    const expected = upstream.manifest.files[name];
    if (checksum !== expected.sha256 || bytes.length !== expected.size)
      throw new Error('user asset differs from pinned release');
    if (!existsSync(target)) copyFileSync(original, target);
    if (sha(readFileSync(target)) !== checksum)
      throw new Error('private copy differs from user asset');
    assets.push({
      name,
      sha256: checksum,
      bytes: bytes.length,
      sourceMtimeMs: statSync(original).mtimeMs,
    });
  }
  const calibration = JSON.parse(readFileSync(join(copyDir, 'calibration.json'), 'utf8'));
  if (
    calibration.inputFormat !== 'rp' ||
    calibration.temperature !== 1.55 ||
    calibration.maxTokens !== 256 ||
    calibration.steps !== 1
  )
    throw new Error('supplied reference calibration differs');
  const sourceBytes = readFileSync(options.input);
  const allRows = sourceBytes
    .toString('utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  const rows = allRows.filter((row) => row.task === 'effort');
  if (!rows.length) throw new Error('reference source has no effort inputs');
  const finalInputPresent = recordFinalExposure(allRows, out, options.unsealFinal ?? false, {
    inputSha256: sha(sourceBytes),
    upstreamCommit: UPSTREAM_COMMIT,
    sourceSha256: sha(readFileSync(new URL(import.meta.url))),
    upstreamSources: upstream.sources,
    assets,
    calibration,
    rowCount: rows.length,
  });
  const cacheExisted = existsSync(join(copyDir, 'tokenizer.bin'));
  const tokenizerStart = performance.now();
  const tokenizer = upstream.loadTokenizer(copyDir);
  const tokenizerInitMs = performance.now() - tokenizerStart;
  const runtime = { ...upstream, tokenizer };
  const warmupIds = Array.from(
    upstream.inputIds(tokenizer, 'rp', 256, { request: 'warm up', prev: '', prevRequest: '' }),
  );
  const records = rows.map((row) => prepareRecord(row, runtime, options.unsealFinal ?? false));
  for (const asset of assets) {
    const original = join(sourceDir, asset.name);
    if (
      sha(readFileSync(original)) !== asset.sha256 ||
      statSync(original).mtimeMs !== asset.sourceMtimeMs
    )
      throw new Error('source asset changed during preparation');
  }
  const metadata = {
    repository: 'tribgames/mixdog',
    upstreamCommit: UPSTREAM_COMMIT,
    sourceLicense: 'Apache-2.0',
    sourceCopyright: 'Copyright (c) 2026 tribgames',
    release: upstream.manifest.release,
    sources: upstream.sources,
    assets,
    calibration,
    sourceInputSha256: sha(sourceBytes),
    ...(finalInputPresent ? { finalInputPresent: true, finalUnsealExplicit: true } : {}),
    nodeVersion: process.version,
    originalOrtVersion: upstream.originalOrtVersion,
    compactTokenizerAuthority: true,
    prefix: tokenizer.prefix,
    suffix: tokenizer.suffix,
    tokenizerCacheSha256: sha(readFileSync(join(copyDir, 'tokenizer.bin'))),
    tokenizerCacheExisted: cacheExisted,
    tokenizerInitMs,
    syntheticStepAssumption: 'step 1 because synthetic input has no observed step count',
    developmentScope:
      'supplied Core copy of modeled completed reads; not an observed harness trace',
  };
  mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
  writeFileSync(out, JSON.stringify({ metadata, warmupIds, records }), { flag: 'wx', mode: 0o600 });
  return {
    count: records.length,
    turns: records.filter((r) => r.kind === 'turn').length,
    steps: records.filter((r) => r.kind === 'step').length,
    assumedStepOne: records.filter((r) => r.stepNumberSource === 'assumed-one').length,
    tokenizerInitMs,
    elapsedMs: performance.now() - started,
    outputSha256: sha(readFileSync(out)),
  };
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({
      options: {
        upstream: { type: 'string' },
        assets: { type: 'string' },
        copy: { type: 'string' },
        input: { type: 'string' },
        out: { type: 'string' },
        'unseal-final': { type: 'boolean', default: false },
      },
    });
    if (!values.upstream || !values.assets || !values.copy || !values.input || !values.out)
      throw new Error('required private paths are missing');
    console.log(
      JSON.stringify(
        await prepareReference({
          upstream: values.upstream,
          assets: values.assets,
          copy: values.copy,
          input: values.input,
          out: values.out,
          unsealFinal: values['unseal-final'],
        }),
      ),
    );
  } catch {
    console.error('reference input preparation failed; check pinned sources and private paths');
    process.exitCode = 1;
  }
}
