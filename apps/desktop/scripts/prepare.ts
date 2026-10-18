import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';

// Deploy the existing packages, preserving every worker/asset path, then compile only our TS.
// Native modules stay on the bundled Node ABI, independent of Electron's Node version.
assert.equal(process.platform, 'linux', 'the current artifact is Linux x64');
assert.equal(process.arch, 'x64');
assert.equal(process.versions.node, '24.19.0', 'build with the reviewed bundled Node 24.19.0');
const desktop = resolve(import.meta.dirname, '..');
const root = resolve(desktop, '../..');
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
rmSync(staging, { recursive: true, force: true });
rmSync(dist, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
mkdirSync(dist, { recursive: true });
execFileSync(
  'pnpm',
  ['--filter', '@corral/server', 'deploy', '--legacy', '--prod', join(staging, 'server')],
  { cwd: root, stdio: 'inherit' },
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
        ts.factory.createStringLiteral(node.arguments[0].text.slice(0, -3) + '.js'),
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
      writeFileSync(dest.slice(0, -3) + '.js', result.outputText);
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
const store = join(staging, 'server/node_modules/.pnpm');
for (const entry of readdirSync(store)) {
  const scope = join(store, entry, 'node_modules/@corral');
  if (!existsSync(scope)) continue;
  for (const name of readdirSync(scope)) internal.add(realpathSync(join(scope, name)));
}
for (const path of internal) {
  assert(path.startsWith(staging), 'deploy must not reference a source checkout');
  compile(path);
}
compile(join(desktop, 'src'), dist);
cpSync(join(desktop, 'src/sidecar.mjs'), join(staging, 'server/sidecar.mjs'));
// The server entry is also the deployed root package, not a dependency of itself.
const sidecar = join(staging, 'server/sidecar.mjs');
writeFileSync(
  sidecar,
  readFileSync(sidecar, 'utf8').replace("from '@corral/server'", "from './src/index.js'"),
);
cpSync(process.execPath, join(staging, 'node'));
cpSync(join(root, 'apps/studio/dist'), join(staging, 'studio'), { recursive: true });
cpSync(join(root, 'THIRD-PARTY-NOTICES'), join(staging, 'THIRD-PARTY-NOTICES'), {
  recursive: true,
});
const nodeLicense = join(dirname(process.execPath), '../LICENSE');
assert(existsSync(nodeLicense), 'the bundled Node distribution must carry its license');
cpSync(nodeLicense, join(staging, 'THIRD-PARTY-NOTICES/Node-LICENSE'));
// Catch missing native modules, unresolved exports, and forgotten TS worker URLs before packaging.
const check = `import { createRequire } from 'node:module'; import { existsSync } from 'node:fs'; import { WORKER_ENTRY, SDK_WORKER_ENTRY, PROTOCOL_VERSION, sdkProcessChannel } from '@corral/adapter-pi'; import { startCorralServer } from './src/index.js'; const require=createRequire(import.meta.url); const Database=createRequire(require.resolve('@corral/storage-sqlite'))('better-sqlite3'); const db=new Database(':memory:'); db.prepare('SELECT 1').get(); db.close(); for (const entry of [WORKER_ENTRY, SDK_WORKER_ENTRY]) if (!existsSync(entry) || !entry.endsWith('.js')) throw new Error('Pi worker missing'); createRequire(require.resolve('@corral/effort-judge'))('onnxruntime-node'); if (typeof startCorralServer !== 'function') throw new Error('server export missing'); const channel=sdkProcessChannel(SDK_WORKER_ENTRY); await new Promise((resolve,reject)=>{let ready=false;const timer=setTimeout(()=>{channel.kill();reject(new Error('SDK worker startup timeout'));},10000);channel.onFrame(frame=>{if(frame.type==='ready'&&frame.protocolVersion===PROTOCOL_VERSION){ready=true;channel.kill();}});channel.onExit(()=>{clearTimeout(timer);ready?resolve():reject(new Error('SDK worker did not load'));});});`;
execFileSync(join(staging, 'node'), ['--input-type=module', '-e', check], {
  cwd: join(staging, 'server'),
  stdio: 'inherit',
});
console.log(
  'Prepared Linux x64 runtime: Node 24.19.0, SQLite, Pi worker, ONNX runtime and Studio.',
);
for (const [path, before] of sourceManifests)
  assert.equal(readFileSync(path, 'utf8'), before, `packaging changed a source manifest: ${path}`);
