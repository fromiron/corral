import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadCompactTokenizer } from '../src/tokenizer.ts';

const dirs: string[] = [];
function tiny() {
  const dir = mkdtempSync(join(tmpdir(), 'corral-tok-'));
  cpSync(join(import.meta.dirname, 'fixtures', 'tiny'), dir, { recursive: true });
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('compact BPE tokenizer (ported from mixdog)', () => {
  it('applies merges by rank, keeps the template ids and falls back to bytes', () => {
    const tok = loadCompactTokenizer(tiny());
    expect(tok.prefix).toEqual([1]);
    expect(tok.suffix).toEqual([2]);
    expect(tok.encode('ab')).toEqual([5]);
    // ' ' becomes '▁'; "a b" merges first (rank 0), then "▁ ab" (rank 1).
    expect(tok.encode('ab ab')).toEqual([5, 7]);
    // '€' is not in the vocabulary: its UTF-8 bytes are.
    expect(tok.encode('€')).toEqual([9, 10, 11]);
    expect(tok.encode('ab<eos>')).toEqual([5, 2]);
  });

  it('characters with neither a token nor byte ids become unk, and a cached build is reused', () => {
    const dir = tiny();
    expect(loadCompactTokenizer(dir).encode('x')).toEqual([0]);
    // The second load reads tokenizer.bin and must encode identically.
    expect(loadCompactTokenizer(dir).encode('ab ab')).toEqual([5, 7]);
  });
});
