import { readdirSync, rmdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** Every file the removed effort judge (`corral judge install`) wrote into its folder. */
const JUDGE_FILES = [
  'model.onnx',
  'tokenizer.json',
  'calibration.json',
  'install.json',
  'tokenizer.bin',
];

/**
 * Removes the files the old effort judge installed, and its folder once nothing else is left.
 * Anything Corral did not write there is kept. Never recursive.
 */
export function cleanupLegacyJudge(dir: string): { removed: number; kept: string[] } {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { removed: 0, kept: [] };
  }
  const ours = new Set(JUDGE_FILES.flatMap((name) => [name, `${name}.part`]));
  let removed = 0;
  for (const name of entries) {
    if (!ours.has(name)) continue;
    rmSync(join(dir, name), { force: true });
    removed++;
  }
  const kept = entries.filter((name) => !ours.has(name)).sort();
  if (kept.length === 0) {
    try {
      rmdirSync(dir);
    } catch {
      // Another process wrote into it meanwhile; leave it.
    }
  }
  return { removed, kept };
}
