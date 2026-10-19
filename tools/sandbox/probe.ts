// CR-025 M0: an OS probe, not a sandbox enabled for Corral workers.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const program = `
const fs = require('node:fs');
const net = require('node:net');
const { spawn } = require('node:child_process');
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', async () => {
  const p = JSON.parse(input);
  const privateVisible = fs.existsSync(p.privateFile);
  const network = await new Promise(resolve => {
    const socket = net.connect(p.port, '127.0.0.1');
    socket.setTimeout(1000);
    const done = value => { socket.destroy(); resolve(value); };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
  fs.writeFileSync(p.output, 'probe');
  if (p.keepAlive) spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  process.stdout.write(JSON.stringify({ privateVisible, network,
    namespaces: Object.fromEntries(['pid', 'ipc', 'net'].map(k => [k, fs.readlinkSync('/proc/self/ns/' + k)]))
  }) + '\\n');
  if (p.keepAlive) setInterval(() => {}, 1000);
});
`;

async function processesIn(namespace: string) {
  const ids = await readdir('/proc');
  const matching = await Promise.all(
    ids
      .filter((id) => /^\d+$/.test(id))
      .map(async (id) => {
        try {
          return (await readlink(`/proc/${id}/ns/pid`)) === namespace ? id : null;
        } catch {
          return null;
        }
      }),
  );
  return matching.filter((id) => id !== null);
}

async function probe() {
  if (process.platform !== 'linux') return { status: 'unsupported', reason: 'linux_only' };
  let version: string;
  try {
    version = execFileSync('bwrap', ['--version'], { encoding: 'utf8', timeout: 2000 }).trim();
  } catch {
    return { status: 'unsupported', reason: 'bubblewrap_unavailable' };
  }
  const root = await mkdtemp(join(tmpdir(), 'corral-sandbox-probe-'));
  const work = join(root, 'work');
  await mkdir(work);
  const privateFile = join(root, 'private-sentinel');
  await writeFile(privateFile, 'fixture, never a real credential');
  const server = createServer((socket) => socket.end());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const hostNamespaces = Object.fromEntries(
    await Promise.all(
      ['pid', 'ipc', 'net'].map(async (key) => [key, await readlink(`/proc/self/ns/${key}`)]),
    ),
  );
  const run = async (sandboxed: boolean) => {
    const args = sandboxed
      ? [
          '--unshare-all',
          '--new-session',
          '--die-with-parent',
          '--cap-drop',
          'ALL',
          '--clearenv',
          '--ro-bind',
          '/usr',
          '/usr',
          '--symlink',
          'usr/bin',
          '/bin',
          '--symlink',
          'usr/lib',
          '/lib',
          '--symlink',
          'usr/lib',
          '/lib64',
          '--proc',
          '/proc',
          '--dev',
          '/dev',
          '--tmpfs',
          '/tmp',
          '--ro-bind',
          process.execPath,
          '/node',
          '--bind',
          work,
          '/work',
          '--chdir',
          '/work',
          '--',
          '/node',
          '-e',
          program,
        ]
      : ['-e', program];
    const child = spawn(sandboxed ? 'bwrap' : process.execPath, args, {
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {},
    });
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
    let namespace: string | undefined;
    try {
      const result = await new Promise<{
        privateVisible: boolean;
        network: boolean;
        namespaces: Record<string, string>;
      }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('sandbox probe timed out')), 5000);
        let output = '';
        const finish = () => clearTimeout(timer);
        child.once('error', (error) => {
          finish();
          reject(error);
        });
        child.once('exit', (code) => {
          finish();
          if (!output.includes('\n')) reject(new Error(`probe exited ${code}`));
        });
        child.stdout.on('data', (chunk) => {
          output += chunk.toString();
          if (output.includes('\n')) {
            finish();
            try {
              resolve(JSON.parse(output.slice(0, output.indexOf('\n'))));
            } catch (error) {
              reject(error);
            }
          }
        });
        child.stderr.resume();
        child.stdin.on('error', () => {});
        child.stdin.end(
          JSON.stringify({
            privateFile,
            port: address.port,
            output: sandboxed ? '/work/result' : join(work, 'control'),
            keepAlive: sandboxed,
          }),
        );
      });
      namespace = result.namespaces.pid;
      if (sandboxed) {
        assert.equal(result.privateVisible, false);
        assert.equal(result.network, false);
        for (const key of ['pid', 'ipc', 'net'])
          assert.notEqual(result.namespaces[key], hostNamespaces[key]);
        assert.equal(await readFile(join(work, 'result'), 'utf8'), 'probe');
      } else {
        // The same observation must detect an unisolated process, not always report success.
        assert.equal(result.privateVisible, true);
        assert.equal(result.network, true);
      }
    } finally {
      if (child.pid && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
      if (sandboxed && namespace && namespace !== hostNamespaces.pid) {
        const deadline = Date.now() + 3000;
        while ((await processesIn(namespace)).length && Date.now() < deadline) await delay(20);
        assert.deepEqual(
          await processesIn(namespace),
          [],
          'owned descendants survived cancellation',
        );
      }
    }
  };
  try {
    await run(false);
    await run(true);
    assert.equal(await readFile(privateFile, 'utf8'), 'fixture, never a real credential');
    return {
      status: 'passed',
      platform: process.platform,
      version,
      checks: [
        'unisolated_control',
        'private_file_hidden',
        'worktree_write',
        'host_network_denied',
        'pid_ipc_net_namespaces',
        'stdio_channel',
        'descendant_cleanup',
      ],
      productWorkerSandboxed: false,
    };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}

try {
  const result = await probe();
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'passed') process.exitCode = 3;
} catch {
  console.log(
    JSON.stringify({
      status: 'failed',
      reason: 'sandbox_probe_failed',
      productWorkerSandboxed: false,
    }),
  );
  process.exitCode = 1;
}
