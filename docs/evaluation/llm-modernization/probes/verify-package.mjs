import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const root = process.cwd();
const [packagedRuntime, output] = process.argv.slice(2);
assert(packagedRuntime && output, 'Pass the packaged resources/runtime directory and output JSON.');
const stage = path.join(root, 'apps/desktop/staging');
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const files = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  assert(!entry.isSymbolicLink(), `Non-relocatable link: ${entry.name}`);
  const file = path.join(dir, entry.name);
  return entry.isDirectory() ? files(file) : [file];
});
const manifest = JSON.parse(fs.readFileSync(path.join(stage, 'corresponding-source/manifest.json')));
const sourceHashes = {};
for (const [file, expected] of Object.entries(manifest.files)) {
  assert.equal(hash(path.join(stage, 'corresponding-source/corral', file)), expected, file);
  if (/^(?:apps|packages|patches)\//.test(file) || /^pnpm-|^package.json$/.test(file)) {
    assert.equal(hash(path.join(root, file)), expected, `Source changed: ${file}`);
    sourceHashes[file] = expected;
  }
}
const runtimeHashes = {};
const packagingOmissions = [];
for (const file of files(stage)) {
  const relative = path.relative(stage, file);
  if (path.basename(file) === '.gitkeep' && !fs.existsSync(path.join(packagedRuntime, relative))) {
    packagingOmissions.push(relative);
    continue;
  }
  assert.equal(hash(path.join(packagedRuntime, relative)), hash(file), `Packaged mismatch: ${relative}`);
  runtimeHashes[relative] = hash(file);
}
// Checks source-to-output correspondence, not independent correctness of the shared transformer.
const prepare = ts.createSourceFile('prepare.ts', fs.readFileSync('apps/desktop/scripts/prepare.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const declaration = prepare.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(d => d.name.getText() === 'workerUrls'));
assert(declaration);
const transformer = new Function('ts', `${ts.transpileModule(declaration.getText(), { compilerOptions: { target: ts.ScriptTarget.ES2023 } }).outputText}; return workerUrls;`)(ts);
const packages = [path.join(stage, 'server'), ...fs.readdirSync(path.join(stage, 'server/node_modules/@corral')).map(name => path.join(stage, 'server/node_modules/@corral', name))];
let compiledFiles = 0;
for (const deployed of packages) {
  const name = JSON.parse(fs.readFileSync(path.join(deployed, 'package.json'))).name;
  const source = name === '@corral/server' ? 'apps/server' : `packages/${name.slice('@corral/'.length)}`;
  for (const file of files(path.join(source, 'src')).filter(file => file.endsWith('.ts') && !file.endsWith('.d.ts'))) {
    const result = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      fileName: file,
      compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, rewriteRelativeImportExtensions: true, verbatimModuleSyntax: true },
      transformers: { before: [transformer] },
    });
    const js = path.join(deployed, path.relative(source, file).replace(/\.ts$/, '.js'));
    assert.equal(fs.readFileSync(js, 'utf8'), result.outputText, `Compiled mismatch: ${file}`);
    compiledFiles++;
  }
}
const dependencyHashes = {};
for (const name of ['pi-ai', 'pi-agent-core', 'pi-coding-agent']) {
  const source = `packages/adapter-pi/node_modules/@earendil-works/${name}`;
  for (const file of files(path.join(source, 'dist'))) {
    const relative = path.relative(source, file);
    const deployed = path.join(stage, 'server/node_modules/@earendil-works', name, relative);
    assert.equal(hash(deployed), hash(file), `Dependency mismatch: ${name}/${relative}`);
    dependencyHashes[`${name}/${relative}`] = hash(file);
  }
}
const result = { checkedAt: new Date().toISOString(), candidateAtPackaging: manifest.candidate, sourceFiles: Object.keys(sourceHashes).length, compiledFiles, packagedFiles: Object.keys(runtimeHashes).length, packagingOmissions, sourceHashes, runtimeHashes, dependencyHashes };
fs.writeFileSync(output, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ compiledFiles, packagedFiles: result.packagedFiles, dependencyFiles: Object.keys(dependencyHashes).length }));
