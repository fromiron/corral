// pnpm deps:record — writes docs/dependency-lock.json (C-002, CRL-DX-002, AGENTS rule 8).
// For every direct, non-workspace dependency: exact version, license, registry integrity,
// publish date, engines and peer ranges, and the workspace packages that use it.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
type Manifest = Record<'dependencies' | 'devDependencies', Record<string, string> | undefined> & {
  name: string;
};

const manifests = [
  'package.json',
  ...['apps', 'packages'].flatMap((dir) =>
    readdirSync(join(ROOT, dir)).map((name) => join(dir, name, 'package.json')),
  ),
].map((path) => JSON.parse(readFileSync(join(ROOT, path), 'utf-8')) as Manifest);

const direct = new Map<string, { version: string; usedBy: Set<string>; dev: boolean }>();
for (const manifest of manifests) {
  for (const kind of ['dependencies', 'devDependencies'] as const) {
    for (const [name, range] of Object.entries(manifest[kind] ?? {})) {
      if (range.startsWith('workspace:')) continue;
      if (!/^\d+\.\d+\.\d+$/.test(range))
        throw new Error(`${manifest.name}: ${name}@${range} is not pinned`);
      const entry = direct.get(name) ?? { version: range, usedBy: new Set(), dev: true };
      if (entry.version !== range)
        throw new Error(`${name} pinned to ${entry.version} and ${range}`);
      entry.usedBy.add(manifest.name);
      entry.dev &&= kind === 'devDependencies';
      direct.set(name, entry);
    }
  }
}

const records = [...direct.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([name, { version, usedBy, dev }]) => {
    const view = JSON.parse(
      execFileSync('pnpm', ['view', `${name}@${version}`, '--json'], { encoding: 'utf-8' }),
    );
    return {
      name,
      version,
      license: view.license ?? null,
      integrity: view.dist?.integrity ?? null,
      published: view.time?.[version] ?? null,
      repository: view.repository?.url ?? null,
      gitHead: view.gitHead ?? null,
      engines: view.engines ?? null,
      peerDependencies: view.peerDependencies ?? null,
      scope: dev ? 'development' : 'runtime',
      usedBy: [...usedBy].sort(),
    };
  });

const out = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  packageManager: JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')).packageManager,
  note: 'Registry facts for pinned direct dependencies. Compatibility evidence is the CI gate result, not this file.',
  dependencies: records,
};
writeFileSync(join(ROOT, 'docs/dependency-lock.json'), `${JSON.stringify(out, null, 2)}\n`);
console.log(`recorded ${records.length} direct dependencies`);
