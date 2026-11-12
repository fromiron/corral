// Installs the Local effort routing engine (features/effort-routing.md#local-엔진-설치): the d1
// model and the llama.cpp server files, apart from the meeting bundle. Each download goes to a
// partial file with its size and sha256 checked; the archive gives up only its pinned files,
// each checked again; the server must report the pinned build. The stamp is written last, so an
// interrupted install never reads as installed. Each manifest gets its own folder, so a running
// instance keeps the files it started with.
import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { downloadPinned, matchesPinned } from '../install.ts';
import { type D1Device, type D1Manifest, d1Runtime, manifestProblem } from './manifest.ts';
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
  /** Which device runtime to install. The model is shared. Defaults to CPU. */
  device?: D1Device;
  probe?: VersionProbe;
  /** Free bytes where the folder is; null when the system cannot say. */
  freeBytes?(dir: string): Promise<number | null>;
}

export function d1Dir(root: string, manifest: D1Manifest): string {
  return join(root, manifest.id);
}

interface InstallStamp {
  id?: unknown;
  devices?: unknown;
}

function readStamp(dir: string): InstallStamp | null {
  try {
    return JSON.parse(readFileSync(join(dir, STAMP), 'utf8')) as InstallStamp;
  } catch {
    return null;
  }
}

/** Devices named by the stamp. A stamp without a list is the CPU install from before GPU runtimes. */
function stampedDevices(stamp: InstallStamp | null, manifest: D1Manifest): D1Device[] {
  if (!stamp || stamp.id !== manifest.id) return [];
  const listed = Array.isArray(stamp.devices) ? stamp.devices : ['cpu'];
  return listed.filter(
    (device): device is D1Device => device === 'cpu' || device === 'vulkan' || device === 'cuda',
  );
}

function writeStamp(dir: string, manifest: D1Manifest, devices: D1Device[]) {
  writeFileSync(join(dir, STAMP), `${JSON.stringify({ id: manifest.id, devices })}\n`, {
    mode: 0o600,
  });
}

/** Installed: the stamp names this manifest and this device's files, plus the shared model, have their sizes. */
export function d1Installed(root: string, manifest: D1Manifest, device: D1Device = 'cpu'): boolean {
  const runtime = d1Runtime(manifest, device);
  if (!runtime) return false;
  const dir = d1Dir(root, manifest);
  try {
    if (!stampedDevices(readStamp(dir), manifest).includes(device)) return false;
    if (statSync(join(dir, manifest.model.file)).size !== manifest.model.size) return false;
    const base = device === 'cpu' ? dir : join(dir, device);
    return Object.entries(runtime.files).every(
      ([name, file]) => statSync(join(base, name)).size === file.size,
    );
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
export function versionMatches(
  output: string,
  manifest: D1Manifest,
  device: D1Device = 'cpu',
): boolean {
  const runtime = d1Runtime(manifest, device);
  if (!runtime) return false;
  const build = runtime.build.replace(/^b/, '');
  const commit = /commit ([0-9a-f]{7,40})\b/.exec(output)?.[1];
  return (
    new RegExp(`\\bbuild ${build}\\b`).test(output) && !!commit && runtime.commit.startsWith(commit)
  );
}

/** Downloads what is missing or different for one device, checks the server, then stamps the folder. */
export async function installD1(root: string, options: D1InstallOptions): Promise<string> {
  const { manifest } = options;
  const device = options.device ?? 'cpu';
  const runtime = d1Runtime(manifest, device);
  const problem =
    manifestProblem(manifest) ??
    (runtime ? null : 'the Local runtime is not available on this computer');
  if (problem || !runtime)
    throw new Error(problem ?? 'the Local runtime is not available on this computer');
  const dir = d1Dir(root, manifest);
  const base = device === 'cpu' ? dir : join(dir, device);
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const partials: string[] = [];
  let dropped = false;
  const dropDevice = () => {
    if (dropped) return;
    dropped = true;
    const kept = stampedDevices(readStamp(dir), manifest).filter((entry) => entry !== device);
    if (kept.length) writeStamp(dir, manifest, kept);
    else rmSync(join(dir, STAMP), { force: true });
  };
  try {
    const modelPath = join(dir, manifest.model.file);
    const needModel = !(await matchesPinned(modelPath, manifest.model));
    const runtimeFiles = Object.entries(runtime.files);
    const stale: string[] = [];
    for (const [name, file] of runtimeFiles)
      if (!(await matchesPinned(join(base, name), file))) stale.push(name);
    const total = (needModel ? manifest.model.size : 0) + (stale.length ? runtime.size : 0);
    const needed =
      (needModel ? manifest.model.size : 0) +
      (stale.length
        ? runtime.size + stale.reduce((n, name) => n + runtime.files[name]!.size, 0)
        : 0);
    const free = await (options.freeBytes ?? systemFree)(dir);
    if (free !== null && free < needed)
      throw new Error('not enough disk space for the Local model');
    const report = (phase: D1InstallProgress['phase'], received: number) =>
      options.onProgress?.({ phase, received, total });
    let received = 0;

    if (needModel) {
      const partial = `${modelPath}.part`;
      partials.push(partial);
      await downloadPinned(manifest.model.url, partial, manifest.model, 'model', {
        ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        onProgress: ({ received: got }) => report('downloading', got),
      });
      dropDevice();
      renameSync(partial, modelPath);
      received = manifest.model.size;
    }
    if (stale.length) {
      const archive = join(dir, `${device}-${ARCHIVE}`);
      partials.push(archive);
      await downloadPinned(runtime.url, archive, runtime, 'runtime', {
        ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        onProgress: ({ received: got }) => report('downloading', received + got),
      });
      report('verifying', total);
      const wanted = new Map(
        stale.map((name) => {
          const file = runtime.files[name]!;
          const target = join(base, `${name}.part`);
          partials.push(target);
          return [file.member, { target, size: file.size, sha256: file.sha256 }] as const;
        }),
      );
      await extractTarGzMembers(archive, wanted, options.signal);
      dropDevice();
      for (const name of stale) renameSync(join(base, `${name}.part`), join(base, name));
    }
    report('verifying', total);
    const server = join(base, runtime.server);
    if (!existsSync(server)) throw new Error('the Local runtime is missing its server');
    const version = await (options.probe ?? probeVersion)(server, base, options.signal);
    if (!versionMatches(version, manifest, device))
      throw new Error(`the Local runtime is not llama.cpp ${runtime.build}`);
    options.signal?.throwIfAborted();
    const kept = stampedDevices(readStamp(dir), manifest).filter((entry) => entry !== device);
    writeStamp(dir, manifest, [...kept, device]);
    return dir;
  } finally {
    for (const partial of partials) rmSync(partial, { force: true });
  }
}
