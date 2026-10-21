import { createHash } from 'node:crypto';
import {
  BinaryArtifact,
  canonicalJson,
  GENERATED_IMAGE_MAX_BYTES,
  type ImageGenerationOwner,
} from '@corral/contracts';
import type { Db } from '@corral/storage-sqlite';
import { PNG } from 'pngjs';

export function describeGeneratedPng(bytes: Buffer): BinaryArtifact {
  if (
    bytes.length < 45 ||
    bytes.length > GENERATED_IMAGE_MAX_BYTES ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.toString('ascii', 12, 16) !== 'IHDR'
  )
    throw new Error('generated output is not a supported PNG');
  const width = bytes.readUInt32BE(16),
    height = bytes.readUInt32BE(20);
  // Decode budget before inflation; retain original bytes after structural and CRC validation.
  if (!width || !height || width > 8192 || height > 8192 || width * height > 16_777_216)
    throw new Error('generated image dimensions exceed the output policy');
  let offset = 8,
    ended = false,
    headers = 0;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset),
      kind = bytes.toString('ascii', offset + 4, offset + 8);
    if (offset + length + 12 > bytes.length) throw new Error('truncated generated PNG');
    if (kind === 'IHDR') headers++;
    if (kind === 'acTL') throw new Error('animated generated PNG is unsupported');
    offset += length + 12;
    if (kind === 'IEND') {
      ended = length === 0;
      break;
    }
  }
  if (!ended || headers !== 1 || offset !== bytes.length) throw new Error('invalid generated PNG');
  PNG.sync.read(bytes, { checkCRC: true });
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return BinaryArtifact.parse({
    version: 1,
    kind: 'image',
    mime: 'image/png',
    bytes: bytes.length,
    width,
    height,
    sha256,
    blobRef: `media_${sha256}`,
  });
}

export class GeneratedMediaStore {
  private readonly db: Db;
  private readonly now: () => string;
  constructor(db: Db, now: () => string) {
    this.db = db;
    this.now = now;
  }
  put(owner: ImageGenerationOwner, bytes: Buffer): BinaryArtifact {
    const media = describeGeneratedPng(bytes);
    this.db.transaction(() => {
      const old = this.db
        .prepare(
          'SELECT owner_json,descriptor_json FROM generated_media WHERE run_id=? AND (version_id=? OR effect_id=?)',
        )
        .get(owner.runId, owner.artifactVersionId, owner.effectId) as
        | { owner_json: string; descriptor_json: string }
        | undefined;
      if (old) {
        if (old.owner_json !== canonicalJson(owner) || old.descriptor_json !== canonicalJson(media))
          throw new Error('generated artifact identity is immutable');
        return;
      }
      const total = this.db
        .prepare(
          'SELECT COALESCE(SUM(length(body)),0) AS bytes FROM generated_media WHERE run_id=?',
        )
        .get(owner.runId) as { bytes: number };
      if (total.bytes + bytes.length > 256 * 1024 * 1024)
        throw new Error('generated media storage limit reached');
      this.db
        .prepare('INSERT INTO generated_media VALUES (?,?,?,?,?,?,?)')
        .run(
          owner.runId,
          owner.artifactVersionId,
          owner.effectId,
          canonicalJson(owner),
          canonicalJson(media),
          bytes,
          this.now(),
        );
    })();
    return media;
  }
  read(
    runId: string,
    versionId: string,
  ): { media: BinaryArtifact; bytes: Buffer; owner: ImageGenerationOwner } | null {
    const row = this.db
      .prepare(
        'SELECT owner_json,descriptor_json,body FROM generated_media WHERE run_id=? AND version_id=?',
      )
      .get(runId, versionId) as
      | { owner_json: string; descriptor_json: string; body: Buffer }
      | undefined;
    if (!row) return null;
    const media = BinaryArtifact.parse(JSON.parse(row.descriptor_json));
    if (canonicalJson(describeGeneratedPng(row.body)) !== canonicalJson(media))
      throw new Error('generated artifact integrity mismatch');
    return { media, bytes: row.body, owner: JSON.parse(row.owner_json) as ImageGenerationOwner };
  }
  /** Only call with authoritative published event IDs and after the Run is terminal. */
  discardUnpublished(runId: string, published: ReadonlySet<string>): number {
    const rows = this.db
      .prepare('SELECT version_id FROM generated_media WHERE run_id=?')
      .all(runId) as { version_id: string }[];
    return this.db.transaction(() => {
      let removed = 0;
      for (const row of rows)
        if (!published.has(row.version_id))
          removed += this.db
            .prepare('DELETE FROM generated_media WHERE run_id=? AND version_id=?')
            .run(runId, row.version_id).changes;
      return removed;
    })();
  }
}
