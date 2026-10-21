import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import {
  CorralPackageManifest,
  type PackageManifestMetadata,
  ResourcePath,
} from '@corral/contracts';

const MAX_MANIFEST_BYTES = 256 * 1024;
function inside(root: string, path: string) {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}

/** Reads only the reviewed copy; package scripts, extensions and MCP servers are never imported. */
export function inspectPackageManifest(
  directory: string,
  packagePath: string | null = null,
): PackageManifestMetadata | null {
  if (packagePath !== null && !ResourcePath.safeParse(packagePath).success)
    throw new Error('invalid package location');
  const root = realpathSync(directory);
  const target = packagePath === null ? root : join(root, packagePath);
  if (!inside(root, realpathSync(target))) throw new Error('invalid package location');
  const file = join(target, 'package.json');
  if (!existsSync(file)) return null;
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || !inside(root, realpathSync(file)))
    throw new Error('invalid package location');
  if (stat.size > MAX_MANIFEST_BYTES) throw new Error('package manifest size limit exceeded');
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error('invalid package manifest JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new Error('invalid package manifest JSON');
  if (!Object.hasOwn(raw, 'corral')) return null;
  const parsed = CorralPackageManifest.safeParse((raw as Record<string, unknown>).corral);
  // Do not echo untrusted manifest values (including rejected credentials) in API errors.
  if (!parsed.success) throw new Error('invalid Corral package manifest');
  return parsed.data;
}
