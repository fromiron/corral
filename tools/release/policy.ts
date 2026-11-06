import { prerelease, valid } from 'semver';

export const SOURCE_PORTS = [
  {
    name: '@corral/pi-runtime-port',
    version: '0.0.0',
    license: 'LGPL-3.0-only',
    path: 'packages/pi-runtime-port',
    repository: 'vastsa/pi-desktop',
    commit: '1a812ed7b84e0bd1b117080eb4e51c76eba35d48',
  },
  {
    name: 'deepseek-harness-port',
    version: '0.0.0',
    license: 'MIT',
    path: 'packages/adapter-pi/src/ported/dsh',
    repository: 'deepseek-ai/deepseek-harness',
    commit: '22ddee3792402c3e70ec5f86a63c3e3e895a2f60',
  },
] as const;

// Exact expressions reviewed for this pinned tree; an unfamiliar expression blocks release.
const REVIEWED = new Set([
  'MIT',
  'Apache-2.0',
  'MPL-2.0',
  // DOMPurify 3.4.15 offers either already-reviewed license; its Apache-2.0 terms apply.
  '(MPL-2.0 OR Apache-2.0)',
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
  // type-fest via electron-builder → @electron/get → global-agent → serialize-error. Either
  // license is permissive; the MIT terms apply.
  '(MIT OR CC0-1.0)',
  // electron-builder's argparse / filename utilities, reviewed for the Linux build tool graph.
  'Python-2.0',
  'WTFPL OR ISC',
  'WTFPL',
  '(WTFPL OR MIT)',
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
      // Pierre 1.5.2 publishes the SPDX Apache identifier in lowercase.
      const normalized = license === 'apache-2.0' ? 'Apache-2.0' : license;
      if (
        !REVIEWED.has(normalized) &&
        !packages.every((pkg) =>
          pkg.versions.every((version) =>
            SOURCE_PORTS.some(
              (port) =>
                port.name === pkg.name && port.version === version && port.license === normalized,
            ),
          ),
        )
      )
        throw new Error(`Unreviewed license: ${license}`);
      return packages.flatMap((pkg) =>
        pkg.versions.map((version) => {
          assertReviewedVersion(pkg.name, version, license, reviewedPrereleases);
          return { name: pkg.name, version, license: normalized };
        }),
      );
    })
    .sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
  if (!entries.length) throw new Error('Empty license inventory');
  const packages = entries.map((entry, index) => {
    const port = SOURCE_PORTS.find(
      (port) => port.name === entry.name && port.version === entry.version,
    );
    return {
      SPDXID: `SPDXRef-Package-${index + 1}`,
      name: entry.name,
      versionInfo: entry.version,
      downloadLocation: port
        ? `https://github.com/${port.repository}/tree/${port.commit}`
        : `https://registry.npmjs.org/${entry.name}/-/${entry.name.split('/').at(-1)}-${entry.version}.tgz`,
      filesAnalyzed: false,
      licenseConcluded: 'NOASSERTION',
      licenseDeclared: entry.license,
      copyrightText: 'NOASSERTION',
      externalRefs: [
        {
          referenceCategory: 'PACKAGE-MANAGER',
          referenceType: 'purl',
          referenceLocator: port
            ? `pkg:github/${port.repository}@${port.commit}`
            : `pkg:npm/${entry.name.replace('@', '%40')}@${entry.version}`,
        },
      ],
    };
  });
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
