import { createHash } from 'node:crypto';
import { openDatabase } from '@corral/storage-sqlite';
import { FakeClock } from '@corral/testkit';
import { PNG } from 'pngjs';
import { expect, it } from 'vitest';
import { ImageStore } from '../src/images.ts';

it('image bytes are normalized, immutable and scoped to the owning session', () => {
  const db = openDatabase(':memory:');
  try {
    db.prepare(
      "INSERT INTO work_sessions (id,project_id,corral_id,title,objective,pinned,revision,created_at,updated_at,archived_at,entries_json) VALUES ('session_1','default',NULL,'Images','',0,1,'x','x',NULL,'[]')",
    ).run();
    const images = new ImageStore(db, new FakeClock());
    const pixel = new PNG({ width: 1, height: 1 });
    pixel.data = Buffer.from([255, 0, 0, 255]);
    const source = PNG.sync.write(pixel);
    const ref = images.put('session_1', 'red.png', source);
    const body = images.read('session_1', ref);
    expect(body).toMatchObject({ ...ref, mime: 'image/png', width: 1, height: 1 });
    expect(createHash('sha256').update(Buffer.from(body!.data, 'base64')).digest('hex')).toBe(
      ref.sha256,
    );
    expect(images.put('session_1', 'red.png', source)).toEqual(ref);
    expect(images.read('different_session', ref)).toBeNull();
    expect(images.read('session_1', { ...ref, sha256: '0'.repeat(64) })).toBeNull();
    expect(() => images.put('session_1', '../red.png', source)).toThrow();
    expect(() =>
      images.put('session_1', 'html.png', Buffer.from('<html>not an image</html>')),
    ).toThrow();
    const corrupt = Buffer.from(source);
    corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
    expect(() => images.put('session_1', 'corrupt.png', corrupt)).toThrow();
    const huge = Buffer.from(source);
    huge.writeUInt32BE(65535, 16);
    expect(() => images.put('session_1', 'huge.png', huge)).toThrow();
    const interlaced = Buffer.from(source);
    interlaced[28] = 1;
    expect(() => images.put('session_1', 'interlaced.png', interlaced)).toThrow();
    const duplicateHeader = Buffer.concat([source.subarray(0, 33), source.subarray(8)]);
    expect(() => images.put('session_1', 'duplicate.png', duplicateHeader)).toThrow();
  } finally {
    db.close();
  }
});
