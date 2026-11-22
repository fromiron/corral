import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
export const ROOT = join(import.meta.dirname, '..', '..');

export function candidateFiles(root = ROOT): string[] {
  return [
    ...new Set(
      execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
        cwd: root,
        encoding: 'utf8',
      })
        .split('\0')
        .filter(Boolean),
    ),
  ].sort();
}

/** Includes staged, unstaged and new source; evidence for another working tree is rejected. */
export function candidateHash(root = ROOT): string {
  const paths = candidateFiles(root);
  const hash = createHash('sha256');
  for (const path of [...new Set(paths)].sort()) {
    hash.update(path).update('\0');
    const entry = lstatSync(join(root, path), { throwIfNoEntry: false });
    hash
      .update(
        !entry
          ? '<deleted>'
          : entry.isSymbolicLink()
            ? readlinkSync(join(root, path))
            : readFileSync(join(root, path)),
      )
      .update('\0');
  }
  return hash.digest('hex');
}
