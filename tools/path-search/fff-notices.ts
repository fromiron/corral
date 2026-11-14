// Writes the license texts of the Rust crates compiled into FFF's native library (libfff_c), which
// @ff-labs/fff-bin-* ships and the server loads for path search. Run after changing the FFF
// version, with a checkout of github.com/dmtrKovalenko/fff at the commit npm records for it:
//   node tools/path-search/fff-notices.ts <fff checkout>
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

interface Crate {
  id: string;
  name: string;
  version: string;
  license: string | null;
  manifest_path: string;
  source: string | null;
  repository: string | null;
}
interface Metadata {
  packages: Crate[];
  resolve: {
    nodes: { id: string; deps: { pkg: string; dep_kinds: { kind: string | null }[] }[] }[];
  };
}

const LICENSE = /^(licen[cs]e|copying|unlicense|notice)/i;
const root = resolve(import.meta.dirname, '../..');
const output = join(root, 'THIRD-PARTY-NOTICES/fff-crates.txt');
assert(process.argv[2], 'pass a checkout of github.com/dmtrKovalenko/fff');
const checkout = resolve(process.argv[2]);
assert(existsSync(join(checkout, 'crates/fff-c/Cargo.toml')), 'not a checkout of FFF');

// The version the server installs, and the commit npm says it was published from.
const server = createRequire(join(root, 'apps/server/package.json'));
const fffNode = server.resolve('@ff-labs/fff-node/package.json');
const { version } = JSON.parse(readFileSync(fffNode, 'utf8')) as { version: string };
const gitHead = execFileSync('pnpm', ['view', `@ff-labs/fff-node@${version}`, 'gitHead'], {
  cwd: root,
  encoding: 'utf8',
}).trim();
const head = execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();
assert.equal(head, gitHead, `check out ${gitHead}, which @ff-labs/fff-node@${version} came from`);

// The release workflow builds the library with `-p fff-c --no-default-features --features zlob`.
const metadata = JSON.parse(
  execFileSync(
    'cargo',
    [
      'metadata',
      '--format-version',
      '1',
      '--locked',
      '--no-default-features',
      '--features',
      'zlob',
      '--manifest-path',
      join(checkout, 'crates/fff-c/Cargo.toml'),
    ],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 },
  ),
) as Metadata;
const byId = new Map(metadata.packages.map((crate) => [crate.id, crate]));
const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
const start = metadata.packages.find((crate) => crate.name === 'fff-c' && !crate.source);
assert(start, 'the checkout has no fff-c crate');
const reached = new Set<string>();
const pending = [start.id];
while (pending.length) {
  const id = pending.pop() as string;
  if (reached.has(id)) continue;
  reached.add(id);
  for (const dep of nodes.get(id)?.deps ?? [])
    if (dep.dep_kinds.some((kind) => kind.kind !== 'dev')) pending.push(dep.pkg);
}
const crates = [...reached]
  .map((id) => byId.get(id) as Crate)
  .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
const own = crates.filter((crate) => !crate.source);
const locked = crates.filter((crate) => crate.source);

// Every crate the installed binary names in its panic locations must be in the locked graph.
const { findBinary } = (await import(pathToFileURL(server.resolve('@ff-labs/fff-node')).href)) as {
  findBinary(): string | null;
};
const binary = findBinary();
assert(binary, 'no FFF binary is installed for this platform');
const named = new Set(
  [
    ...readFileSync(binary)
      .toString('latin1')
      .matchAll(/registry\/src\/[^/]+\/([A-Za-z0-9_-]+)-(\d+\.\d+\.\d+[A-Za-z0-9.+-]*)\//g),
  ].map((match) => `${match[1]} ${match[2]}`),
);
const listed = new Set(locked.map((crate) => `${crate.name} ${crate.version}`));
for (const crate of named) assert(listed.has(crate), `${crate} is in the binary but not listed`);

/** License files at the top of a crate, and in the C sources a `-sys` crate compiles in. */
function licenseFiles(dir: string, nested: boolean, depth = 0): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (nested && depth < 5 && !/^(tests?|examples|benches|fuzz|\.\w+)$/i.test(name))
        found.push(...licenseFiles(path, nested, depth + 1));
    } else if (LICENSE.test(name)) found.push(path);
  }
  return found;
}

