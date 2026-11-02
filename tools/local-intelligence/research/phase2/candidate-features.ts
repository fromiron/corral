// Offline label-free participant features; the shipped native model stays unchanged.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
} from '../../../../packages/local-intelligence/src/index.ts';
import { historyCosineReferences, meetingCosineInputs } from '../baseline-inputs.ts';
import type { MeetingInput } from '../data.ts';

export const FEATURE_VERSION = 'native-eg2-candidate-ranking-v1';
export const FEATURE_NAMES = [
  'nameRoleCosine',
  'nameCosine',
  'roleCosine',
  'ownHistoryMax',
  'ownHistoryMean',
  'ownHistoryLatest',
  'hasOwnHistory',
  'ownTurnFraction',
  'ownCharacterFraction',
  'ownReciprocalRecency',
  'isLatestTurnSpeaker',
  'isLatestRosterSpeaker',
] as const;
type Domain = 'natural' | 'synthetic';
interface FitRow {
  id: string;
  group: string;
  split: 'fit';
  task: 'meeting';
  input: MeetingInput;
  target: { mode: string; eligibleIds: string[]; excludedIds: string[] };
}
interface Manifest {
  status: string;
  groups: Record<string, string[]>;
  files: Record<string, { sha256: string }>;
}

export function frozenFitRows(
  rows: unknown[],
  actualHash: string,
  expectedHash: string,
  domain: Domain,
  manifest?: Manifest,
): FitRow[] {
  if (
    !/^[a-f0-9]{64}$/.test(expectedHash) ||
    actualHash !== expectedHash ||
    !rows.length ||
    rows.some((row) => (row as FitRow)?.split !== 'fit')
  )
    throw new Error('only exact pinned F inputs may be extracted');
  if (!['natural', 'synthetic'].includes(domain)) throw new Error('unknown source domain');
  if (domain === 'natural') {
    if (
      manifest?.status !== 'frozen-before-fitting' ||
      manifest.files['fit.raw.jsonl']?.sha256 !== actualHash
    )
      throw new Error('natural split must be frozen before extraction');
    const all = Object.values(manifest.groups).flat();
    const fitGroups = manifest.groups.fit;
    if (new Set(all).size !== all.length || !fitGroups?.length)
      throw new Error('frozen teams must have disjoint split membership');
    if (rows.some((row) => !fitGroups.includes((row as FitRow).group)))
      throw new Error('natural row belongs to another team partition');
  }
  const meetings = rows.filter((row) => (row as FitRow).task === 'meeting') as FitRow[];
  if (!meetings.length || new Set(meetings.map((row) => row.id)).size !== meetings.length)
    throw new Error('unique meeting F rows are required');
  for (const row of meetings) {
    const ids = row.input?.participants?.map((person) => person.id);
    if (
      !row.id ||
      !row.group ||
      !Array.isArray(ids) ||
      !ids.length ||
      new Set(ids).size !== ids.length ||
      !row.target ||
      !Array.isArray(row.target.eligibleIds) ||
      !Array.isArray(row.target.excludedIds) ||
      [...row.target.eligibleIds, ...row.target.excludedIds].some((id) => !ids.includes(id))
    )
      throw new Error('invalid meeting supervision or roster');
  }
  return meetings;
}

