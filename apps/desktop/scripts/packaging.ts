import assert from 'node:assert/strict';
import { existsSync, lstatSync, readdirSync, readlinkSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const NODE_VERSION = '24.19.0';

/** Hoisted runtime packages are physical trees: junctions cannot survive installation moves. */
export function assertRelocatableRuntime(root: string) {
  const inventory = { files: 0, directories: 0, links: [] as { path: string; target: string }[] };
  const visit = (path: string) => {
    const entry = lstatSync(path);
    if (entry.isSymbolicLink()) {
      inventory.links.push({ path, target: readlinkSync(path) });
    } else if (entry.isDirectory()) {
      inventory.directories++;
      for (const name of readdirSync(path)) visit(join(path, name));
    } else if (entry.isFile()) {
      inventory.files++;
    } else {
      throw new Error(`Unsupported runtime filesystem entry: ${path}`);
    }
  };
  visit(resolve(root));
  assert.equal(
    inventory.links.length,
    0,
    `Runtime contains ${inventory.links.length} non-relocatable links; run prepare:runtime with the hoisted deployment.`,
  );
  return inventory;
}

export function packageManagerCommand(entry: string, node: string) {
  assert(
    !/\.(cmd|bat)$/i.test(entry),
    'Use pnpm with a JavaScript or native executable entry, not a shell wrapper.',
  );
  return /\.[cm]?js$/i.test(entry)
    ? { executable: node, args: [entry] }
    : { executable: entry, args: [] };
}

export function runtimeTarget(platform: string, arch: string) {
  assert(
    ['win32', 'darwin', 'linux'].includes(platform),
    `Unsupported desktop platform: ${platform}`,
  );
  assert(['x64', 'arm64'].includes(arch), `Unsupported desktop architecture: ${arch}`);
  return { platform, arch, node: platform === 'win32' ? 'node.exe' : 'node' };
}

export function assertRuntimeIdentity(value: unknown, platform: string, arch: string) {
  const runtime = value as { platform?: string; arch?: string; version?: string } | null;
  assert(
    runtime?.platform === platform && runtime.arch === arch && runtime.version === NODE_VERSION,
    'Run prepare:runtime on this host before packaging; cross-compiling native dependencies is unsupported.',
  );
}

export function nodeLicensePath(executable: string) {
  const directory = dirname(executable);
  const license = [join(directory, 'LICENSE'), join(directory, '../LICENSE')].find(
    (path) => existsSync(path) && statSync(path).isFile(),
  );
  assert(
    license,
    'The bundled Node distribution must carry its license beside node.exe or above bin/node.',
  );
  return license;
}