/** A crate published without a license file: its repository's files at the commit it came from. */
async function upstreamLicenses(crate: Crate): Promise<{ label: string; text: string }[]> {
  const vcs = join(dirname(crate.manifest_path), '.cargo_vcs_info.json');
  const repo = /github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/#?]|$)/.exec(
    crate.repository ?? '',
  );
  if (!existsSync(vcs) || !repo) return [];
  const info = JSON.parse(readFileSync(vcs, 'utf8')) as {
    git?: { sha1?: string };
    path_in_vcs?: string;
  };
  const sha = info.git?.sha1;
  if (!sha) return [];
  for (const folder of [...new Set([info.path_in_vcs ?? '', ''])]) {
    const listing = await fetch(
      `https://api.github.com/repos/${repo[1]}/${repo[2]}/contents/${folder}?ref=${sha}`,
      { headers: { accept: 'application/vnd.github+json' } },
    );
    // A refusal (such as GitHub's rate limit) must not read as "no license file".
    if (listing.status === 404) continue;
    assert(listing.ok, `GitHub answered ${listing.status} for ${crate.name}; try again later`);
    const entries = (await listing.json()) as {
      name: string;
      type: string;
      download_url: string | null;
    }[];
    const files = entries.filter(
      (entry) => entry.type === 'file' && entry.download_url && LICENSE.test(entry.name),
    );
    if (!files.length) continue;
    const texts: { label: string; text: string }[] = [];
    for (const file of files.sort((a, b) => a.name.localeCompare(b.name))) {
      const response = await fetch(file.download_url as string);
      assert(response.ok, `could not fetch ${file.name} of ${crate.name}`);
      const where = `${repo[1]}/${repo[2]} ${sha.slice(0, 12)}${folder ? `/${folder}` : ''}`;
      texts.push({ label: `${file.name} from ${where}`, text: await response.text() });
    }
    return texts;
  }
  return [];
}

const lines = [
  "Rust crates in FFF's native library (libfff_c from @ff-labs/fff-bin-*)",
  '',
  `Generated by tools/path-search/fff-notices.ts from the Cargo.lock of github.com/dmtrKovalenko/fff at ${gitHead}`,
  `(@ff-labs/fff-node ${version}), with the features its release build uses. It lists every locked crate the`,
  'library depends on, including those used only to build it or only on other platforms. The C libraries a',
  '-sys crate compiles in (libgit2, LMDB, zlib, mimalloc) follow that crate. A crate published without a',
  'license file has its repository files at the commit it was published from.',
  '',
  ...own.map((crate) => `${crate.name} ${crate.version}: ${crate.license} (FFF)`),
  ...locked.map((crate) => `${crate.name} ${crate.version}: ${crate.license}`),
];
const seen = new Map<string, string>();
const append = (label: string, raw: string) => {
  const text = raw.replaceAll('\r\n', '\n').trimEnd();
  const hash = createHash('sha256').update(text).digest('hex');
  lines.push('', `----- ${label} -----`, '');
  const same = seen.get(hash);
  if (same) lines.push(`Same text as ${same}.`);
  else {
    seen.set(hash, label);
    lines.push(text);
  }
};
append(
  `FFF ${version} (${own.map((crate) => crate.name).join(', ')}), LICENSE`,
  readFileSync(join(checkout, 'LICENSE'), 'utf8'),
);
let fetched = 0;
let missing = 0;
for (const crate of locked) {
  assert(crate.license, `${crate.name} ${crate.version} declares no license`);
  const dir = dirname(crate.manifest_path);
  const files = licenseFiles(dir, crate.name.endsWith('-sys'));
  for (const file of files)
    append(`${crate.name} ${crate.version}, ${relative(dir, file)}`, readFileSync(file, 'utf8'));
  if (files.length) continue;
  const upstream = await upstreamLicenses(crate);
  for (const file of upstream) append(`${crate.name} ${crate.version}, ${file.label}`, file.text);
  if (upstream.length) fetched++;
  else {
    missing++;
    lines.push(
      '',
      `----- ${crate.name} ${crate.version} -----`,
      '',
      `Published without a license file; it is offered under ${crate.license}${crate.repository ? ` (${crate.repository})` : ''}.`,
    );
  }
}
writeFileSync(output, `${lines.join('\n')}\n`);
console.log(
  `Wrote the notices of ${own.length + locked.length} crates (${named.size} named in the ${relative(root, binary)} binary, ${fetched} from their repositories, ${missing} without a license file) to ${relative(root, output)}`,
);
