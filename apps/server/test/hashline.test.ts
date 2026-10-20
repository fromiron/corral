import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  applyHashline,
  HashlineError,
  mergeHashlineEvidence,
  readHashline,
} from '../src/files/hashline.ts';

const scope = { hostId: 'local', runId: 'r1', executionId: 'e1', attempt: 1 };
const path = 'src/example.txt';
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function edit(text: string, ops: string) {
  const bytes = Buffer.from(text);
  const read = readHashline({ bytes, path, scope });
  return applyHashline({ bytes, path, scope, evidence: read.evidence, tag: read.tag, ops });
}
function writeText(result: ReturnType<typeof edit>) {
  expect(result.kind).toBe('write');
  if (result.kind !== 'write') throw new Error('expected write');
  return result.bytes.toString('utf8');
}

describe('Hashline v1', () => {
  it('[TC-ABS-003-H] reads tagged numbered text, then applies all original-coordinate edits atomically', () => {
    const bytes = Buffer.from('one\ntwo\nthree\nfour\n');
    const read = readHashline({ bytes, path, scope });
    expect(read.text).toBe(`[${path}#${read.tag}]\n1:one\n2:two\n3:three\n4:four`);
    expect(read.sha256).toBe(sha(bytes));
    const result = applyHashline({
      bytes,
      path,
      scope,
      evidence: read.evidence,
      tag: read.tag,
      ops: 'PUT 2.=2:\n+TWO\nCUT 3.=3\nPUT >$:\n+five\n',
    });
    expect(writeText(result)).toBe('one\nTWO\nfour\nfive\n');
    expect(result.firstChangedLine).toBe(2);
  });

  it.each(['a\nb\n', 'a\nb', '\ufeffa\r\nb\r\n', '\ufeffa\r\nb'])(
    '[TC-ABS-003-H] preserves UTF-8 BOM, line endings and final newline: %j',
    (text) => {
      const out = writeText(edit(text, 'PUT 2.=2:\n+B'));
      expect(out).toBe(text.replace('b', 'B'));
    },
  );

  it('[TC-ABS-003-H] preserves untouched mixed EOL and supports empty files without inventing a newline', () => {
    expect(writeText(edit('a\r\nb\nc\r\n', 'PUT 2.=2:\n+B'))).toBe('a\r\nB\r\nc\r\n');
    expect(writeText(edit('', 'PUT >$:\n+first'))).toBe('first');
    expect(writeText(edit('a\n', 'CUT 1.=1'))).toBe('');
  });

  it('[TC-ABS-003-H] returns delete and move plans without mutating bytes', () => {
    expect(edit('a\n', 'REM')).toMatchObject({ kind: 'delete', path });
    expect(edit('a\n', 'MV "src/renamed file.txt"')).toMatchObject({
      kind: 'move',
      path,
      to: 'src/renamed file.txt',
    });
  });

  it('[TC-ABS-003-N] short-tag equivalence never authorizes changed bytes or unseen rows', () => {
    const bytes = Buffer.from('a \nb\t\n');
    const read = readHashline({ bytes, path, scope, offset: 1, limit: 1 });
    const changed = Buffer.from('a\nb\n');
    expect(readHashline({ bytes: changed, path, scope }).tag).toBe(read.tag);
    expect(() =>
      applyHashline({
        bytes: changed,
        path,
        scope,
        evidence: read.evidence,
        tag: read.tag,
        ops: 'PUT >$:\n+c',
      }),
    ).toThrow(/changed since/);
    const input = { bytes, path, scope, evidence: read.evidence, tag: read.tag, ops: 'CUT 2.=2' };
    expect(() => applyHashline(input)).toThrow(/not displayed/);
    expect(() => applyHashline(input)).toThrow(/not displayed/);
    expect(read.evidence.ranges).toEqual([{ start: 1, end: 1 }]);
  });

  it('[TC-ABS-003-N] rejects genuine 16-bit collisions using full-byte evidence', () => {
    const seen = new Map<string, Buffer>();
    let collision: { first: Buffer; second: Buffer; tag: string } | undefined;
    for (let i = 0; i < 2000 && !collision; i++) {
      const bytes = Buffer.from(`line ${i}\n`);
      const tag = readHashline({ bytes, path, scope }).tag;
      const first = seen.get(tag);
      if (first) collision = { first, second: bytes, tag };
      seen.set(tag, bytes);
    }
    expect(collision).toBeDefined();
    if (!collision) throw new Error('collision fixture missing');
    const evidence = readHashline({ bytes: collision.first, path, scope }).evidence;
    expect(() =>
      applyHashline({
        bytes: collision.second,
        path,
        scope,
        evidence,
        tag: collision.tag,
        ops: 'REM',
      }),
    ).toThrow(/changed since/);
  });

  it('[TC-ABS-003-N] rejects foreign scope, path, missing read, stale tags even at head/tail', () => {
    const bytes = Buffer.from('a\nb\n');
    const read = readHashline({ bytes, path, scope });
    const input = {
      bytes,
      path,
      scope,
      evidence: read.evidence,
      tag: read.tag,
      ops: 'PUT >$:\n+c',
    };
    for (const field of ['hostId', 'runId', 'executionId'] as const)
      expect(() => applyHashline({ ...input, scope: { ...scope, [field]: 'other' } })).toThrow(
        /scope/,
      );
    expect(() => applyHashline({ ...input, scope: { ...scope, attempt: 2 } })).toThrow(/scope/);
    expect(() => applyHashline({ ...input, path: 'other.txt' })).toThrow(/scope/);
    expect(() => applyHashline({ ...input, evidence: undefined })).toThrow(/read/);
    expect(() => applyHashline({ ...input, tag: read.tag === '0000' ? '0001' : '0000' })).toThrow(
      /tag/,
    );
  });

  it('[TC-ABS-003-N] destructive whole-file ops require complete visible evidence', () => {
    const bytes = Buffer.from('a\nb\n');
    const read = readHashline({ bytes, path, scope, limit: 1 });
    for (const ops of ['REM', 'MV next.txt', 'PUT >$:\n+c', 'PUT <2:\n+x'])
      expect(() =>
        applyHashline({ bytes, path, scope, evidence: read.evidence, tag: read.tag, ops }),
      ).toThrow(/not displayed/);
    const tail = readHashline({ bytes, path, scope, offset: 2, limit: 1 });
    const evidence = mergeHashlineEvidence(read.evidence, tail.evidence);
    expect(applyHashline({ bytes, path, scope, evidence, tag: read.tag, ops: 'REM' }).kind).toBe(
      'delete',
    );
  });

  it.each([
    'PUT 1.=2:\n+x\nCUT 2.=3',
    'PUT <1:\n+x\nPUT <1:\n+y',
    'REM\nPUT <1:\n+x',
    'MV other.txt\nCUT 1.=1',
    'CUT 1.=9999999999999999999999',
    'PUT 1.=1\n+x',
    'PUT 1.=1:\n-old\n+new',
    'PUT 1*=1:\n+x',
    'CUT 1.=1 @register',
    'MV ../outside.txt',
    'MV C:/outside.txt',
    'MV .git/config',
  ])('[TC-ABS-003-N] refuses invalid requests without modifying the source: %s', (ops) => {
    const bytes = Buffer.from('a\nb\nc\n');
    const read = readHashline({ bytes, path, scope });
    const original = Buffer.from(bytes);
    expect(() =>
      applyHashline({ bytes, path, scope, evidence: read.evidence, tag: read.tag, ops }),
    ).toThrow(HashlineError);
    expect(bytes).toEqual(original);
  });

  it('[TC-ABS-003-N] rejects invalid UTF-8/UTF-16/NUL and over-limit source/output', () => {
    for (const bytes of [
      Buffer.from([0xff]),
      Buffer.from([0xff, 0xfe, 0x61, 0]),
      Buffer.from('a\0b'),
    ])
      expect(() => readHashline({ bytes, path, scope })).toThrow(/UTF-8/);
    expect(() => readHashline({ bytes: Buffer.alloc(1024 * 1024 + 1, 97), path, scope })).toThrow(
      /1 MiB/,
    );
    expect(() => edit('a'.repeat(1024 * 1024), `PUT >$:\n+new`)).toThrow(/1 MiB/);
  });

  it('[TC-ABS-003-N] merging reads never carries evidence across revisions or executions', () => {
    const first = readHashline({ bytes: Buffer.from('a\nb\n'), path, scope, limit: 1 }).evidence;
    const second = readHashline({
      bytes: Buffer.from('a\nB\n'),
      path,
      scope,
      offset: 2,
      limit: 1,
    }).evidence;
    expect(mergeHashlineEvidence(first, second)).toEqual(second);
    const foreign = { ...second, scope: { ...scope, executionId: 'other' } };
    expect(mergeHashlineEvidence(second, foreign)).toEqual(foreign);
  });

  it('[TC-ABS-003-N] bounded output grants only complete displayed lines', () => {
    const bytes = Buffer.from('one\ntwo\nthree\n');
    const prefixSize = Buffer.byteLength(JSON.stringify(`[${path}#0000]\n1:one`));
    const read = readHashline({ bytes, path, scope, maxOutputBytes: prefixSize });
    expect(read.text).toBe(`[${path}#${read.tag}]\n1:one`);
    expect(read.evidence.ranges).toEqual([{ start: 1, end: 1 }]);
    expect(read).toMatchObject({ truncated: true, nextOffset: 2 });
    expect(() =>
      applyHashline({
        bytes,
        path,
        scope,
        evidence: read.evidence,
        tag: read.tag,
        ops: 'CUT 2.=2',
      }),
    ).toThrow(/not displayed/);
    expect(() => readHashline({ bytes, path, scope, maxOutputBytes: prefixSize - 1 })).toThrow(
      /no read evidence/,
    );
  });
});
