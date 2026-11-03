// Cosine agreement between two result files written by the reference or bench scripts.
// Usage: node bench/compare.ts <a.json> <b.json>
import { readFileSync } from 'node:fs';

type Result = { results: { id: string; embedding: number[] }[] };
const [a, b] = process.argv.slice(2).map((path) => JSON.parse(readFileSync(path!, 'utf8')) as Result);
if (!a || !b) throw new Error('usage: compare <a.json> <b.json>');

const other = new Map(b.results.map((row) => [row.id, row.embedding]));
const cosines: number[] = [];
for (const row of a.results) {
  const vector = other.get(row.id);
  if (!vector) continue;
  let dot = 0;
  let na = 0;
  let nb = 0;
  row.embedding.forEach((value, i) => {
    dot += value * vector[i]!;
    na += value * value;
    nb += vector[i]! * vector[i]!;
  });
  const cosine = dot / Math.sqrt(na * nb);
  cosines.push(cosine);
  console.log(`${row.id.padEnd(14)} ${cosine.toFixed(4)}`);
}
cosines.sort((x, y) => x - y);
console.log(`min ${cosines[0]!.toFixed(4)}  median ${cosines[Math.floor(cosines.length / 2)]!.toFixed(4)}`);

// Rank agreement: does each fixture's nearest neighbour stay the same across runtimes?
function nearest(rows: { id: string; embedding: number[] }[]) {
  return new Map(
    rows.map((row) => {
      let best = '';
      let bestScore = -Infinity;
      for (const other of rows) {
        if (other.id === row.id) continue;
        const score = row.embedding.reduce((sum, value, i) => sum + value * other.embedding[i]!, 0);
        if (score > bestScore) [best, bestScore] = [other.id, score];
      }
      return [row.id, best] as const;
    }),
  );
}
const na = nearest(a.results);
const nb = nearest(b.results);
const same = [...na].filter(([id, n]) => nb.get(id) === n).length;
console.log(`nearest-neighbour agreement ${same}/${na.size}`);
