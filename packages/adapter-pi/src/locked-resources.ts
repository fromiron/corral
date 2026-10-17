import { createHash } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { canonicalJson, type EffectiveHarnessSnapshot, ResourcePath } from '@corral/contracts';
import type { SdkResources } from './protocol.ts';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

/** Only verified bytes enter the loader's private directory; the installed copy stays untouched. */
export function lockResources(
  resources: SdkResources,
  snapshot: EffectiveHarnessSnapshot,
  directory: string,
): SdkResources {
  const copied = new Map<string, { source: string; destination: string; files: Set<string> }>();
  const total = resources.bundles
    .flatMap((bundle) => bundle.files)
    .reduce((sum, file) => sum + file.bytes, 0);
  if (total > 256 * 1024 * 1024) throw new Error('execution resource size limit exceeded');
  for (const bundle of resources.bundles) {
    if (
      copied.has(bundle.hash) ||
      hash(canonicalJson(bundle.files)) !== bundle.hash ||
      !snapshot.resources.some((resource) => resource.hash === bundle.hash)
    )
      throw new Error('invalid resource manifest');
    const source = realpathSync(bundle.root);
    const destination = join(directory, 'resources', bundle.hash);
    const files = new Set<string>();
    for (const file of bundle.files) {
      ResourcePath.parse(file.path);
      if (files.has(file.path)) throw new Error('duplicate resource path');
      files.add(file.path);
      const from = join(source, file.path);
      if (realpathSync(from) !== from) throw new Error('resource contains a symlink');
      const fd = openSync(from, 'r');
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size !== file.bytes) throw new Error('resource changed');
        const body = Buffer.alloc(file.bytes + 1);
        let read = 0;
        while (read < body.length) {
          const size = readSync(fd, body, read, body.length - read, null);
          if (size === 0) break;
          read += size;
        }
        if (read !== file.bytes || hash(body.subarray(0, read)) !== file.hash)
          throw new Error('resource hash changed');
        const target = join(destination, file.path);
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        writeFileSync(target, body.subarray(0, read), { mode: stat.mode & 0o111 ? 0o700 : 0o600 });
      } finally {
        closeSync(fd);
      }
    }
    copied.set(bundle.hash, { source, destination, files });
  }
  const extensions = resources.extensions.map((extension) => {
    const bundle = copied.get(extension.hash);
    if (!bundle) throw new Error('extension bundle is missing');
    const entry = ResourcePath.parse(
      relative(bundle.source, realpathSync(extension.path)).split(sep).join('/'),
    );
    const ref = snapshot.resources.find(
      (resource) =>
        resource.hash === extension.hash &&
        resource.kind === 'extension' &&
        resource.entry === entry,
    );
    if (
      !ref ||
      !bundle.files.has(entry) ||
      extension.source !== `extension:${ref.name}@${ref.version}`
    )
      throw new Error('extension is not bound');
    return { ...extension, path: join(bundle.destination, entry) };
  });
  for (const skill of resources.skills) {
    const bundle = copied.get(skill.hash);
    const ref = snapshot.resources.find(
      (resource) =>
        resource.hash === skill.hash &&
        resource.kind === 'skill' &&
        resource.entry === skill.entry &&
        resource.skillName === skill.name,
    );
    if (!bundle || !ref || !bundle.files.has(skill.entry)) throw new Error('skill is not bound');
    if (skill.mode !== ref.skillMode) throw new Error('skill mode changed');
    const content = new TextDecoder('utf-8', { fatal: true }).decode(
      readFileSync(join(bundle.destination, skill.entry)),
    );
    if ((skill.content || skill.mode === 'mandatory') && content !== skill.content)
      throw new Error('skill content changed');
  }
  for (const ref of snapshot.resources.filter((resource) => resource.required)) {
    if (
      ref.kind === 'extension' &&
      !extensions.some(
        (extension) =>
          extension.hash === ref.hash &&
          relative(copied.get(ref.hash)?.destination ?? '', extension.path)
            .split(sep)
            .join('/') === ref.entry,
      )
    )
      throw new Error('required extension missing');
    if (
      ref.kind === 'skill' &&
      !resources.skills.some(
        (skill) =>
          skill.hash === ref.hash &&
          skill.entry === ref.entry &&
          (ref.skillMode !== 'mandatory' || skill.content.trim()),
      )
    )
      throw new Error('required skill missing');
  }
  return { ...resources, extensions };
}
