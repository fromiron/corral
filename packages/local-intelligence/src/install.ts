// Installs a local AI bundle: the base model and the LiteRT-LM library for one target. Every
// file is streamed to a partial file with its exact size and sha256 checked, then renamed into
// place, so a broken or interrupted download never replaces a working file. The release stamp
// is written last; until then the folder reads as not installed. Each release gets its own
// folder, so a running engine keeps reading the release it started with.
//
// The install-then-stamp approach is derived from mixdog `src/runtime/effort-judge/model-install.mjs`
// (Apache-2.0; see ../NOTICE.md). Changes for Corral: streamed downloads with cancellation and
// progress, library extraction from a pinned wheel, and one folder per release.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Bundle, bundledManifest, validBundle } from './bundle.ts';
import { extractZipMember } from './zip.ts';

export type InstallState = 'current' | 'stale' | 'missing' | 'unsupported';

export interface InstallProgress {
  /** The model file name, or `runtime` for the wheel. */
  file: string;
  received: number;
  total: number;
}

export interface InstallOptions {
  bundle?: Bundle;
  target: string;
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
  onProgress?(progress: InstallProgress): void;
}

const STAMP = 'install.json';
const WHEEL = 'runtime.whl.part';

export function bundleDir(root: string, bundle: Bundle = bundledManifest()): string {
  return join(root, bundle.release);
}

function readStamp(dir: string): { release?: unknown; target?: unknown } | null {
  try {
    return JSON.parse(readFileSync(join(dir, STAMP), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * `current`: this release is installed for this target; `stale`: only another release is;
 * `missing`: nothing usable; `unsupported`: no runtime library exists for this target.
 */
export function installState(
  root: string,
  target: string | null,
  bundle: Bundle = bundledManifest(),
): InstallState {
  if (!target || !Object.hasOwn(bundle.runtime.targets, target)) return 'unsupported';
  const stamp = readStamp(bundleDir(root, bundle));
  if (stamp?.release === bundle.release && stamp.target === target) return 'current';
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return 'missing';
  }
  const other = entries.some((name) => {
    if (name === bundle.release) return false;
    const found = readStamp(join(root, name));
    return typeof found?.release === 'string' && found.target === target;
  });
  return other ? 'stale' : 'missing';
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  const handle = await open(path, 'r');
  try {
    for await (const chunk of handle.createReadStream({ highWaterMark: 1 << 20 }))
      hash.update(chunk);
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

async function matches(path: string, file: { size: number; sha256: string }) {
  if (!existsSync(path)) return false;
  const handle = await open(path, 'r');
  const { size } = await handle.stat();
  await handle.close();
  return size === file.size && (await sha256File(path)) === file.sha256;
}

async function download(
  url: string,
  target: string,
  expected: { size: number; sha256: string },
  label: string,
  options: InstallOptions,
): Promise<void> {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const response = await fetchFn(url, { redirect: 'follow', signal: options.signal });
  if (!response.ok || !response.body)
    throw new Error(`${label}: download failed: HTTP ${response.status}`);
  const hash = createHash('sha256');
  const handle = await open(target, 'w', 0o600);
  let received = 0;
  try {
    const reader = response.body.getReader();
    for (;;) {
      options.signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > expected.size) {
        await reader.cancel();
        throw new Error(`${label}: download is larger than ${expected.size} bytes`);
      }
      hash.update(value);
      await handle.write(value);
      options.onProgress?.({ file: label, received, total: expected.size });
    }
  } finally {
    await handle.close();
  }
  options.signal?.throwIfAborted();
  if (received !== expected.size)
    throw new Error(`${label}: download has ${received} of ${expected.size} bytes`);
  const actual = hash.digest('hex');
  if (actual !== expected.sha256)
    throw new Error(`${label}: sha256 mismatch (expected ${expected.sha256}, got ${actual})`);
}

/** Downloads what is missing or different for `target`, then stamps the release. */
export async function installBundle(root: string, options: InstallOptions): Promise<string> {
  const bundle = validBundle(options.bundle ?? bundledManifest());
  const runtime = bundle.runtime.targets[options.target];
  if (!runtime || !Object.hasOwn(bundle.runtime.targets, options.target))
    throw new Error(`no local AI runtime for ${options.target}`);
  const dir = bundleDir(root, bundle);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const partials: string[] = [];
  let unstamped = false;
  // From the first replaced file until the new stamp the folder mixes contents: without a stamp
  // it reads as not installed, so an interrupted install is never loaded.
  const unstamp = () => {
    if (unstamped) return;
    rmSync(join(dir, STAMP), { force: true });
    unstamped = true;
  };
  try {
    const model = join(dir, bundle.model.file);
    if (!(await matches(model, bundle.model))) {
      const partial = `${model}.part`;
      partials.push(partial);
      await download(bundle.model.url, partial, bundle.model, bundle.model.file, options);
      unstamp();
      renameSync(partial, model);
    }
    const files = Object.entries(runtime.files);
    const stale = [];
    for (const [name, file] of files) if (!(await matches(join(dir, name), file))) stale.push(name);
    if (stale.length) {
      const wheel = join(dir, WHEEL);
      partials.push(wheel);
      await download(runtime.url, wheel, runtime, 'runtime', options);
      const extracted: [string, string][] = [];
      for (const name of stale) {
        const file = runtime.files[name]!;
        const partial = join(dir, `${name}.part`);
        partials.push(partial);
        try {
          await extractZipMember(wheel, runtime.size, file.member, partial, file, options.signal);
        } catch (error) {
          throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`, {
            cause: error,
          });
        }
        extracted.push([partial, join(dir, name)]);
      }
      unstamp();
      for (const [partial, target] of extracted) renameSync(partial, target);
    }
    options.signal?.throwIfAborted();
    await writeFile(
      join(dir, STAMP),
      `${JSON.stringify({ release: bundle.release, target: options.target })}\n`,
    );
    return dir;
  } finally {
    for (const partial of partials) rmSync(partial, { force: true });
  }
}