export async function candidateFeatures(
  input: MeetingInput,
  embed: (text: string) => Promise<Float32Array>,
) {
  const ids = input.participants.map((person) => person.id);
  const firstId = ids[0];
  if (
    !firstId ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !id) ||
    typeof input.message !== 'string'
  )
    throw new Error('unique nonempty roster and current message are required');
  const view = meetingCosineInputs(input);
  const turns = input.turns.slice(-12);
  const query = await embed(view.query);
  if (!query.length || !query.every(Number.isFinite)) throw new Error('invalid query embedding');
  const cosine = async (text: string) => {
    if (!text) return 0;
    const vector = await embed(text);
    if (vector.length !== query.length || !vector.every(Number.isFinite))
      throw new Error('invalid participant embedding');
    return vector.reduce((sum, value, index) => sum + value * Number(query[index]), 0);
  };
  const last = turns.findLast((turn) => turn.speakerId && ids.includes(turn.speakerId))?.speakerId;
  const totalCharacters = turns.reduce((sum, turn) => sum + Array.from(turn.text).length, 0);
  const candidates = [];
  for (const [index, person] of view.participants.entries()) {
    const roster = input.participants[index];
    if (!roster) throw new Error('visible participant roster changed during extraction');
    const combined = await cosine(person.role),
      name = await cosine(roster.name),
      role = await cosine(roster.role);
    const history = [];
    for (const text of person.history) history.push(await cosine(text));
    const own = turns.flatMap((turn, turnIndex) =>
      turn.speakerId === person.id ? [turnIndex] : [],
    );
    const latest = own.at(-1);
    const characters = turns
      .filter((turn) => turn.speakerId === person.id)
      .reduce((sum, turn) => sum + Array.from(turn.text).length, 0);
    const values = [
      combined,
      name,
      role,
      history.length ? Math.max(...history) : 0,
      history.length ? history.reduce((a, b) => a + b, 0) / history.length : 0,
      history.at(-1) ?? 0,
      Number(Boolean(history.length)),
      own.length / Math.max(1, turns.length),
      characters / Math.max(1, totalCharacters),
      latest === undefined ? 0 : 1 / (turns.length - latest),
      Number(latest !== undefined && latest === turns.length - 1),
      Number(last === person.id),
    ] as const;
    candidates.push({ id: person.id, values });
  }
  return {
    candidates,
    references: {
      last: [last ?? firstId],
      ...historyCosineReferences(
        ids,
        candidates.map((c) => c.values[0]),
        candidates.map((c) => c.values[3]),
      ),
    },
  };
}

