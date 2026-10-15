import { prerelease, valid } from 'semver';

// Exact expressions reviewed for this pinned tree; an unfamiliar expression blocks release.
const REVIEWED = new Set([
  'MIT',
  'Apache-2.0',
  'MPL-2.0',
  'MIT OR Apache-2.0',
  'MIT-0',
  'BSD-3-Clause',
  'ISC',
  'CC-BY-4.0',
  'BSD-2-Clause',
  'Unlicense',
  'BlueOak-1.0.0',
  'CC0-1.0',
  '0BSD',
]);

export interface LicensedPackage {
  name: string;
  versions: string[];
  paths?: string[];
}
export interface ReviewedPrerelease {
  name: string;
  version: string;
  license: string;
}

export function assertReviewedVersion(
  name: string,
  version: string,
  license: string,
  reviewed: readonly ReviewedPrerelease[],
) {
  if (valid(version) !== version) throw new Error(`Invalid package version: ${name}@${version}`);
  if (
    prerelease(version) &&
    !reviewed.some(
      (entry) => entry.name === name && entry.version === version && entry.license === license,
    )
  )
    throw new Error(`Unreviewed prerelease: ${name}@${version}`);
}
export const GATES = [
  'spec',
  'traceability',
  'dependencies',
  'contracts',
  'lint',
  'typecheck',
  'tests',
  'release-tests',
  'build',
  'e2e',
  'demo-production',
  'performance',
  'inventory',
] as const;
export interface ReleaseEvidence {
  candidate: string;
  gates: Record<string, { status: string; completedAt: string }>;
  live?: {
    candidate: string;
    passed: boolean;
    completedAt: string;
    callsCap: number;
    outputTokensPerCall: number;
  };
}

export function createInventory(
  licenses: Record<string, LicensedPackage[]>,
  candidate: string,
  created: string,
  reviewedPrereleases: readonly ReviewedPrerelease[] = [],
) {
  const entries = Object.entries(licenses)
    .flatMap(([license, packages]) => {
      if (!REVIEWED.has(license)) throw new Error(`Unreviewed license: ${license}`);
      return packages.flatMap((pkg) =>
        pkg.versions.map((version) => {
          assertReviewedVersion(pkg.name, version, license, reviewedPrereleases);
          return { name: pkg.name, version, license };
        }),
      );
    })
    .sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
  if (!entries.length) throw new Error('Empty license inventory');
  const packages = entries.map((entry, index) => ({
    SPDXID: `SPDXRef-Package-${index + 1}`,
    name: entry.name,
    versionInfo: entry.version,
    downloadLocation: `https://registry.npmjs.org/${entry.name}/-/${entry.name.split('/').at(-1)}-${entry.version}.tgz`,
    filesAnalyzed: false,
    licenseConcluded: 'NOASSERTION',
    licenseDeclared: entry.license,
    copyrightText: 'NOASSERTION',
    externalRefs: [
      {
        referenceCategory: 'PACKAGE-MANAGER',
        referenceType: 'purl',
        referenceLocator: `pkg:npm/${entry.name.replace('@', '%40')}@${entry.version}`,
      },
    ],
  }));
  return {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: 'Corral installed dependency inventory',
    documentNamespace: `https://corral.invalid/spdx/${candidate}/${created.replace(/[^0-9]/g, '')}`,
    creationInfo: { created, creators: ['Tool: corral-release-inventory'] },
    comment:
      'Installed runtime and development dependencies on this platform; optional packages for other platforms are not installed. Exact source candidate is encoded in documentNamespace.',
    packages,
    relationships: packages.map((pkg) => ({
      spdxElementId: 'SPDXRef-DOCUMENT',
      relationshipType: 'DESCRIBES',
      relatedSpdxElement: pkg.SPDXID,
    })),
  };
}

export function verifyEvidence(evidence: ReleaseEvidence, candidate: string, requireLive = true) {
  if (evidence.candidate !== candidate)
    throw new Error('Evidence candidate does not match current source');
  for (const gate of GATES) {
    const result = evidence.gates[gate];
    if (result?.status !== 'passed' || !Number.isFinite(Date.parse(result.completedAt)))
      throw new Error(`Missing or failed gate: ${gate}`);
  }
  if (
    requireLive &&
    (evidence.live?.passed !== true ||
      evidence.live.candidate !== candidate ||
      !Number.isFinite(Date.parse(evidence.live.completedAt)) ||
      !Number.isInteger(evidence.live.callsCap) ||
      evidence.live.callsCap < 1 ||
      evidence.live.callsCap > 10 ||
      !Number.isInteger(evidence.live.outputTokensPerCall) ||
      evidence.live.outputTokensPerCall < 1 ||
      evidence.live.outputTokensPerCall > 256)
  ) {
    throw new Error(
      'Missing bounded, passing live smoke evidence for this candidate; no paid call was made',
    );
  }
}
