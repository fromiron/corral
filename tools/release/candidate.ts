import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
export const ROOT = join(import.meta.dirname, '..', '..');

/** Includes staged, unstaged and new source; evidence for another working tree is rejected. */
export function candidateHash(root = ROOT): string {
  const paths = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: root, encoding: 'utf8' },
  )
    .split('\0')
    .filter(Boolean);
  const hash = createHash('sha256');
  for (const path of [...new Set(paths)].sort()) {
    hash.update(path).update('\0');
    hash
      .update(existsSync(join(root, path)) ? readFileSync(join(root, path)) : '<deleted>')
      .update('\0');
  }
  return hash.digest('hex');
}
