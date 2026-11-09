// Installs the Local effort routing engine (features/effort-routing.md#local-엔진-설치): the d1
// model and the llama.cpp server files, apart from the meeting bundle. Each download goes to a
// partial file with its size and sha256 checked; the archive gives up only its pinned files,
// each checked again; the server must report the pinned build. The stamp is written last, so an
// interrupted install never reads as installed. Each manifest gets its own folder, so a running
// instance keeps the files it started with.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { statfs, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { downloadPinned, matchesPinned } from '../install.ts';
import { type D1Manifest, manifestProblem } from './manifest.ts';
import { extractTarGzMembers } from './tar.ts';

const STAMP = 'install.json';
const ARCHIVE = 'runtime.tar.gz.part';

export interface D1InstallProgress {
  phase: 'downloading' | 'verifying';
  /** Bytes received of the model and the runtime archive together. */
  received: number;
  total: number;
}

/** Runs the installed server once to ask its version; resolves with what it printed. */
export type VersionProbe = (server: string, dir: string, signal?: AbortSignal) => Promise<string>;

export interface D1InstallOptions {
  manifest: D1Manifest;
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
  onProgress?(progress: D1InstallProgress): void;
  probe?: VersionProbe;
  /** Free bytes where the folder is; null when the system cannot say. */
  freeBytes?(dir: string): Promise<number | null>;
}

export function d1Dir(root: string, manifest: D1Manifest): string {
  return join(root, manifest.id);
}

/** Installed: the stamp names this manifest and every pinned file has its size. */
export function d1Installed(root: string, manifest: D1Manifest): boolean {
  const dir = d1Dir(root, manifest);
  try {
    const stamp = JSON.parse(readFileSync(join(dir, STAMP), 'utf8')) as { id?: unknown };
    if (stamp.id !== manifest.id) return false;
    const files: [string, { size: number }][] = [
      [manifest.model.file, manifest.model],
      ...Object.entries(manifest.runtime.files),
    ];
    return files.every(([name, file]) => statSync(join(dir, name)).size === file.size);
  } catch {
    return false;
  }
}

/** The server's `--version`, run with only the library path, for at most 10 seconds. */
export const probeVersion: VersionProbe = (server, dir, signal) =>
  new Promise((resolve, reject) => {
    execFile(
      server,
      ['--version'],
      { env: { LD_LIBRARY_PATH: dir }, timeout: 10_000, signal, maxBuffer: 64 * 1024 },
      (error, stdout, stderr) => {
        if (error && !stdout && !stderr) reject(new Error('the Local runtime did not start'));
        else resolve(`${stdout}\n${stderr}`);
      },
    );
  });

async function systemFree(dir: string): Promise<number | null> {
  try {
    const stats = await statfs(dir);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

/** True when the version text names the pinned build and a prefix of its commit. */
export function versionMatches(output: string, manifest: D1Manifest): boolean {
  const build = manifest.runtime.build.replace(/^b/, '');
  const commit = /commit ([0-9a-f]{7,40})\b/.exec(output)?.[1];
  return (
    new RegExp(`\\bbuild ${build}\\b`).test(output) &&
    !!commit &&
    manifest.runtime.commit.startsWith(commit)
  );
}

/** Downloads what is missing or different, checks the server, then stamps the folder. */
export async function installD1(root: string, options: D1InstallOptions): Promise<string> {
  const { manifest } = options;
  const problem = manifestProblem(manifest);
  if (problem) throw new Error(problem);
  const dir = d1Dir(root, manifest);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const total = manifest.model.size + manifest.runtime.size;
  const partials: string[] = [];
  let unstamped = false;
  const unstamp = () => {
    if (unstamped) return;
    rmSync(join(dir, STAMP), { force: true });
    unstamped = true;
  };
  const report = (phase: D1InstallProgress['phase'], received: number) =>
    options.onProgress?.({ phase, received, total });
  try {
    const modelPath = join(dir, manifest.model.file);
    const needModel = !(await matchesPinned(modelPath, manifest.model));
    const runtimeFiles = Object.entries(manifest.runtime.files);
    const stale: string[] = [];
    for (const [name, file] of runtimeFiles)
      if (!(await matchesPinned(join(dir, name), file))) stale.push(name);
    const needed =
      (needModel ? manifest.model.size : 0) +
      (stale.length
        ? manifest.runtime.size +
          stale.reduce((n, name) => n + manifest.runtime.files[name]!.size, 0)
        : 0);
    const free = await (options.freeBytes ?? systemFree)(dir);
    if (free !== null && free < needed)
      throw new Error('not enough disk space for the Local model');

    if (needModel) {
      const partial = `${modelPath}.part`;
      partials.push(partial);
      await downloadPinned(manifest.model.url, partial, manifest.model, 'model', {
        ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        onProgress: ({ received }) => report('downloading', received),
      });
      unstamp();
      renameSync(partial, modelPath);
    }
    if (stale.length) {
      const archive = join(dir, ARCHIVE);
      partials.push(archive);
      await downloadPinned(manifest.runtime.url, archive, manifest.runtime, 'runtime', {
        ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        onProgress: ({ received }) => report('downloading', manifest.model.size + received),
      });
      report('verifying', total);
      const wanted = new Map(
        stale.map((name) => {
          const file = manifest.runtime.files[name]!;
          const target = join(dir, `${name}.part`);
          partials.push(target);
          return [file.member, { target, size: file.size, sha256: file.sha256 }] as const;
        }),
      );
      await extractTarGzMembers(archive, wanted, options.signal);
      unstamp();
      for (const name of stale) renameSync(join(dir, `${name}.part`), join(dir, name));
    }
    report('verifying', total);
    const server = join(dir, manifest.runtime.server);
    if (!existsSync(server)) throw new Error('the Local runtime is missing its server');
    const version = await (options.probe ?? probeVersion)(server, dir, options.signal);
    if (!versionMatches(version, manifest))
      throw new Error(`the Local runtime is not llama.cpp ${manifest.runtime.build}`);
    options.signal?.throwIfAborted();
    await writeFile(join(dir, STAMP), `${JSON.stringify({ id: manifest.id })}\n`, { mode: 0o600 });
    return dir;
  } finally {
    for (const partial of partials) rmSync(partial, { force: true });
  }
}
