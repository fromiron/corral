// Compact BPE encoder for the effort judge's tokenizer.json.
//
// Derived from mixdog `src/runtime/effort-judge/compact-tokenizer.mjs`
// (https://github.com/tribgames/mixdog, Copyright (c) the Mixdog authors, Apache-2.0; see
// ../NOTICE.md and ../LICENSE-Apache-2.0.txt). Changes for Corral: TypeScript types, a
// dependency-free cache header check, and no other behaviour change.
//
// Supports the layout the judge ships (Replace ' '→'▁' normalizer, Metaspace or effectively no
// pre-tokenizer, BPE with byte fallback). A generic tokenizer library would hold the 256k-entry
// vocabulary and ~580k merges as JavaScript objects (~250 MB); this keeps only what encoding
// needs in typed arrays (~30 MB), built once from tokenizer.json and cached as tokenizer.bin.
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MAGIC = 0x4d585442; // "MXTB"
const VERSION = 3;
const SPACE = '▁';

export interface CompactTokenizer {
  /** Token ids without special tokens. */
  encode(text: string): number[];
  /** Ids the single-sequence template puts before and after the text (<bos> … <eos>). */
  prefix: number[];
  suffix: number[];
}

interface TokenizerJson {
  model?: {
    type?: string;
    vocab: Record<string, number>;
    merges: (string | [string, string])[];
    unk_token?: string;
    continuing_subword_prefix?: string | null;
    end_of_word_suffix?: string | null;
  };
  pre_tokenizer?: {
    type?: string;
    split?: boolean;
    prepend_scheme?: string;
    pattern?: { String?: string };
  };
  normalizer?: { type?: string; pattern?: { String?: string }; content?: string };
  added_tokens?: { content: string; id: number; lstrip?: boolean; rstrip?: boolean }[];
  post_processor?: {
    single?: ({ SpecialToken?: { id: string } } & { Sequence?: unknown })[];
    special_tokens: Record<string, { ids: number[] }>;
  };
}

interface Meta {
  unk: number;
  split: 'metaspace' | 'whole';
  prepend: string;
  added: [string, number, number, number][];
  prefix: number[];
  suffix: number[];
}

function sourceStamp(dir: string): [number, number] {
  const st = statSync(join(dir, 'tokenizer.json'));
  return [st.size, Math.floor(st.mtimeMs)];
}

function build(dir: string): Buffer {
  const json = JSON.parse(readFileSync(join(dir, 'tokenizer.json'), 'utf8')) as TokenizerJson;
  const model = json.model;
  const pre = json.pre_tokenizer;
  const spaceToMeta =
    json.normalizer?.type === 'Replace' &&
    json.normalizer.pattern?.String === ' ' &&
    json.normalizer.content === SPACE;
  let split: Meta['split'] | null = null;
  if (pre?.type === 'Metaspace' && pre.split !== false) split = 'metaspace';
  else if (pre?.type === 'Split' && pre.pattern?.String === ' ' && spaceToMeta) split = 'whole';
  if (
    model?.type !== 'BPE' ||
    !spaceToMeta ||
    !split ||
    model.continuing_subword_prefix ||
    model.end_of_word_suffix
  ) {
    throw new Error('unsupported tokenizer.json layout for the compact encoder');
  }
  const vocab = model.vocab;
  const chars: number[] = [];
  for (const [token, id] of Object.entries(vocab)) {
    const cp = token.codePointAt(0);
    if (cp !== undefined && token.length === String.fromCodePoint(cp).length) chars.push(cp, id);
  }
  const bytes = new Int32Array(256).fill(-1);
  for (let b = 0; b < 256; b++) {
    const id = vocab[`<0x${b.toString(16).toUpperCase().padStart(2, '0')}>`];
    if (id !== undefined) bytes[b] = id;
  }
  const merges = new Int32Array(model.merges.length * 3);
  let n = 0;
  for (const m of model.merges) {
    const [a, b] = Array.isArray(m) ? m : (m.split(' ') as [string, string]);
    const ida = vocab[a];
    const idb = vocab[b];
    const out = vocab[a + b];
    if (ida === undefined || idb === undefined || out === undefined) continue;
    merges[n * 3] = ida;
    merges[n * 3 + 1] = idb;
    merges[n * 3 + 2] = out;
    n++;
  }
  const added = (json.added_tokens ?? []).map((t): [string, number, number, number] => [
    t.content,
    t.id,
    t.lstrip ? 1 : 0,
    t.rstrip ? 1 : 0,
  ]);
  const template = json.post_processor?.single ?? [];
  const specials = json.post_processor?.special_tokens ?? {};
  const specialIds = (entry: { SpecialToken?: { id: string } }) =>
    entry.SpecialToken ? (specials[entry.SpecialToken.id]?.ids ?? []) : [];
  const seqAt = template.findIndex((entry) => entry.Sequence);
  const prefix = seqAt < 0 ? [] : template.slice(0, seqAt).flatMap(specialIds);
  const suffix = seqAt < 0 ? [] : template.slice(seqAt + 1).flatMap(specialIds);
  const meta: Meta = {
    unk: model.unk_token !== undefined ? (vocab[model.unk_token] ?? -1) : -1,
    split,
    prepend: split === 'metaspace' ? pre?.prepend_scheme || 'always' : 'never',
    added,
    prefix,
    suffix,
  };
  const metaBytes = Buffer.from(JSON.stringify(meta), 'utf8');
  const [size, mtime] = sourceStamp(dir);
  const header = new Int32Array([
    MAGIC,
    VERSION,
    size,
    mtime % 2 ** 31,
    chars.length / 2,
    n,
    metaBytes.length,
  ]);
  return Buffer.concat([
    Buffer.from(header.buffer),
    Buffer.from(bytes.buffer),
    Buffer.from(Int32Array.from(chars).buffer),
    Buffer.from(merges.buffer, 0, n * 12),
    metaBytes,
  ]);
}

