import { createHash } from 'node:crypto';
import { git } from './git.ts';

export function paddockBranch(title: string, sessionId: string): string {
  const slug =
    title
      .normalize('NFC')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '') || 'session';
  return `corral/${slug}-${createHash('sha256').update(sessionId).digest('hex').slice(0, 6)}`;
}

const exists = (root: string, name: string) =>
  git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`]).then(
    () => true,
    () => false,
  );

export async function freeBranch(root: string, name: string): Promise<string> {
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? name : `${name}-${n}`;
    if (!(await exists(root, candidate))) return candidate;
  }
}
