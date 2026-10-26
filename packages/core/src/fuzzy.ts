// one fuzzy ranking for `@` references, the server's path search and the command
// palette. Letters of each query word must appear in order; runs of letters, word starts and
// the file name (the last path part) count more, and shorter targets win ties.

const BOUNDARY = new Set(['/', '\\', '_', '-', '.', ' ', ':']);

function wordStart(original: string, index: number): boolean {
  if (index === 0) return true;
  const before = original[index - 1] as string;
  const here = original[index] as string;
  if (BOUNDARY.has(before)) return true;
  // camelCase and PascalCase: a capital after a small letter starts a word.
  return before === before.toLowerCase() && here !== here.toLowerCase();
}

/** The best score of `word` (already lower case) inside `original`, or null. */
function matchWord(word: string, original: string): number | null {
  const text = original.toLowerCase();
  let best: number | null = null;
  for (let start = text.indexOf(word[0] as string); start >= 0; ) {
    let score = 0;
    let at = start;
    let previous = -2;
    let ok = true;
    for (const char of word) {
      const found = text.indexOf(char, at);
      if (found < 0) {
        ok = false;
        break;
      }
      score += 1;
      if (found === previous + 1) score += 5;
      if (wordStart(original, found)) score += 8;
      score -= (found - at) * 0.1;
      previous = found;
      at = found + 1;
    }
    if (!ok) break;
    score -= start * 0.05;
    if (best === null || score > best) best = score;
    start = text.indexOf(word[0] as string, start + 1);
  }
  return best;
}

/** How well `query` matches `target`; null when it does not. An empty query matches all. */
export function fuzzyScore(query: string, target: string): number | null {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return 0;
  const name =
    target
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .at(-1) ?? target;
  let total = 0;
  for (const word of words) {
    const inName = matchWord(word, name);
    const inPath = matchWord(word, target);
    if (inPath === null) return null;
    total += inName === null ? inPath : Math.max(inPath, inName + 10);
  }
  return total - target.length * 0.05;
}

/** `items` that match, best first; equal scores keep their input order. */
export function rankFuzzy<T>(
  query: string,
  items: readonly T[],
  key: (item: T) => string,
  limit = Number.POSITIVE_INFINITY,
): T[] {
  if (!query.trim()) return items.slice(0, limit);
  return items
    .flatMap((item, index) => {
      const score = fuzzyScore(query, key(item));
      return score === null ? [] : [{ item, index, score }];
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((x) => x.item);
}
