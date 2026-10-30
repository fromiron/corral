import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import type { Bundle } from '../src/bundle.ts';

export function tempDir() {
  return mkdtempSync(join(tmpdir(), 'corral-local-ai-'));
}

export function sha256(data: Buffer | string) {
  return createHash('sha256').update(data).digest('hex');
}

/** A minimal zip (no zip64) like a wheel: stored or deflated members. */
export function makeZip(entries: { name: string; data: Buffer; method?: 0 | 8 }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const method = entry.method ?? 8;
    const body = method === 8 ? deflateRawSync(entry.data) : entry.data;
    const name = Buffer.from(entry.name);
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** Serves fixed bodies in small chunks; records requested URLs. */
export function fakeFetch(bodies: Record<string, Buffer>, options: { chunk?: number } = {}) {
  const requested: string[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requested.push(url);
    const body = bodies[url];
    if (!body) return new Response('missing', { status: 404 });
    const chunk = options.chunk ?? 7;
    let position = 0;
    const signal = init?.signal;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (signal?.aborted) {
          controller.error(signal.reason ?? new DOMException('aborted', 'AbortError'));
          return;
        }
        if (position >= body.length) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(body.subarray(position, position + chunk)));
        position += chunk;
      },
    });
    return new Response(stream, { status: 200 });
  }) as typeof fetch;
  return { fetchFn, requested };
}

export const LIBRARY = Buffer.from('fake shared library bytes '.repeat(40));
export const EXTRA = Buffer.from('fake companion library');
export const MODEL = Buffer.from('fake embedding model '.repeat(50));
export const WHEEL = makeZip([
  { name: 'litert_lm/__init__.py', data: Buffer.from('# python'), method: 0 },
  { name: 'litert_lm/libfake.so', data: LIBRARY, method: 8 },
  { name: 'litert_lm/extra.so', data: EXTRA, method: 0 },
]);

export function testBundle(overrides: Partial<Bundle> = {}): Bundle {
  return {
    schemaVersion: 1,
    release: 'test-release-1',
    model: {
      name: 'Test model',
      file: 'model.litertlm',
      url: 'https://models.test/model.litertlm',
      size: MODEL.length,
      sha256: sha256(MODEL),
    },
    embedding: { dims: 4, maxInputTokens: 256 },
    runtime: {
      name: 'litert-lm-api',
      version: '0.0.0',
      apiVersion: { major: 1, minor: 0 },
      targets: {
        'linux-x64': {
          url: 'https://wheels.test/runtime.whl',
          size: WHEEL.length,
          sha256: sha256(WHEEL),
          library: 'libfake.so',
          files: {
            'libfake.so': {
              member: 'litert_lm/libfake.so',
              size: LIBRARY.length,
              sha256: sha256(LIBRARY),
            },
            'extra.so': { member: 'litert_lm/extra.so', size: EXTRA.length, sha256: sha256(EXTRA) },
          },
        },
      },
    },
    ...overrides,
  };
}

export function servedBodies(bundle: Bundle = testBundle()) {
  return {
    [bundle.model.url]: MODEL,
    [bundle.runtime.targets['linux-x64']!.url]: WHEEL,
  };
}
