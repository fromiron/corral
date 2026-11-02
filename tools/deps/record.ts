// pnpm deps:record — writes docs/dependency-lock.json.
// For every direct, non-workspace dependency: exact version, license, registry integrity,
// publish date, engines and peer ranges, and the workspace packages that use it.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, globSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nativeEvidence } from './native.ts';

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
if (process.argv.includes('--native')) {
  const source = process.argv[process.argv.indexOf('--native') + 1];
  if (!source) throw new Error('a native build evidence report is required');
  const helperHash = createHash('sha256')
    .update(readFileSync(join(ROOT, 'packages/local-intelligence/decision-helper/main.cpp')))
    .digest('hex');
  const nativeDependencies = nativeEvidence(JSON.parse(readFileSync(source, 'utf8')), helperHash);
  writeFileSync(evidencePath, `${JSON.stringify({ ...previous, nativeDependencies }, null, 2)}\n`);
  console.log(`recorded ${nativeDependencies.dependencies.length} native source dependencies`);
  process.exit(0);
}
// Offline classifier training is Python-only; record its separately pinned tool environment
// without refreshing unrelated npm records or adding it to the shipped Node runtime.
if (process.argv.includes('--training')) {
  const requirementsFiles = [
    'tools/local-intelligence/training-requirements.txt',
    'tools/local-intelligence/research/mgte-requirements.txt',
    'tools/local-intelligence/research/fast-requirements.txt',
    'tools/local-intelligence/research/harness-validation/swebench-requirements.txt',
  ];
  const sources = new Map<string, string[]>();
  for (const file of requirementsFiles) {
    for (const pin of readFileSync(join(ROOT, file), 'utf8').trim().split('\n')) {
      if (!pin.trim() || pin.trimStart().startsWith('#')) continue;
      sources.set(pin, [...(sources.get(pin) ?? []), file]);
    }
  }
  const pins = [...sources.keys()];
  const trainingDependencies = await Promise.all(
    pins.map(async (pin) => {
      const [name, version] = pin.split('==');
      if (!name || !version || !/^\d+\.\d+\.\d+$/.test(version))
        throw new Error('training dependencies must be pinned');
      const source = `https://pypi.org/pypi/${name}/${version}/json`;
      const response = await fetch(source);
      if (!response.ok) throw new Error(`training dependency metadata unavailable: ${name}`);
      const view = (await response.json()) as {
        info: {
          version: string;
          license: string;
          license_expression?: string;
          requires_python: string;
          requires_dist: string[];
          project_urls: Record<string, string>;
        };
        urls: { packagetype: string; digests: { sha256: string } }[];
      };
      if (view.info.version !== version) throw new Error('training dependency version differs');
      return {
        name,
        version,
        scope: 'offline-training',
        usedBy: sources.get(pin),
        source,
        license: view.info.license_expression || view.info.license,
        sourceSha256: view.urls.find((file) => file.packagetype === 'sdist')?.digests.sha256,
        python: view.info.requires_python,
        requires: view.info.requires_dist,
        officialSources: view.info.project_urls,
        nodeCompatibility:
          'Not loaded by Node or included in the application runtime; Python >=3.11 training only.',
      };
    }),
  );
  writeFileSync(
    evidencePath,
    `${JSON.stringify({ ...previous, trainingDependencies }, null, 2)}\n`,
  );
  console.log(`recorded ${trainingDependencies.length} offline training dependencies`);
  process.exit(0);
}
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
  ...(previous.trainingDependencies ? { trainingDependencies: previous.trainingDependencies } : {}),
  ...(previous.nativeDependencies ? { nativeDependencies: previous.nativeDependencies } : {}),
};
writeFileSync(evidencePath, `${JSON.stringify(out, null, 2)}\n`);
console.log(`recorded ${records.length} direct dependencies`);
