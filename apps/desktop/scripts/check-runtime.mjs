import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
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
  '@corral/local-intelligence',
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
// The local AI ships its pinned download manifest and effort weights; both must load as built.
const local = await import(pathToFileURL(resolved('@corral/local-intelligence')).href);
const bundle = local.bundledManifest();
local.loadEffortClassifier(local.bundledEffortWeights(), {
  dims: bundle.embedding.dims,
  baseModelSha256: bundle.model.sha256,
  preprocessVersion: local.EFFORT_PREPROCESS_VERSION,
});
// The helper must run on this OS/arch: it parses its arguments and tries to load the runtime
// library, which the user installs later, so a missing one is the expected protocol error.
const helper = local.builtHelperPath();
assert(helper && basename(dirname(helper)) === 'bin', 'The local AI helper is not in the runtime');
contained(helper);
const helperRun = spawnSync(
  helper,
  [
    '--lib',
    join(server, 'no-local-ai-library'),
    '--model',
    join(server, 'no-model'),
    '--backend',
    'cpu',
    '--threads',
    '1',
    '--max-input',
    '256',
    '--cache-dir',
    server,
    '--api-major',
    '1',
    '--api-minor',
    '0',
  ],
  {
    encoding: 'utf8',
    // The same minimal environment the engine gives the helper.
    env:
      process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' } : {},
    timeout: 20000,
    windowsHide: true,
  },
);
assert.equal(
  helperRun.status,
  2,
  `Local AI helper did not start: ${helperRun.error?.message ?? helperRun.stderr}`,
);
const helperLine = JSON.parse(helperRun.stdout.trim().split('\n').at(-1));
assert(
  helperLine.type === 'fatal' && helperLine.message.startsWith('cannot load the runtime library'),
  'Local AI helper did not answer with its protocol',
);
contained(require.resolve('node-pty'));
const pty = require('node-pty');
assert.equal(typeof pty.spawn, 'function');
// P07 currently enables user terminals on Linux; other hosts still verify native loading.
if (process.platform === 'linux') {
  await new Promise((resolve, reject) => {
    const terminal = pty.spawn(
      '/bin/sh',
      ['-c', "printf 'CORRAL_PTY_READY\\n'; read -r input; stty size; printf 'CORRAL_PTY_DONE\\n'"],
      { cols: 80, rows: 24, cwd: server, env: { PATH: '/usr/bin:/bin', TERM: 'xterm-256color' } },
    );
    let output = '';
    let resized = false;
    const timer = setTimeout(() => {
      terminal.kill();
      reject(new Error('Bundled Node PTY shell did not finish'));
    }, 30000);
    terminal.onData((data) => {
      output += data;
      if (!resized && output.includes('CORRAL_PTY_READY')) {
        resized = true;
        terminal.resize(101, 37);
        terminal.write('continue\r');
      }
    });
    terminal.onExit(({ exitCode }) => {
      clearTimeout(timer);
      try {
        assert.equal(exitCode, 0, 'Bundled Node PTY shell failed');
        assert.match(output, /\b37 101\b/, 'PTY resize did not reach the shell');
        assert.match(output, /CORRAL_PTY_DONE/, 'PTY input did not reach the shell');
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
}
const native = Object.keys(require.cache).filter((path) => path.endsWith('.node'));
assert(
  native.some((path) => /better-sqlite3|sqlite/.test(path)),
  'SQLite native binding was not loaded',
);
assert(
  native.some((path) => path.includes(`${sep}node-pty${sep}`)),
  'PTY native binding was not loaded',
);
for (const file of Object.keys(require.cache)) contained(file);
for (const file of native) contained(file);
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
  `Runtime containment verified: ${Object.keys(require.cache).length} loaded modules, SQLite/PTY bindings, local AI manifest, weights and helper start, both Pi worker handshakes${process.platform === 'linux' ? ', PTY shell input/101x37 resize/exit' : ''}.`,
);
