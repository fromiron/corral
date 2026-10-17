// Line diff between two versions (C-030): longest common subsequence, then the edits in order.
// Versions are at most 1 MiB; this is for reading a revision, not for huge files.

export interface DiffLine {
  kind: 'same' | 'added' | 'removed';
  text: string;
}

const MAX_CELLS = 4_000_000;
/** Myers keeps one row per edit step; past this many edits the file is shown as replaced. */
const MAX_EDITS = 2_000;

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  if (a.length * b.length > MAX_CELLS) {
    // Large files: Myers' O(ND) diff aligns them when the edits are few (02-UX-Spec §4).
    const aligned = myers(a, b, MAX_EDITS);
    if (aligned) return aligned;
    // Too many edits to align: show it as replaced rather than freeze the page.
    return [
      ...a.map((text) => ({ kind: 'removed' as const, text })),
      ...b.map((text) => ({ kind: 'added' as const, text })),
    ];
  }
  // lcs[i * width + j] = longest common subsequence of a[i..] and b[j..]
  const width = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * width);
  const at = (i: number, j: number) => lcs[i * width + j] ?? 0;
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] ?? '' });
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      out.push({ kind: 'removed', text: a[i++] ?? '' });
    } else {
      out.push({ kind: 'added', text: b[j++] ?? '' });
    }
  }
  while (i < a.length) out.push({ kind: 'removed', text: a[i++] ?? '' });
  while (j < b.length) out.push({ kind: 'added', text: b[j++] ?? '' });
  return out;
}

/**
 * Myers' greedy shortest edit script (1986), with the trace kept for backtracking. Memory is
 * one row of (n + m) per edit step, so it stops at `maxEdits` and returns null.
 */
function myers(a: string[], b: string[], maxEdits: number): DiffLine[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= Math.min(max, maxEdits); d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0));
      let x = down ? (v[offset + k + 1] ?? 0) : (v[offset + k - 1] ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, offset);
    }
  }
  return null;
}

function backtrack(trace: Int32Array[], a: string[], b: string[], offset: number): DiffLine[] {
  const out: DiffLine[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d] as Int32Array;
    const k = x - y;
    const down = k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0));
    const prevK = down ? k + 1 : k - 1;
    const prevX = v[offset + prevK] ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      out.push({ kind: 'same', text: a[x - 1] ?? '' });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) out.push({ kind: 'added', text: b[y - 1] ?? '' });
      else out.push({ kind: 'removed', text: a[x - 1] ?? '' });
    }
    x = prevX;
    y = prevY;
  }
  return out.reverse();
}