const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function fileHash(path: string) {
  const handle = await open(path, 'r'),
    hash = createHash('sha256');
  try {
    for await (const part of handle.createReadStream()) hash.update(part);
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

async function main() {
  const [input, installed, out, domainArg, expectedHash, manifestPath] = process.argv.slice(2);
  if (
    !input ||
    !installed ||
    !out ||
    !domainArg ||
    !expectedHash ||
    !['natural', 'synthetic'].includes(domainArg)
  )
    throw new Error(
      'usage: input installed-root output.json natural|synthetic expected-input-sha [natural-manifest.json]',
    );
  const domain = domainArg as Domain;
  for (let directory = dirname(resolve(out)); ; directory = dirname(directory)) {
    if (existsSync(join(directory, '.git')))
      throw new Error('private embeddings and records must stay outside Git');
    if (dirname(directory) === directory) break;
  }
  if ([out, `${out}.vectors.f32`, `${out}.vectors.json`, `${out}.extraction.json`].some(existsSync))
    throw new Error('immutable extraction output already exists');
  const raw = readFileSync(input);
  const manifestRaw = manifestPath ? readFileSync(manifestPath) : null;
  const rows = frozenFitRows(
    raw
      .toString()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
    sha(raw),
    expectedHash,
    domain,
    manifestRaw ? JSON.parse(manifestRaw.toString()) : undefined,
  );
  const bundle = bundledManifest();
  if (bundle.embedding.maxInputTokens !== 256)
    throw new Error('this comparator requires the unchanged native256 budget');
  const target = runtimeTarget(bundle, process.platform, process.arch),
    helper = builtHelperPath();
  if (!target || !helper) throw new Error('installed native CPU helper unavailable');
  const directory = bundleDir(installed, bundle);
  if ((await fileHash(join(directory, bundle.model.file))) !== bundle.model.sha256)
    throw new Error('shipped base embedding bytes changed');
  const runtime = bundle.runtime.targets[target];
  if (!runtime) throw new Error('native runtime unavailable');
  const runtimeHashes: Record<string, string> = {};
  for (const [name, pin] of Object.entries(runtime.files)) {
    const digest = await fileHash(join(directory, name));
    if (digest !== pin.sha256) throw new Error('installed runtime hash mismatch');
    runtimeHashes[name] = digest;
  }
  const provenance = {
    protocol: FEATURE_VERSION,
    split: 'fit',
    domain,
    inputSha256: sha(raw),
    manifestSha256: manifestRaw ? sha(manifestRaw) : null,
    baseModelSha256: bundle.model.sha256,
    release: bundle.release,
    runtimeVersion: bundle.runtime.version,
    runtimeHashes,
    helperSha256: await fileHash(helper),
    extractorSha256: sha(readFileSync(fileURLToPath(import.meta.url))),
    engineSha256: sha(
      readFileSync(
        new URL('../../../../packages/local-intelligence/src/engine/engine.ts', import.meta.url),
      ),
    ),
    baselineInputsSha256: sha(readFileSync(new URL('../baseline-inputs.ts', import.meta.url))),
    maxInputTokens: 256,
    overflow: 'truncate',
    taskPrefix: TASK_PREFIX.classification,
    dims: bundle.embedding.dims,
    device: 'cpu',
    threads: cpuThreads(process.arch, 12),
    featureNames: FEATURE_NAMES,
    nativeTokenCounts: null,
    tokenCountNote: 'Native helper does not expose token counts or truncation indicators.',
  };
  mkdirSync(dirname(resolve(out)), { recursive: true, mode: 0o700 });
  writeFileSync(
    `${out}.extraction.json`,
    JSON.stringify({ at: new Date().toISOString(), ...provenance }, null, 2),
    { flag: 'wx', mode: 0o600 },
  );
  const ai = createLocalIntelligence({
    root: installed,
    bundle,
    device: 'cpu',
    logicalCores: 12,
    env: {},
  });
  const cache = new Map<string, { vector: Float32Array; milliseconds: number }>();
  const results = [];
  let warmupMilliseconds = 0;
  try {
    const start = performance.now();
    await ai.engine.embed({
      texts: ['Participant ranking warm-up.'],
      task: 'classification',
      overflow: 'truncate',
      priority: 'meeting',
    });
    warmupMilliseconds = performance.now() - start;
    if (ai.engine.status().actualDevice !== 'cpu') throw new Error('CPU engine required');
    const embed = async (text: string) => {
      if (!text) return new Float32Array(bundle.embedding.dims);
      const key = sha(text),
        saved = cache.get(key);
      if (saved) return saved.vector;
      const began = performance.now();
      const [vector] = await ai.engine.embed({
        texts: [text],
        task: 'classification',
        overflow: 'truncate',
        priority: 'meeting',
      });
      if (!vector || vector.length !== bundle.embedding.dims || !vector.every(Number.isFinite))
        throw new Error('invalid native vector');
      cache.set(key, { vector, milliseconds: performance.now() - began });
      return vector;
    };
    for (const row of rows) {
      const began = performance.now();
      const features = await candidateFeatures(row.input, embed);
      results.push({
        id: row.id,
        group: row.group,
        split: row.split,
        domain,
        target: row.target,
        inputSha256: sha(JSON.stringify(row.input)),
        ...features,
        milliseconds: performance.now() - began,
      });
      if (results.length % 100 === 0)
        console.log(
          JSON.stringify({
            completed: results.length,
            total: rows.length,
            uniqueTexts: cache.size,
          }),
        );
    }
  } finally {
    await ai.close();
  }
  const vectors = new Float32Array(cache.size * bundle.embedding.dims);
  const index = [...cache.entries()].map(([textSha256, value], i) => {
    vectors.set(value.vector, i * bundle.embedding.dims);
    return { textSha256, offset: i, milliseconds: value.milliseconds };
  });
  const vectorBytes = new Uint8Array(vectors.buffer),
    vectorSha256 = sha(vectorBytes);
  writeFileSync(`${out}.vectors.f32`, vectorBytes, { flag: 'wx', mode: 0o600 });
  writeFileSync(
    `${out}.vectors.json`,
    JSON.stringify({ ...provenance, vectorSha256, index }, null, 2),
    { flag: 'wx', mode: 0o600 },
  );
  writeFileSync(
    out,
    JSON.stringify(
      {
        ...provenance,
        vectorSha256,
        warmupMilliseconds,
        timingScope:
          'resident CPU raw embedding and cache reuse; not an isolated or end-to-end production latency benchmark',
        rows: results,
      },
      null,
      2,
    ),
    { flag: 'wx', mode: 0o600 },
  );
  console.log(JSON.stringify({ complete: true, rows: results.length, uniqueTexts: cache.size }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
