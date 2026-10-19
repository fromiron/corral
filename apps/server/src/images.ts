import { createHash } from 'node:crypto';
import { type Clock, IMAGE_MAX_BYTES, ImageAttachment, type ImageInput } from '@corral/contracts';
import type { Db } from '@corral/storage-sqlite';
import { PNG } from 'pngjs';

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Decode only bounded non-interlaced PNGs; re-encoding drops incidental private metadata. */
function normalize(input: Buffer): Buffer {
  if (
    input.length < 45 ||
    input.length > IMAGE_MAX_BYTES ||
    !input.subarray(0, 8).equals(signature) ||
    input.readUInt32BE(8) !== 13 ||
    input.toString('ascii', 12, 16) !== 'IHDR'
  )
    throw new Error('invalid or oversized PNG');
  const width = input.readUInt32BE(16),
    height = input.readUInt32BE(20);
  if (
    !width ||
    !height ||
    width > 2048 ||
    height > 2048 ||
    input[24] !== 8 ||
    ![2, 6].includes(input[25]!) ||
    input[28] !== 0
  )
    throw new Error('image must be normalized to an 8-bit, non-interlaced PNG up to 2048 by 2048');
  let offset = 8,
    headers = 0,
    end = false,
    chunks = 0;
  while (offset + 12 <= input.length && ++chunks <= 1024) {
    const length = input.readUInt32BE(offset),
      kind = input.toString('ascii', offset + 4, offset + 8);
    if (offset + length + 12 > input.length) throw new Error('truncated PNG chunk');
    if (kind === 'IHDR') headers++;
    offset += length + 12;
    if (kind === 'IEND') {
      end = length === 0;
      break;
    }
  }
  if (headers !== 1 || !end || offset !== input.length) throw new Error('invalid PNG structure');
  const decoded = PNG.sync.read(input, { checkCRC: true });
  const normalized = PNG.sync.write(decoded, { colorType: 6, bitDepth: 8 });
  if (normalized.length > IMAGE_MAX_BYTES) throw new Error('normalized PNG exceeds 1 MiB');
  return normalized;
}

export class ImageStore {
  private readonly db: Db;
  private readonly clock: Clock;
  constructor(db: Db, clock: Clock) {
    this.db = db;
    this.clock = clock;
  }
  put(sessionId: string, name: string, input: Buffer): ImageAttachment {
    ImageAttachment.shape.name.parse(name);
    if (
      !this.db
        .prepare('SELECT 1 FROM work_sessions WHERE id=? AND archived_at IS NULL')
        .get(sessionId)
    )
      throw new Error('image session is unavailable');
    const body = normalize(input),
      hash = sha256(body);
    const metadata = ImageAttachment.parse({
      kind: 'image_attachment',
      imageId: `image_${hash}`,
      name,
      mime: 'image/png',
      bytes: body.length,
      sha256: hash,
      width: body.readUInt32BE(16),
      height: body.readUInt32BE(20),
    });
    this.db.transaction(() => {
      const existing = this.db
        .prepare('SELECT 1 FROM input_images WHERE session_id=? AND id=?')
        .get(sessionId, metadata.imageId);
      if (existing) return;
      const total = this.db
        .prepare(
          'SELECT COALESCE(sum(length(body)),0) AS bytes FROM input_images WHERE session_id=?',
        )
        .get(sessionId) as { bytes: number };
      if (total.bytes + body.length > 64 * 1024 * 1024)
        throw new Error('session image storage exceeds 64 MiB; start a new session');
      this.db
        .prepare(
          'INSERT INTO input_images (session_id,id,metadata_json,body,created_at) VALUES (?,?,?,?,?)',
        )
        .run(sessionId, metadata.imageId, JSON.stringify(metadata), body, this.clock.nowIso());
    })();
    return metadata;
  }
  read(sessionId: string, reference: ImageAttachment): ImageInput | null {
    const row = this.body(sessionId, reference.imageId);
    if (
      !row ||
      row.metadata.sha256 !== reference.sha256 ||
      row.metadata.bytes !== reference.bytes ||
      row.metadata.width !== reference.width ||
      row.metadata.height !== reference.height ||
      reference.mime !== 'image/png'
    )
      return null;
    return { ...reference, data: row.bytes.toString('base64') };
  }
  body(sessionId: string, imageId: string): { metadata: ImageAttachment; bytes: Buffer } | null {
    const row = this.db
      .prepare('SELECT metadata_json,body FROM input_images WHERE session_id=? AND id=?')
      .get(sessionId, imageId) as { metadata_json: string; body: Buffer } | undefined;
    if (!row) return null;
    const metadata = ImageAttachment.parse(JSON.parse(row.metadata_json));
    if (row.body.length !== metadata.bytes || sha256(row.body) !== metadata.sha256)
      throw new Error('stored image integrity changed');
    return { metadata, bytes: row.body };
  }
}
