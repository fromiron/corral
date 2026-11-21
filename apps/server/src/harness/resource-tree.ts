import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { canonicalJson, type HarnessResource, ResourcePath } from '@corral/contracts';

/**
 * The one place a resource's identity is computed: installation, verification and the built-in
 * generator (`pnpm builtin:generate`) all hash a tree with `treeHash(scan(root))`.
 */
const MAX_RESOURCE_BYTES = 128 * 1024 * 1024;
export const hash = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');
export const treeHash = (files: HarnessResource['files']) => hash(canonicalJson(files));

export function inside(root: string, target: string) {
  const path = relative(root, target);
  return !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`);
}

/** Dereference only internal links, and hash exactly the bytes copied for review. */
export function scan(root: string, copyTo?: string): HarnessResource['files'] {
  const base = realpathSync(root);
  const files: HarnessResource['files'] = [];
  let bytes = 0;
  const walk = (folder: string, prefix: string, ancestors: Set<string>) => {
    const actual = realpathSync(folder);
    if (!inside(base, actual)) throw new Error('resource link points outside its root');
    if (ancestors.has(actual)) throw new Error('resource link cycle');
    const next = new Set([...ancestors, actual]);
    for (const name of readdirSync(folder).sort()) {
      if (name === '.git') continue;
      if (
        name === '.corral' ||
        name === '.npmrc' ||
        /^\.env(?:\.|$)/.test(name) ||
        ['auth.json', 'credentials.json'].includes(name)
      )
        throw new Error('resource contains private configuration');
      const path = prefix ? `${prefix}/${name}` : name;
      ResourcePath.parse(path);
      const source = join(folder, name);
      if (!inside(base, realpathSync(source)))
        throw new Error('resource link points outside its root');
      const info = statSync(source);
      if (info.isDirectory()) {
        walk(source, path, next);
        continue;
      }
      if (!info.isFile()) throw new Error('resource contains a non-file entry');
      if (files.length >= 10_000 || bytes + info.size > MAX_RESOURCE_BYTES)
        throw new Error('resource size limit exceeded');
      const body = readFileSync(source);
      bytes += body.length;
      if (bytes > MAX_RESOURCE_BYTES) throw new Error('resource size limit exceeded');
      if (copyTo) {
        const destination = join(copyTo, path);
        mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
        writeFileSync(destination, body, { mode: info.mode & 0o100 ? 0o700 : 0o600 });
      }
      files.push({ path, hash: hash(body), bytes: body.length });
    }
  };
  walk(base, '', new Set());
  return files;
}
