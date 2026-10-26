import { type ChildProcess, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Scheduler } from '@corral/contracts';
import { FakeClock } from '@corral/testkit';
import { afterEach, expect, it } from 'vitest';
import { LspRunner } from '../src/files/lsp.ts';
import { killProcessGroup, processGroupGone } from '../src/files/process-group.ts';
import { VerificationRunner } from '../src/files/verification.ts';
import {
  HostProcessCapacityError,
  ownedProcessStarted,
  spawnOwnedProcess,
} from '../src/processes/owned-process.ts';
import { CommandRuntime } from '../src/processes/runtime.ts';

const timers: Scheduler = {
  after(ms, callback) {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  },
};
const live = { aborted: false, onCancel: () => () => {} };
const directories: string[] = [];
const runtimes: CommandRuntime[] = [];
const children: ChildProcess[] = [];
const cancellations: AbortController[] = [];
const checks: Promise<unknown>[] = [];
afterEach(async () => {
  for (const controller of cancellations.splice(0)) controller.abort();
  await Promise.all(checks.splice(0));
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      killProcessGroup(child);
      await closed;
    }
    if (child.pid) await processGroupGone(child.pid, timers);
  }
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error('Process did not reach the expected observable state');
}

it('shares twelve host slots across real commands, registered checks and language servers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'corral-host-capacity-'));
  directories.push(directory);
  const root = join(directory, 'source');
  execFileSync('git', ['init', '-q', root]);
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], { cwd: root })
      .toString()
      .trim();
  await writeFile(
    join(root, 'check.cjs'),
    `require('node:fs').writeFileSync('ready','yes');setInterval(()=>{},1000)`,
  );
  git('add', '.');
  git('commit', '-qm', 'fixture');
  const tree = git('rev-parse', 'HEAD^{tree}');
  const runtime = new CommandRuntime();
  runtimes.push(runtime);
  const services = Array.from({ length: 11 }, (_, index) =>
    runtime.startService(
      {
        operationId: `service-${index}`,
        owner: {
          hostId: 'local',
          sessionId: 'session',
          runId: 'run',
          executionId: 'execution',
          attemptNo: 1,
          effectId: `service-${index}`,
        },
        directory,
        command: {
          shellId: process.platform === 'win32' ? 'powershell' : 'bash',
          executable: process.execPath,
          args: ['-e', 'setInterval(()=>{},1000)'],
        },
        timeoutMs: 90000,
      },
      live,
    ),
  );
  expect(await Promise.all(services.map((service) => service.started))).toEqual(
    Array(11).fill(true),
  );
  const controller = new AbortController();
  cancellations.push(controller);
  const copyRoot = join(directory, 'checks');
  const check = new VerificationRunner({ clock: new FakeClock(), timers }).run(
    {
      verificationId: 'check_1',
      owner: {
        kind: 'execution',
        runId: 'check_run',
        executionId: 'check_execution',
        attemptNo: 1,
        effectId: 'check_effect',
      },
      sessionId: 'check_session',
      sourceDirectory: root,
      copyRoot,
      tree,
      configRevision: 1,
      fingerprint: 'a'.repeat(64),
      command: {
        id: 'check',
        name: 'Check',
        argv: [process.execPath, 'check.cjs'],
        timeoutMs: 60000,
      },
    },
    {
      get aborted() {
        return controller.signal.aborted;
      },
      onCancel(callback) {
        controller.signal.addEventListener('abort', callback);
        return () => controller.signal.removeEventListener('abort', callback);
      },
    },
  );
  checks.push(check);
  await until(async () =>
    readFile(join(copyRoot, 'check_1', 'ready'), 'utf8').then(
      (text) => text === 'yes',
      () => false,
    ),
  );
  const lsp = new LspRunner({ clock: new FakeClock(), timers });
  const query = {
    cwd: directory,
    argv: [process.execPath, fileURLToPath(new URL('./fixtures/lsp-server.mjs', import.meta.url))],
    timeoutMs: 15000,
    document: {
      uri: pathToFileURL(join(directory, 'source.ts')).href,
      text: 'value',
      languageId: 'typescript',
      version: 1,
    },
    operation: 'definition' as const,
    position: { line: 0, character: 0 },
  };
  await expect(lsp.query(query, live)).rejects.toThrow(/Host process capacity reached/);
  controller.abort();
  expect(await check).toMatchObject({ state: 'cancelled', cleanupConfirmed: true });
  expect(await lsp.query(query, live)).toMatchObject({ kind: 'locations' });
  // LSP's default owned transport must return its shared slot after cleanup.
  const child = spawnOwnedProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
  children.push(child);
  expect(await ownedProcessStarted(child)).toBe(true);
  expect(() => spawnOwnedProcess(process.execPath, ['-e', ''])).toThrow(HostProcessCapacityError);
  const closed = once(child, 'close');
  killProcessGroup(child);
  await closed;
  // A leader close alone is insufficient; retain capacity until the group is attested gone.
  expect(() => spawnOwnedProcess(process.execPath, ['-e', ''])).toThrow(HostProcessCapacityError);
  expect(await processGroupGone(child.pid as number, timers)).toBe(true);
  // A failed launch must release its reservation without needing PID-based confirmation.
  try {
    const missing = spawnOwnedProcess(join(directory, 'missing-executable'), []);
    const error = once(missing, 'error');
    await error;
  } catch (error) {
    expect(error).not.toBeInstanceOf(HostProcessCapacityError);
  }
  const replacement = spawnOwnedProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
  children.push(replacement);
  expect(await ownedProcessStarted(replacement)).toBe(true);
}, 120000);

it.skipIf(process.platform !== 'win32')(
  'retains an unknown native Job cleanup reservation after its owner crashes',
  async () => {
    const processes = Array.from({ length: 12 }, () => {
      const child = spawnOwnedProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
      children.push(child);
      return child;
    });
    expect(await Promise.all(processes.map(ownedProcessStarted))).toEqual(Array(12).fill(true));
    const crashed = processes[0] as ChildProcess;
    const closed = once(crashed, 'close');
    crashed.kill('SIGKILL');
    await closed;
    expect(await processGroupGone(crashed.pid as number, timers)).toBe(false);
    expect(() => spawnOwnedProcess(process.execPath, ['-e', ''])).toThrow(HostProcessCapacityError);
  },
  60000,
);
