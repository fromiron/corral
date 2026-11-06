// Reads one member out of a zip archive (a Python wheel) without loading the archive into
// memory. Only what wheels use is supported: stored or deflated members, no encryption, no
// zip64. Anything else is refused rather than guessed.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInflateRaw } from 'node:zlib';

interface Entry {
  method: number;
  flags: number;
  compressedSize: number;
  size: number;
  localHeader: number;
}

async function readAt(path: string, position: number, length: number): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function findEntry(path: string, name: string, archiveSize: number): Promise<Entry> {
  const tailLength = Math.min(archiveSize, 22 + 0xffff);
  const tail = await readAt(path, archiveSize - tailLength, tailLength);
  let end = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('not a zip archive');
  const count = tail.readUInt16LE(end + 10);
  const directorySize = tail.readUInt32LE(end + 12);
  const directoryOffset = tail.readUInt32LE(end + 16);
  if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff)
    throw new Error('zip64 archives are not supported');
  const directory = await readAt(path, directoryOffset, directorySize);
  let position = 0;
  for (let i = 0; i < count; i++) {
    if (directory.readUInt32LE(position) !== 0x02014b50) throw new Error('corrupt zip directory');
    const nameLength = directory.readUInt16LE(position + 28);
    const extraLength = directory.readUInt16LE(position + 30);
    const commentLength = directory.readUInt16LE(position + 32);
    const entryName = directory.toString('utf8', position + 46, position + 46 + nameLength);
    if (entryName === name)
      return {
        flags: directory.readUInt16LE(position + 8),
        method: directory.readUInt16LE(position + 10),
        compressedSize: directory.readUInt32LE(position + 20),
        size: directory.readUInt32LE(position + 24),
        localHeader: directory.readUInt32LE(position + 42),
      };
    position += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`${name} is not in the archive`);
}

/**
 * Writes `member` of the archive at `path` to `target`, checking its exact size and sha256.
 * The caller owns `target` (a partial file) and removes it on failure.
 */
export async function extractZipMember(
  path: string,
  archiveSize: number,
  member: string,
  target: string,
  expected: { size: number; sha256: string },
  signal?: AbortSignal,
): Promise<void> {
  const entry = await findEntry(path, member, archiveSize);
  if (entry.flags & 1) throw new Error(`${member} is encrypted`);
  if (entry.method !== 0 && entry.method !== 8)
    throw new Error(`${member} uses unsupported compression ${entry.method}`);
  if (entry.size !== expected.size)
    throw new Error(`${member} has ${entry.size} bytes, expected ${expected.size}`);
  const local = await readAt(path, entry.localHeader, 30);
  if (local.readUInt32LE(0) !== 0x04034b50) throw new Error('corrupt zip entry');
  const start = entry.localHeader + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
  const hash = createHash('sha256');
  let written = 0;
  const check = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      written += chunk.length;
      if (written > expected.size) {
        callback(new Error(`${member} is larger than ${expected.size} bytes`));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  const source = createReadStream(path, {
    start,
    end: start + entry.compressedSize - 1,
    highWaterMark: 1 << 20,
  });
  const stages = entry.method === 8 ? [source, createInflateRaw(), check] : [source, check];
  await pipeline([...stages, createWriteStream(target, { mode: 0o600 })], { signal });
  if (written !== expected.size)
    throw new Error(`${member} has ${written} of ${expected.size} bytes`);
  const actual = hash.digest('hex');
  if (actual !== expected.sha256)
    throw new Error(`${member}: sha256 mismatch (expected ${expected.sha256}, got ${actual})`);
}
