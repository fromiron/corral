import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import type { D1Manifest } from '../src/d1/manifest.ts';
import { LINUX_X64_CPU } from '../src/d1/manifest.ts';
import { type D1Command, type D1Launcher, spawnD1 } from '../src/d1/runtime.ts';

export const FAKE_SERVER = fileURLToPath(new URL('./fake-llama-server.ts', import.meta.url));
export const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

export const MODEL_BYTES = Buffer.from('fake d1 model weights');
export const SERVER_BYTES = Buffer.from('#!fake llama-server');
export const LIB_BYTES = Buffer.from('fake shared library');

/** A complete manifest for small fake files; the fake server reports size 1000, params 2000. */
export function testManifest(overrides: Partial<D1Manifest> = {}): D1Manifest {
  return {
    ...LINUX_X64_CPU,
    id: 'd1-test',
    model: {
      ...LINUX_X64_CPU.model,
      url: 'https://models.test/d1.gguf',
      size: MODEL_BYTES.length,
      sha256: sha(MODEL_BYTES),
      tensorBytes: 1000,
      params: 2000,
    },
    runtime: {
      ...LINUX_X64_CPU.runtime,
      url: 'https://runtime.test/llama.tar.gz',
      // Install tests pin the archive they serve.
      size: 1,
      sha256: sha('archive'),
      files: {
        'llama-server': {
          member: 'llama-b12189/llama-server',
          size: SERVER_BYTES.length,
          sha256: sha(SERVER_BYTES),
        },
        'libggml.so': {
          member: 'llama-b12189/libggml.so',
          size: LIB_BYTES.length,
          sha256: sha(LIB_BYTES),
        },
      },
    },
    ...overrides,
  };
}

const dirs: string[] = [];
export function tempRoot(prefix = 'corral-d1-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
export function removeTempRoots() {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** Lays out an installed engine without downloading anything. */
export function installFake(root: string, manifest: D1Manifest): string {
  const dir = join(root, manifest.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, manifest.model.file), MODEL_BYTES);
  writeFileSync(join(dir, 'llama-server'), SERVER_BYTES);
  writeFileSync(join(dir, 'libggml.so'), LIB_BYTES);
  writeFileSync(join(dir, 'install.json'), JSON.stringify({ id: manifest.id }));
  return dir;
}

export interface FakeBehavior {
  startupDelayMs?: number;
  ignoreKey?: boolean;
  ignoreTerm?: boolean;
  decisions?: boolean;
  size?: number;
  params?: number;
  tokenize?: 'ok' | 'hang' | 'stall' | 'error500' | 'crash';
  tokenizeDelayMs?: number;
  systemone?: 'ok' | 'hang' | 'stall' | 'error500' | 'crash';
  systemoneDelayMs?: number;
  usageDelta?: number;
  choice?: string;
}

/** Launches the fake server in place of the installed one, and remembers each command. */
export function fakeLauncher(behavior: FakeBehavior = {}) {
  const commands: D1Command[] = [];
  const children: ReturnType<D1Launcher>[] = [];
  const launch: D1Launcher = (command) => {
    commands.push(command);
    const child = spawnD1({
      ...command,
      file: process.execPath,
      args: [FAKE_SERVER, ...command.args],
      env: { ...command.env, FAKE_D1: JSON.stringify(behavior) },
    });
    children.push(child);
    return child;
  };
  return { launch, commands, children };
}

export async function fakeStats(base: string, change?: FakeBehavior) {
  const response = await fetch(`${base}/__fake`, {
    method: change ? 'POST' : 'GET',
    ...(change ? { body: JSON.stringify(change) } : {}),
  });
  return (await response.json()) as {
    tokenize: number;
    tokenizeClosedEarly: number;
    systemone: number;
    systemoneDone: number;
    argv: string[];
    envKeys: string[];
  };
}

export async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface TarEntry {
  name: string;
  data?: Buffer;
  type?: string;
  linkname?: string;
}

function tarHeader(entry: TarEntry, size: number): Buffer {
  const header = Buffer.alloc(512);
  header.write(entry.name, 0, 100, 'utf8');
  header.write('0000755\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  header.write('00000000000\0', 136);
  header.write('        ', 148);
  header.write(entry.type ?? '0', 156);
  header.write(entry.linkname ?? '', 157, 100);
  header.write('ustar\0', 257);
  header.write('00', 263);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return header;
}

/** A gzip-compressed ustar archive; GNU long names for names over 100 bytes. */
export function tarGz(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  const push = (entry: TarEntry) => {
    const data = entry.data ?? Buffer.alloc(0);
    parts.push(
      tarHeader(entry, data.length),
      data,
      Buffer.alloc((512 - (data.length % 512)) % 512),
    );
  };
  for (const entry of entries) {
    if (Buffer.byteLength(entry.name) > 100)
      push({ name: '././@LongLink', type: 'L', data: Buffer.from(`${entry.name}\0`) });
    push(entry);
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

/** The release archive's layout, with an unpinned README and a library link. */
export function releaseArchive(extra: TarEntry[] = []): Buffer {
  return tarGz([
    { name: 'llama-b12189/', type: '5' },
    { name: 'llama-b12189/llama-server', data: SERVER_BYTES },
    { name: 'llama-b12189/libggml.so', data: LIB_BYTES },
    { name: 'llama-b12189/libggml.so.0', type: '2', linkname: 'libggml.so' },
    { name: 'llama-b12189/README.md', data: Buffer.from('readme') },
    ...extra,
  ]);
}

/** Serves pinned URLs from memory; `hold` keeps a body open until aborted. */
export function servingFetch(files: Record<string, Buffer>, options: { hold?: string } = {}) {
  const asked: string[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const key = String(url);
    asked.push(key);
    const data = files[key];
    if (!data) return new Response('missing', { status: 404 });
    if (options.hold === key) {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(data.subarray(0, 4));
          init?.signal?.addEventListener('abort', () =>
            controller.error(init.signal?.reason ?? new Error('aborted')),
          );
        },
      });
      return new Response(stream, { status: 200 });
    }
    return new Response(new Uint8Array(data), { status: 200 });
  }) as typeof fetch;
  return { fetchFn, asked };
}

export const goodVersion = async () =>
  'version: 0.9.0-dev (build 12189, commit 80d2c0c2c) built for x86_64-linux-gnu';
