import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Gold items hold real conversation text, so they may never land inside a Git work tree. */
export function assertPrivateDirectory(dir: string): string {
  const target = resolve(dir);
  for (let at = target; ; at = dirname(at)) {
    if (existsSync(join(at, '.git'))) throw new Error('gold data must stay outside a repository');
    if (at === dirname(at)) break;
  }
  mkdirSync(target, { recursive: true, mode: 0o700 });
  chmodSync(target, 0o700);
  return target;
}

export function writePrivate(path: string, content: string) {
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}
