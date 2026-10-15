import { execFileSync } from 'node:child_process';
import { existsSync, globSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { prerelease, satisfies, valid } from 'semver';
import { ROOT } from '../release/candidate.ts';
import { assertReviewedVersion, type LicensedPackage } from '../release/policy.ts';

interface Manifest {
  name: string;
  version: string;
  license?: string;
  engines?: { node?: string };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

interface DependencyRecord {
  name: string;
  version: string;
  license: string;
  engines: Manifest['engines'] | null;
  peerDependencies: Manifest['peerDependencies'] | null;
  integrity: string;
  repository: string;
  published: string;
  review?: string;
}

export interface DependencyEvidence {
  dependencies: DependencyRecord[];
  reviewedPrereleases?: DependencyRecord[];
}

function readManifest(path: string): Manifest {
  return JSON.parse(readFileSync(path, 'utf8')) as Manifest;
}

function installedManifest(name: string, from: string): string | undefined {
  const paths = createRequire(join(from, 'package.json')).resolve.paths(name) ?? [];
  const path = paths.map((base) => join(base, name, 'package.json')).find(existsSync);
  return path ? realpathSync(path) : undefined;
}

function checkRecord(manifest: Manifest, record: DependencyRecord) {
  if (
    !record.integrity ||
    !record.repository ||
    !Number.isFinite(Date.parse(record.published)) ||
    manifest.license !== record.license ||
    !isDeepStrictEqual(manifest.engines ?? {}, record.engines ?? {}) ||
    !isDeepStrictEqual(manifest.peerDependencies ?? {}, record.peerDependencies ?? {})
  )
    throw new Error(`Dependency review metadata differs: ${manifest.name}@${manifest.version}`);
}

function checkNode(manifest: Manifest, nodeVersion: string) {
  if (manifest.engines?.node && !satisfies(nodeVersion, manifest.engines.node))
    throw new Error(
      `Node ${nodeVersion} is incompatible with ${manifest.name}${manifest.version ? `@${manifest.version}` : ''}: ${manifest.engines.node}`,
    );
}

export function checkDependencies(
  root: string,
  licenses: Record<string, LicensedPackage[]>,
  nodeVersion = process.versions.node,
) {
  const evidence = JSON.parse(
    readFileSync(join(root, 'docs/dependency-lock.json'), 'utf8'),
  ) as DependencyEvidence;
  const reviewed = evidence.reviewedPrereleases ?? [];
  const records = new Map(
    evidence.dependencies.map((record) => [`${record.name}@${record.version}`, record]),
  );
  const manifests = globSync(
    [
      'package.json',
      'apps/*/package.json',
      'packages/*/package.json',
      'spikes/*/package.json',
      'tests/live/package.json',
    ],
    { cwd: root },
  );
  for (const relative of manifests) {
    const path = join(root, relative);
    const manifest = readManifest(path);
    checkNode(manifest, nodeVersion);
    for (const [name, version] of Object.entries({
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.optionalDependencies,
    })) {
      if (version.startsWith('workspace:')) continue;
      if (valid(version) !== version)
        throw new Error(`Dependency is not exactly pinned: ${name}@${version}`);
      const record = records.get(`${name}@${version}`);
      if (!record) throw new Error(`Unreviewed dependency: ${name}@${version}`);
      const installed = installedManifest(name, dirname(path));
      if (!installed) throw new Error(`Missing installed dependency: ${name}@${version}`);
      const actual = readManifest(installed);
      if (actual.name !== name || actual.version !== version)
        throw new Error(`Installed version differs: ${name}@${version}`);
      checkRecord(actual, record);
    }
  }
  for (const [license, packages] of Object.entries(licenses)) {
    for (const pkg of packages) {
      if (!pkg.paths?.length) throw new Error(`Missing installed metadata: ${pkg.name}`);
      for (const path of pkg.paths) {
        const actual = readManifest(join(path, 'package.json'));
        if (actual.name !== pkg.name || !pkg.versions.includes(actual.version))
          throw new Error(`Installed version differs: ${pkg.name}`);
        assertReviewedVersion(actual.name, actual.version, license, reviewed);
        if (prerelease(actual.version)) {
          const record = reviewed.find(
            (entry) => entry.name === actual.name && entry.version === actual.version,
          );
          if (!record?.review)
            throw new Error(`Missing prerelease review: ${actual.name}@${actual.version}`);
          checkRecord(actual, record);
        }
        checkNode(actual, nodeVersion);
        for (const [peer, range] of Object.entries(actual.peerDependencies ?? {})) {
          const peerPath = installedManifest(peer, path);
          if (!peerPath) {
            if (actual.peerDependenciesMeta?.[peer]?.optional) continue;
            throw new Error(`Missing peer ${peer}@${range} for ${actual.name}@${actual.version}`);
          }
          const peerVersion = readManifest(peerPath).version;
          if (!satisfies(peerVersion, range))
            throw new Error(
              `Incompatible peer ${peer}@${peerVersion} for ${actual.name}@${actual.version}: ${range}`,
            );
        }
      }
    }
  }
}

if (import.meta.main) {
  try {
    const licenses = JSON.parse(
      execFileSync('pnpm', ['licenses', 'list', '--json'], {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      }),
    ) as Record<string, LicensedPackage[]>;
    checkDependencies(ROOT, licenses);
    console.log(
      'Dependency review passed: exact direct versions, reviewed prereleases, installed Node and peer compatibility',
    );
  } catch (error) {
    console.error(
      error instanceof Error && !('code' in error)
        ? error.message
        : 'Dependency metadata unavailable; install the locked dependencies with the required Node version',
    );
    process.exitCode = 1;
  }
}
