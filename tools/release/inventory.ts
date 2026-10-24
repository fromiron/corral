import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { packageManagerCommand } from '../../apps/desktop/scripts/packaging.ts';
import type { DependencyEvidence } from '../deps/check.ts';
import { candidateHash, ROOT } from './candidate.ts';
import { createInventory, type LicensedPackage, SOURCE_PORTS } from './policy.ts';

const output = join(ROOT, 'test-results/release');
mkdirSync(output, { recursive: true });
if (!process.env.npm_execpath) throw new Error('Run inventory with pnpm release:inventory');
const pnpm = packageManagerCommand(process.env.npm_execpath, process.execPath);
const licenses = JSON.parse(
  execFileSync(pnpm.executable, [...pnpm.args, 'licenses', 'list', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  }),
) as Record<string, LicensedPackage[]>;
for (const port of SOURCE_PORTS) {
  const packages = licenses[port.license] ?? [];
  licenses[port.license] = packages;
  if (!packages.some((pkg) => pkg.name === port.name))
    packages.push({ name: port.name, versions: [port.version], paths: [join(ROOT, port.path)] });
}
const evidence = JSON.parse(
  readFileSync(join(ROOT, 'docs/dependency-lock.json'), 'utf8'),
) as DependencyEvidence;
const bom = createInventory(
  licenses,
  candidateHash(),
  new Date().toISOString(),
  evidence.reviewedPrereleases,
);
const bomPath = join(output, 'sbom.spdx.json');
writeFileSync(bomPath, `${JSON.stringify(bom, null, 2)}\n`);
// SPDX 2.3's official vendored schema; use the same jsonschema dependency as spec:check.
execFileSync(
  process.env.CORRAL_PYTHON ?? 'python3',
  [
    '-I',
    '-c',
    'import json,sys; from jsonschema import Draft7Validator; Draft7Validator(json.load(open(sys.argv[1]))).validate(json.load(open(sys.argv[2])))',
    join(import.meta.dirname, 'spdx.schema.json'),
    bomPath,
  ],
  { stdio: 'inherit' },
);
const notices: string[] = [
  'SPDX 2.3 JSON Schema — SPDX Project\nSource: https://github.com/spdx/spdx-spec/blob/v2.3/schemas/spdx-schema.json\nVendored for validation; JSON whitespace reformatted only. License: CC-BY-3.0\n\n' +
    readFileSync(join(import.meta.dirname, 'SPDX-SCHEMA-LICENSE.txt'), 'utf8'),
];
for (const [license, packages] of Object.entries(licenses)) {
  for (const pkg of packages) {
    const texts = new Set<string>();
    for (const path of pkg.paths ?? []) {
      for (const file of readdirSync(path, { withFileTypes: true })) {
        if (file.isFile() && /^(licen[sc]e|notice|copying)(\.|$)/i.test(file.name))
          texts.add(readFileSync(join(path, file.name), 'utf8'));
      }
    }
    notices.push(
      `## ${pkg.name} ${pkg.versions.join(', ')} (${license})\n\n${[...texts].join('\n\n') || 'No top-level notice shipped; see package source and declared license.'}`,
    );
  }
}
writeFileSync(join(output, 'THIRD-PARTY-NOTICES.txt'), `${notices.join('\n\n')}\n`);
console.log(
  `License policy passed: ${bom.packages.length} package versions; SPDX inventory and bundled notices in test-results/release`,
);
