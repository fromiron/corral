import assert from 'node:assert/strict';
import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

// Resolve from the deployed server manifest, never this build script or the checkout.
const server = realpathSync(resolve(process.argv[2]));
const runtime = dirname(server);
const contained = (file) => {
  const actual = realpathSync(file);
  const inside = relative(runtime, actual);
  assert(
    !isAbsolute(inside) && inside !== '..' && !inside.startsWith(`..${sep}`),
    `Runtime dependency escaped its package: ${file}`,
  );
  return actual;
};
contained(process.execPath);
const require = createRequire(join(server, 'package.json'));
const resolved = (name) => contained(require.resolve(name));
for (const name of [
  '@corral/core',
  '@corral/contracts',
  '@corral/adapter-pi',
  '@corral/storage-sqlite',
  '@corral/effort-judge',
])
  resolved(name);
const pi = await import(pathToFileURL(resolved('@corral/adapter-pi')).href);
const { startCorralServer } = await import(
  pathToFileURL(contained(join(server, 'src/index.js'))).href
);
assert.equal(typeof startCorralServer, 'function');
const storageRequire = createRequire(resolved('@corral/storage-sqlite'));
contained(storageRequire.resolve('better-sqlite3'));
const Database = storageRequire('better-sqlite3');
const database = new Database(':memory:');
assert.equal(database.prepare('SELECT 1 AS value').get().value, 1);
database.close();
const judgeRequire = createRequire(resolved('@corral/effort-judge'));
contained(judgeRequire.resolve('onnxruntime-node'));
judgeRequire('onnxruntime-node');
const native = Object.keys(require.cache).filter((path) => path.endsWith('.node'));
assert(
  native.some((path) => /better-sqlite3|sqlite/.test(path)),
  'SQLite native binding was not loaded',
);
assert(
  native.some((path) => path.includes('onnxruntime')),
  'ONNX native binding was not loaded',
);
for (const file of Object.keys(require.cache)) contained(file);
for (const file of native) {
  const actual = contained(file);
  if (process.platform === 'win32' && basename(actual).includes('onnxruntime')) {
    for (const name of ['onnxruntime.dll', 'DirectML.dll', 'dxcompiler.dll', 'dxil.dll']) {
      const library = join(dirname(actual), name);
      assert(existsSync(library), `ONNX companion missing: ${name}`);
      contained(library);
    }
  }
}
const processEntry = resolved('@corral/adapter-pi/processes');
for (const name of ['windows-job.ps1', 'windows-job.cs'])
  contained(join(dirname(processEntry), name));
for (const [entry, start, protocol] of [
  [pi.WORKER_ENTRY, pi.processChannel, pi.LEGACY_PROTOCOL_VERSION],
  [pi.SDK_WORKER_ENTRY, pi.sdkProcessChannel, pi.PROTOCOL_VERSION],
]) {
  assert(entry.endsWith('.js'), 'Pi worker must be compiled');
  contained(entry);
  const channel = start(entry);
  await new Promise((resolve, reject) => {
    let ready = false;
    const timer = setTimeout(() => {
      channel.kill();
      reject(new Error('Pi worker startup timeout'));
    }, 20000);
    channel.onFrame((frame) => {
      if (frame.type === 'ready' && frame.protocolVersion === protocol) {
        ready = true;
        channel.kill();
      }
    });
    channel.onExit(() => {
      clearTimeout(timer);
      if (ready) resolve();
      else reject(new Error('Pi worker did not load'));
    });
  });
}
console.log(
  `Runtime containment verified: ${Object.keys(require.cache).length} loaded modules, SQLite/ONNX bindings and both Pi worker handshakes.`,
);
