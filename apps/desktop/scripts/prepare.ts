import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { helperFileName } from '../../../packages/local-intelligence/src/engine/helper.ts';
import { candidateFiles, candidateHash } from '../../../tools/release/candidate.ts';
import {
  assertRelocatableRuntime,
  NODE_VERSION,
  nodeLicensePath,
  packageManagerCommand,
  runtimeTarget,
} from './packaging.ts';

// Deploy the existing packages, preserving every worker/asset path, then compile only our TS.
// Native modules stay on the bundled Node ABI, independent of Electron's Node version.
const target = runtimeTarget(process.platform, process.arch);
assert.equal(
  process.versions.node,
  NODE_VERSION,
  `build with the reviewed bundled Node ${NODE_VERSION}`,
);
const nodeLicense = nodeLicensePath(process.execPath);
// Launch pnpm's actual JS/native entry, avoiding Windows .cmd shell quoting and PATHEXT.
const pnpmEntry = process.env.npm_execpath;
assert(
  pnpmEntry && existsSync(pnpmEntry),
  'Run this script with pnpm --filter @corral/desktop prepare:runtime',
);
const pnpmCommand = packageManagerCommand(pnpmEntry, process.execPath);
const desktop = resolve(import.meta.dirname, '..');
const root = resolve(desktop, '../..');
const candidate = candidateHash(root);
const sourceManifests = [
  join(root, 'apps/server/package.json'),
  ...readdirSync(join(root, 'packages')).map((name) =>
    join(root, 'packages', name, 'package.json'),
  ),
]
  .filter(existsSync)
  .map((path) => [path, readFileSync(path, 'utf8')] as const);
const staging = join(desktop, 'staging');
const dist = join(desktop, 'dist');
assert(
  existsSync(join(root, 'apps/studio/dist/index.html')),
  'build Studio before preparing the desktop runtime',
);
for (const path of [staging, dist]) {
  assert(['staging', 'dist'].includes(relative(desktop, path)), 'cleanup must stay within desktop');
  rmSync(path, { recursive: true, force: true });
}
mkdirSync(staging, { recursive: true });
mkdirSync(dist, { recursive: true });
execFileSync(
  pnpmCommand.executable,
  [
    ...pnpmCommand.args,
    '--filter',
    '@corral/server',
    '--config.node-linker=hoisted',
    '--config.prefer-symlinked-executables=false',
    '--config.inject-workspace-packages=true',
    '--offline',
    'deploy',
    '--prod',
    join(staging, 'server'),
  ],
  { cwd: root, stdio: 'inherit', windowsHide: true },
);

const workerUrls: ts.TransformerFactory<ts.SourceFile> = (context) => {
  const visit: ts.Visitor = (node) => {
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'URL' &&
      node.arguments?.[0] &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text.endsWith('.ts')
    ) {
      return ts.factory.updateNewExpression(node, node.expression, node.typeArguments, [
        ts.factory.createStringLiteral(`${node.arguments[0].text.slice(0, -3)}.js`),
        ...node.arguments.slice(1),
      ]);
    }
    return ts.visitEachChild(node, visit, context);
  };
  return (file) => ts.visitNode(file, visit) as ts.SourceFile;
};

function compile(path: string, output = path) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (['node_modules', 'test', 'dist', '.git'].includes(entry.name)) continue;
    const input = join(path, entry.name);
    const dest = join(output, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(dest, { recursive: true });
      compile(input, dest);
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      const result = ts.transpileModule(readFileSync(input, 'utf8'), {
        fileName: input,
        compilerOptions: {
          target: ts.ScriptTarget.ES2023,
          module: ts.ModuleKind.ESNext,
          rewriteRelativeImportExtensions: true,
          verbatimModuleSyntax: true,
        },
        transformers: { before: [workerUrls] },
      });
      writeFileSync(`${dest.slice(0, -3)}.js`, result.outputText);
      if (input === dest) rmSync(input);
    } else if (input !== dest && entry.isFile()) cpSync(input, dest);
  }
  const manifest = join(output, 'package.json');
  if (existsSync(manifest)) {
    const value = JSON.parse(readFileSync(manifest, 'utf8'));
    const text = JSON.stringify(
      value,
      (_key, item: unknown) =>
        typeof item === 'string' && item.startsWith('./') && item.endsWith('.ts')
          ? `${item.slice(0, -3)}.js`
          : item,
      2,
    );
    // pnpm may hard-link manifests to the source checkout. Replace, never truncate that inode.
    writeFileSync(`${manifest}.desktop`, `${text}\n`);
    renameSync(`${manifest}.desktop`, manifest);
  }
}

