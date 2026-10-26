// Installs the effort-judge model named in model-manifest.json. Every file is
// downloaded with its exact size, checked against its sha256 and renamed into place, so a
// broken or partial download never replaces a working file; files that already match are kept.
// install.json records the installed release.
//
// Derived from mixdog `src/runtime/effort-judge/model-install.mjs` (Apache-2.0; see
// ../NOTICE.md). Changes for Corral: TypeScript, an inline bounded download instead of
// mixdog's shared helper, an explicit `installState`, and only HTTPS manifests.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import bundled from './model-manifest.json' with { type: 'json' };

export interface ModelManifest {
  schema_version: number;
  release: string;
  files: Record<string, { url: string; sha256: string; size: number }>;
}

const STAMP = 'install.json';
/** Built from tokenizer.json on first load (tokenizer.ts); stale after a tokenizer change. */
const DERIVED = ['tokenizer.bin'];

export function bundledManifest(): ModelManifest {
  return validManifest(bundled as ModelManifest);
}

function validManifest(manifest: ModelManifest): ModelManifest {
  const files = Object.entries(manifest.files ?? {});
  if (
    !manifest.release ||
    files.length === 0 ||
    files.some(
      ([name, f]) =>
        !/^[A-Za-z0-9._-]+$/.test(name) ||
        !/^[0-9a-f]{64}$/.test(f.sha256) ||
        !Number.isSafeInteger(f.size) ||
        f.size <= 0 ||
        !/^https:\/\//.test(f.url),
    )
  ) {
    throw new Error('effort judge model manifest is invalid');
  }
  return manifest;
}

/** `current`: this release is installed; `stale`: another one is; `missing`: none (or broken). */
export function installState(
  dir: string,
  manifest: ModelManifest = bundledManifest(),
): 'current' | 'stale' | 'missing' {
  try {
    const stamp = JSON.parse(readFileSync(join(dir, STAMP), 'utf8')) as { release?: unknown };
    if (typeof stamp.release !== 'string') return 'missing';
    return stamp.release === manifest.release ? 'current' : 'stale';
  } catch {
    return 'missing';
  }
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

async function download(
  url: string,
  target: string,
  expected: number,
  fetchFn: typeof fetch,
): Promise<void> {
  const response = await fetchFn(url, { redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`download failed: HTTP ${response.status}`);
  const chunks: Uint8Array[] = [];
  let received = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > expected) {
      await reader.cancel();
      throw new Error(`download is larger than ${expected} bytes`);
    }
    chunks.push(value);
  }
  if (received !== expected) throw new Error(`download has ${received} of ${expected} bytes`);
  writeFileSync(target, Buffer.concat(chunks));
}

/** Download what is missing or different, then stamp the release. */
export async function installModel(
  dir: string,
  {
    manifest = bundledManifest(),
    fetchFn = globalThis.fetch,
    onFile,
  }: {
    manifest?: ModelManifest;
    fetchFn?: typeof fetch;
    onFile?: (name: string, size: number) => void;
  } = {},
): Promise<void> {
  validManifest(manifest);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let replaced = false;
  for (const [name, file] of Object.entries(manifest.files)) {
    const target = join(dir, name);
    if (existsSync(target) && sha256File(target) === file.sha256) continue;
    onFile?.(name, file.size);
    const partial = `${target}.part`;
    try {
      await download(file.url, partial, file.size, fetchFn);
      const actual = sha256File(partial);
      if (actual !== file.sha256)
        throw new Error(`${name}: sha256 mismatch (expected ${file.sha256}, got ${actual})`);
      // From the first replaced file until the new stamp, the folder mixes releases: without a
      // stamp it reads as not installed, so an interrupted install is never loaded.
      if (!replaced) rmSync(join(dir, STAMP), { force: true });
      renameSync(partial, target);
      replaced = true;
    } finally {
      rmSync(partial, { force: true });
    }
  }
  if (replaced) for (const name of DERIVED) rmSync(join(dir, name), { force: true });
  writeFileSync(join(dir, STAMP), `${JSON.stringify({ release: manifest.release })}\n`);
}