function readCached(dir: string): Buffer | null {
  try {
    const buf = readFileSync(join(dir, 'tokenizer.bin'));
    const h = new Int32Array(buf.buffer, buf.byteOffset, 7);
    const [size, mtime] = sourceStamp(dir);
    if (h[0] !== MAGIC || h[1] !== VERSION || h[2] !== size || h[3] !== mtime % 2 ** 31)
      return null;
    return buf;
  } catch {
    return null;
  }
}

/** Load (building and caching on first use) the compact encoder for `dir`. */
export function loadCompactTokenizer(dir: string): CompactTokenizer {
  let buf = readCached(dir);
  if (!buf) {
    buf = build(dir);
    writeFileSync(join(dir, 'tokenizer.bin'), buf);
  }
  // Copy into an aligned buffer so typed-array views are valid.
  const ab = new ArrayBuffer(buf.length);
  new Uint8Array(ab).set(buf);
  const h = new Int32Array(ab, 0, 7);
  const nChars = h[4] ?? 0;
  const nMerges = h[5] ?? 0;
  const metaLen = h[6] ?? 0;
  let off = 28;
  const bytes = new Int32Array(ab, off, 256);
  off += 1024;
  const charPairs = new Int32Array(ab, off, nChars * 2);
  off += nChars * 8;
  const merges = new Int32Array(ab, off, nMerges * 3);
  off += nMerges * 12;
  const meta = JSON.parse(Buffer.from(ab, off, metaLen).toString('utf8')) as Meta;

  const charId = new Map<number, number>();
  for (let i = 0; i < nChars; i++) charId.set(charPairs[i * 2] ?? 0, charPairs[i * 2 + 1] ?? 0);

  // Open-addressing table: (left id, right id) -> merge rank; the merged id is merges[rank*3+2].
  let cap = 1;
  while (cap < nMerges * 2) cap <<= 1;
  const slots = new Int32Array(cap).fill(-1);
  const mask = cap - 1;
  const hash = (a: number, b: number) =>
    (Math.imul(a, 0x9e3779b1) ^ Math.imul(b, 0x85ebca77)) & mask;
  const at = (i: number) => merges[i] ?? -1;
  for (let r = 0; r < nMerges; r++) {
    const a = at(r * 3);
    const b = at(r * 3 + 1);
    let s = hash(a, b);
    while (slots[s] !== -1) {
      const o = slots[s] ?? -1;
      if (at(o * 3) === a && at(o * 3 + 1) === b) break; // keep the lowest rank
      s = (s + 1) & mask;
    }
    if (slots[s] === -1) slots[s] = r;
  }
  const rankOf = (a: number, b: number) => {
    let s = hash(a, b);
    while (slots[s] !== -1) {
      const r = slots[s] ?? -1;
      if (at(r * 3) === a && at(r * 3 + 1) === b) return r;
      s = (s + 1) & mask;
    }
    return -1;
  };

  const encoder = new TextEncoder();
  // Min-heap of rank * 2^20 + position: lowest rank first, leftmost on ties — the order the
  // reference BPE applies merges in.
  const POS = 1048576;
  const heap: number[] = [];
  const push = (v: number) => {
    let i = heap.push(v) - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if ((heap[p] ?? 0) <= v) break;
      heap[i] = heap[p] ?? 0;
      i = p;
    }
    heap[i] = v;
  };
  const pop = () => {
    const top = heap[0] ?? 0;
    const last = heap.pop() ?? 0;
    if (heap.length) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= heap.length) break;
        const c = l + 1 < heap.length && (heap[l + 1] ?? 0) < (heap[l] ?? 0) ? l + 1 : l;
        if ((heap[c] ?? 0) >= last) break;
        heap[i] = heap[c] ?? 0;
        i = c;
      }
      heap[i] = last;
    }
    return top;
  };

  function mergeAll(ids: number[]): number[] {
    const n = ids.length;
    const sym = Int32Array.from(ids);
    const next = new Int32Array(n);
    const prev = new Int32Array(n);
    const alive = new Uint8Array(n).fill(1);
    for (let i = 0; i < n; i++) {
      prev[i] = i - 1;
      next[i] = i + 1 < n ? i + 1 : -1;
    }
    heap.length = 0;
    const offer = (i: number) => {
      const j = next[i] ?? -1;
      if (j < 0) return;
      const r = rankOf(sym[i] ?? 0, sym[j] ?? 0);
      if (r !== -1) push(r * POS + i);
    };
    for (let i = 0; i < n - 1; i++) offer(i);
    while (heap.length) {
      const key = pop();
      const r = Math.floor(key / POS);
      const i = key - r * POS;
      const j = next[i] ?? -1;
      // Stale entry: a neighbour already merged away or changed.
      if (!alive[i] || j < 0 || sym[i] !== at(r * 3) || sym[j] !== at(r * 3 + 1)) continue;
      sym[i] = at(r * 3 + 2);
      alive[j] = 0;
      next[i] = next[j] ?? -1;
      const after = next[j] ?? -1;
      if (after >= 0) prev[after] = i;
      const before = prev[i] ?? -1;
      if (before >= 0) offer(before);
      offer(i);
    }
    const out: number[] = [];
    for (let i = 0; i !== -1; i = next[i] ?? -1) out.push(sym[i] ?? 0);
    return out;
  }

  const cache = new Map<string, number[]>();
  function bpe(word: string): number[] {
    const hit = cache.get(word);
    if (hit) return hit;
    const ids: number[] = [];
    for (const ch of word) {
      const id = charId.get(ch.codePointAt(0) ?? 0);
      if (id !== undefined) ids.push(id);
      else
        for (const b of encoder.encode(ch))
          ids.push((bytes[b] ?? -1) >= 0 ? (bytes[b] ?? 0) : meta.unk);
    }
    const syms = ids.length > 1 ? mergeAll(ids) : ids;
    if (cache.size > 20000) cache.clear();
    cache.set(word, syms);
    return syms;
  }

  // metaspace: a piece starts at every '▁'; whole: the segment is one piece.
  function encodeSegment(text: string, out: number[]) {
    let t = text.replaceAll(' ', SPACE);
    if (meta.prepend !== 'never' && !t.startsWith(SPACE)) t = SPACE + t;
    if (meta.split === 'whole') {
      for (const id of bpe(t)) out.push(id);
      return;
    }
    let start = 0;
    for (let i = 1; i <= t.length; i++) {
      if (i === t.length || t[i] === SPACE) {
        if (i > start) out.push(...bpe(t.slice(start, i)));
        start = i;
      }
    }
  }

  const addedSorted = [...meta.added].sort((x, y) => y[0].length - x[0].length);
  function encode(text: string): number[] {
    const out: number[] = [];
    let rest = String(text);
    while (rest.length) {
      let pos = -1;
      let hit: [string, number, number, number] | null = null;
      for (const tok of addedSorted) {
        const p = rest.indexOf(tok[0]);
        if (p !== -1 && (pos === -1 || p < pos)) {
          pos = p;
          hit = tok;
        }
      }
      if (!hit) {
        encodeSegment(rest, out);
        break;
      }
      let before = rest.slice(0, pos);
      let after = rest.slice(pos + hit[0].length);
      if (hit[2]) before = before.replace(/\s+$/u, '');
      if (hit[3]) after = after.replace(/^\s+/u, '');
      if (before) encodeSegment(before, out);
      out.push(hit[1]);
      rest = after;
    }
    return out;
  }

  return { encode, prefix: meta.prefix, suffix: meta.suffix };
}