const internal = new Set<string>([join(staging, 'server')]);
assertRelocatableRuntime(staging);
function collectInternalPackages(modules: string) {
  if (!existsSync(modules)) return;
  for (const entry of readdirSync(modules, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const path = join(modules, entry.name);
    const packages = entry.name.startsWith('@')
      ? readdirSync(path, { withFileTypes: true })
          .filter((item) => item.isDirectory())
          .map((item) => join(path, item.name))
      : [path];
    for (const directory of packages) {
      const manifest = join(directory, 'package.json');
      if (
        existsSync(manifest) &&
        JSON.parse(readFileSync(manifest, 'utf8')).name?.startsWith('@corral/')
      )
        internal.add(directory);
      collectInternalPackages(join(directory, 'node_modules'));
    }
  }
}
collectInternalPackages(join(staging, 'server/node_modules'));
for (const path of internal) {
  const inside = relative(staging, path);
  assert(
    !inside.startsWith('..') && !isAbsolute(inside),
    'deploy must not reference a source checkout',
  );
  compile(path);
}
// The local AI helper is native: build it for this host from the pinned crates and ship it in the
// deployed package's bin/, where the engine looks first.
const localAi = [...internal].find(
  (path) =>
    JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')).name ===
    '@corral/local-intelligence',
);
assert(localAi, 'the server deployment must include @corral/local-intelligence');
const helperCrate = join(root, 'packages/local-intelligence/helper');
try {
  execFileSync(
    'cargo',
    ['build', '--release', '--locked', '--manifest-path', join(helperCrate, 'Cargo.toml')],
    { cwd: root, stdio: 'inherit', windowsHide: true },
  );
} catch (error) {
  throw new Error('Building the local AI helper failed; it needs a Rust toolchain (cargo).', {
    cause: error,
  });
}
const helperName = helperFileName(target.platform);
mkdirSync(join(localAi, 'bin'), { recursive: true });
cpSync(join(helperCrate, 'target/release', helperName), join(localAi, 'bin', helperName));
compile(join(desktop, 'src'), dist);
cpSync(join(desktop, 'src/sidecar.mjs'), join(staging, 'server/sidecar.mjs'));
// The server entry is also the deployed root package, not a dependency of itself.
const sidecar = join(staging, 'server/sidecar.mjs');
for (const [path, before] of sourceManifests)
  assert.equal(readFileSync(path, 'utf8'), before, `packaging changed a source manifest: ${path}`);
writeFileSync(
  sidecar,
  readFileSync(sidecar, 'utf8').replace("from '@corral/server'", "from './src/index.js'"),
);
const bundledNode = join(staging, target.node);
cpSync(process.execPath, bundledNode);
cpSync(join(desktop, 'build/icon.png'), join(staging, 'icon.png'));
cpSync(join(root, 'apps/studio/dist'), join(staging, 'studio'), { recursive: true });
cpSync(join(root, 'THIRD-PARTY-NOTICES'), join(staging, 'THIRD-PARTY-NOTICES'), {
  recursive: true,
});
cpSync(nodeLicense, join(staging, 'THIRD-PARTY-NOTICES/Node-LICENSE'));
// The browser includes LGPL budget code; ship the corresponding application and library sources for rebuilding it.
const sourceDirectory = join(staging, 'corresponding-source', 'corral');
const sourceHashes: Record<string, string> = {};
for (const path of candidateFiles(root)) {
  const source = join(root, path);
  if (!existsSync(source)) continue;
  const target = join(sourceDirectory, path);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target);
  sourceHashes[path] = createHash('sha256').update(readFileSync(target)).digest('hex');
}
writeFileSync(
  join(staging, 'corresponding-source', 'manifest.json'),
  JSON.stringify({ candidate, files: sourceHashes }, null, 2),
);
execFileSync(pnpmCommand.executable, [...pnpmCommand.args, 'release:inventory'], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true,
});
cpSync(join(root, 'test-results/release/sbom.spdx.json'), join(staging, 'sbom.spdx.json'));
cpSync(
  join(root, 'test-results/release/THIRD-PARTY-NOTICES.txt'),
  join(staging, 'THIRD-PARTY-NOTICES/installed-packages.txt'),
);
// Catch missing native modules, unresolved exports, and forgotten TS worker URLs before packaging.
const checkEnv = { ...process.env };
for (const name of ['NODE_PATH', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE']) delete checkEnv[name];
execFileSync(bundledNode, [join(desktop, 'scripts/check-runtime.mjs'), join(staging, 'server')], {
  cwd: join(staging, 'server'),
  stdio: 'inherit',
  windowsHide: true,
  env: checkEnv,
});
const inventory = assertRelocatableRuntime(staging);
assert.equal(candidateHash(root), candidate, 'build inputs changed while preparing the runtime');
writeFileSync(
  join(staging, 'runtime.json'),
  JSON.stringify(
    {
      platform: target.platform,
      arch: target.arch,
      version: NODE_VERSION,
      dependencyLayout: 'physical-hoisted',
      sourceCandidate: candidate,
    },
    null,
    2,
  ),
);
console.log(
  `Prepared ${target.platform} ${target.arch} runtime: Node ${NODE_VERSION}, SQLite, both Pi workers, local AI assets and helper, PTY runtime and Studio; ${inventory.files} physical files, zero links.`,
);
