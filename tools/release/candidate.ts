import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
export const ROOT = join(import.meta.dirname, '..', '..');

const generatedReports = new Set([
  'docs/evaluation/llm-modernization/report.md',
  'docs/evaluation/llm-modernization/measurements.md',
  'docs/evaluation/llm-modernization/locations.md',
]);

export function candidateFiles(root = ROOT): string[] {
  return [
    ...new Set(
      execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
        cwd: root,
        encoding: 'utf8',
      })
        .split('\0')
        .filter(
          (path) =>
            path &&
            !generatedReports.has(path) &&
            !path.startsWith('docs/evaluation/llm-modernization/evidence/'),
        ),
    ),
  ].sort();
}

/** Includes staged, unstaged and new source; evidence for another working tree is rejected. */
export function candidateHash(root = ROOT): string {
  const paths = candidateFiles(root);
  const hash = createHash('sha256');
  for (const path of [...new Set(paths)].sort()) {
    hash.update(path).update('\0');
    hash
      .update(existsSync(join(root, path)) ? readFileSync(join(root, path)) : '<deleted>')
      .update('\0');
  }
  return hash.digest('hex');
}
