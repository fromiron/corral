// pnpm deps:record — writes docs/dependency-lock.json.
// For every direct, non-workspace dependency: exact version, license, registry integrity,
// publish date, engines and peer ranges, and the workspace packages that use it.
import { execFileSync } from 'node:child_process';
import { existsSync, globSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
type Manifest = Record<
  'dependencies' | 'devDependencies' | 'optionalDependencies',
  Record<string, string> | undefined
> & {
  name: string;
};

const manifests = globSync(
  [
    'package.json',
    'apps/*/package.json',
    'packages/*/package.json',
    'spikes/*/package.json',
    'tests/live/package.json',
  ],
  { cwd: ROOT },
).map((path) => JSON.parse(readFileSync(join(ROOT, path), 'utf-8')) as Manifest);

const direct = new Map<
  string,
  { name: string; version: string; usedBy: Set<string>; dev: boolean }
>();
const evidencePath = join(ROOT, 'docs/dependency-lock.json');
const previous = existsSync(evidencePath) ? JSON.parse(readFileSync(evidencePath, 'utf8')) : {};
// Explicit, version-bound source reviews fill registry omissions; registry facts still win.
const reviewedSources = (previous.reviewedSources ?? []) as {
  name: string;
  version: string;
  repository: string;
  source: string;
}[];
for (const manifest of manifests) {
  for (const kind of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
    for (const [name, range] of Object.entries(manifest[kind] ?? {})) {
      if (range.startsWith('workspace:')) continue;
      if (!/^\d+\.\d+\.\d+$/.test(range))
        throw new Error(`${manifest.name}: ${name}@${range} is not pinned`);
      const key = `${name}@${range}`;
      const entry = direct.get(key) ?? { name, version: range, usedBy: new Set(), dev: true };
      entry.usedBy.add(manifest.name);
      entry.dev &&= kind === 'devDependencies';
      direct.set(key, entry);
    }
  }
}

const records = [...direct.values()]
  .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
  .map(({ name, version, usedBy, dev }) => {
    const view = JSON.parse(
      execFileSync('pnpm', ['view', `${name}@${version}`, '--json'], { encoding: 'utf-8' }),
    );
    return {
      name,
      version,
      license: view.license ?? null,
      integrity: view.dist?.integrity ?? null,
      published: view.time?.[version] ?? null,
      repository:
        view.repository?.url ??
        reviewedSources.find((entry) => entry.name === name && entry.version === version)
          ?.repository ??
        null,
      gitHead: view.gitHead ?? null,
      engines: view.engines ?? null,
      peerDependencies: view.peerDependencies ?? null,
      scope: dev ? 'development' : 'runtime',
      usedBy: [...usedBy].sort(),
    };
  });

// Registry refreshes never create or replace the separately reviewed prerelease exceptions.
const reviewedPrereleases = previous.reviewedPrereleases;
const out = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  packageManager: JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')).packageManager,
  note: 'Registry facts for pinned direct dependencies. Compatibility evidence is the CI gate result, not this file.',
  dependencies: records,
  ...(reviewedSources.length ? { reviewedSources } : {}),
  ...(reviewedPrereleases ? { reviewedPrereleases } : {}),
};
writeFileSync(evidencePath, `${JSON.stringify(out, null, 2)}\n`);
console.log(`recorded ${records.length} direct dependencies`);
