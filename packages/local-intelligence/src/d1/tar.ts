// Reads pinned members out of a gzip-compressed tar archive (the llama.cpp release) as a
// stream, without unpacking anything else. An absolute or parent-relative path anywhere in the
// archive refuses it; a link is never created, and a pinned member that is a link refuses it.
// Only what release archives use is read: ustar and GNU headers, GNU long names and pax paths.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import { createGunzip } from 'node:zlib';

export interface TarMember {
  /** The partial file the caller owns and removes on failure. */
  target: string;
  size: number;
  sha256: string;
}

const BLOCK = 512;
const MAX_META = 64 * 1024;

const field = (header: Buffer, start: number, length: number) => {
  const raw = header.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end < 0 ? length : end).toString('utf8');
};

function octal(header: Buffer, start: number, length: number): number {
  // GNU base-256 for sizes over 8 GiB: never in a release archive.
  if (header[start]! & 0x80) throw new Error('the runtime archive has an oversized entry');
  const text = field(header, start, length).trim();
  const value = text ? Number.parseInt(text, 8) : 0;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('the runtime archive is corrupt');
  return value;
}

function checksumOk(header: Buffer): boolean {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i]!;
  return sum === octal(header, 148, 8);
}

/** `./a/b` → `a/b`; refuses paths that could leave the folder. */
function safeName(name: string): string {
  const normalized = name.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  if (
    name.includes('\0') ||
    name.startsWith('/') ||
    /^[A-Za-z]:/.test(name) ||
    name.includes('\\') ||
    normalized.split('/').includes('..')
  )
    throw new Error('the runtime archive has an unsafe path');
  return normalized;
}

function paxPath(data: Buffer): string | null {
  let position = 0,
    path: string | null = null;
  while (position < data.length) {
    const space = data.indexOf(0x20, position);
    if (space < 0) break;
    const length = Number.parseInt(data.toString('utf8', position, space), 10);
    if (!Number.isSafeInteger(length) || length <= 0)
      throw new Error('the runtime archive is corrupt');
    const record = data.toString('utf8', space + 1, position + length - 1);
    const eq = record.indexOf('=');
    if (record.slice(0, eq) === 'path') path = record.slice(eq + 1);
    position += length;
  }
  return path;
}

/** Writes each pinned member of `archive` to its target, checking its exact size and sha256. */
export async function extractTarGzMembers(
  archive: string,
  members: ReadonlyMap<string, TarMember>,
  signal?: AbortSignal,
): Promise<void> {
  const found = new Set<string>();
  let buffer: Buffer = Buffer.alloc(0);
  // The entry being read: its remaining bytes, padding, and where they go.
  let remaining = 0,
    padding = 0;
  const entry: {
    sink: {
      name: string;
      member: TarMember;
      handle: FileHandle;
      hash: ReturnType<typeof createHash>;
      written: number;
    } | null;
    meta: { kind: 'long' | 'pax'; chunks: Buffer[] } | null;
  } = { sink: null, meta: null };
  let nextName: string | null = null;
  let ended = false;

  const finishEntry = async () => {
    if (entry.sink) {
      const { name, member, handle, hash, written } = entry.sink;
      entry.sink = null;
      await handle.close();
      if (written !== member.size)
        throw new Error(`${name} has ${written} of ${member.size} bytes`);
      if (hash.digest('hex') !== member.sha256) throw new Error(`${name}: sha256 mismatch`);
      found.add(name);
    }
    if (entry.meta) {
      const data = Buffer.concat(entry.meta.chunks);
      nextName =
        entry.meta.kind === 'long' ? field(data, 0, data.length) : (paxPath(data) ?? nextName);
      entry.meta = null;
    }
  };

  const header = async (block: Buffer) => {
    if (block.every((b) => b === 0)) {
      ended = true;
      return;
    }
    if (!checksumOk(block)) throw new Error('the runtime archive is corrupt');
    const type = String.fromCharCode(block[156]!);
    const size = octal(block, 124, 12);
    const prefix = block.toString('latin1', 257, 263).startsWith('ustar')
      ? field(block, 345, 155)
      : '';
    const raw = nextName ?? (prefix ? `${prefix}/${field(block, 0, 100)}` : field(block, 0, 100));
    remaining = size;
    padding = (BLOCK - (size % BLOCK)) % BLOCK;
    if (type === 'L' || type === 'x') {
      if (size > MAX_META) throw new Error('the runtime archive is corrupt');
      entry.meta = { kind: type === 'L' ? 'long' : 'pax', chunks: [] };
      return;
    }
    nextName = null;
    if (type === 'g') return;
    const name = safeName(raw);
    const member = members.get(name);
    if (!member) return;
    if (type !== '0' && type !== '\0' && type !== '7')
      throw new Error(`${name} is not a regular file in the runtime archive`);
    if (found.has(name)) throw new Error(`${name} is in the runtime archive twice`);
    if (size !== member.size) throw new Error(`${name} has ${size} bytes, expected ${member.size}`);
    entry.sink = {
      name,
      member,
      handle: await open(member.target, 'w', 0o700),
      hash: createHash('sha256'),
      written: 0,
    };
  };

  const source = createReadStream(archive, { highWaterMark: 1 << 20 });
  const gunzip = source.pipe(createGunzip());
  const abort = () => gunzip.destroy(new Error('the install was cancelled'));
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for await (const chunk of gunzip as AsyncIterable<Buffer>) {
      signal?.throwIfAborted();
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      while (!ended) {
        if (remaining > 0) {
          if (!buffer.length) break;
          const part = buffer.subarray(0, Math.min(remaining, buffer.length));
          buffer = buffer.subarray(part.length);
          remaining -= part.length;
          if (entry.sink) {
            entry.sink.hash.update(part);
            entry.sink.written += part.length;
            await entry.sink.handle.write(part);
          } else entry.meta?.chunks.push(Buffer.from(part));
          if (remaining > 0) break;
        }
        if (padding > 0) {
          const skip = Math.min(padding, buffer.length);
          buffer = buffer.subarray(skip);
          padding -= skip;
          if (padding > 0) break;
        }
        if (entry.sink || entry.meta) await finishEntry();
        if (buffer.length < BLOCK) break;
        const block = buffer.subarray(0, BLOCK);
        buffer = buffer.subarray(BLOCK);
        await header(block);
        if (remaining === 0 && padding === 0 && (entry.sink || entry.meta)) await finishEntry();
      }
      if (ended) break;
    }
    signal?.throwIfAborted();
    if (entry.sink || entry.meta || remaining > 0)
      throw new Error('the runtime archive is truncated');
    for (const name of members.keys())
      if (!found.has(name)) throw new Error(`${name} is not in the runtime archive`);
  } finally {
    signal?.removeEventListener('abort', abort);
    const open_ = entry.sink as { handle: FileHandle } | null;
    if (open_) await open_.handle.close().catch(() => {});
    source.destroy();
    gunzip.destroy();
  }
}
