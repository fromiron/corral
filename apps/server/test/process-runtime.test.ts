import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { Scheduler } from '@corral/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { killProcessGroup, processGroupGone } from '../src/files/process-group.ts';
import { ownedConnection } from '../src/preview/proxy.ts';
import { spawnOwnedProcess } from '../src/processes/owned-process.ts';
import { CommandRuntime, type OwnedCommandInput } from '../src/processes/runtime.ts';
import { commandEnvironment, listShells, resolveShellCommand } from '../src/processes/shells.ts';

const timers: Scheduler = {
  after(ms, fn) {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};
const live = () => ({ aborted: false, onCancel: (_fn: () => void) => () => {} });
const folders: string[] = [];
const children: ChildProcess[] = [];
async function folder() {
  const path = await mkdtemp(join(tmpdir(), 'corral-command-test-'));
  folders.push(path);
  return path;
}
async function until<T>(work: () => Promise<T | undefined>, milliseconds = 15000): Promise<T> {
  const end = Date.now() + milliseconds;
  do {
    const result = await work();
    if (result !== undefined) return result;
    await delay(50);
  } while (Date.now() < end);
  throw new Error('Expected observable process state did not arrive');
}
async function json(path: string) {
  return until(async () => {
    try {
      return JSON.parse(await readFile(path, 'utf8'));
    } catch {
      return undefined;
    }
  });
}
async function gone(pid: number) {
  return until(async () => {
    try {
      process.kill(pid, 0);
      return undefined;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH' ? true : undefined;
    }
  }, 6000);
}
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) killProcessGroup(child);
  }
  for (const path of folders.splice(0)) await rm(path, { recursive: true, force: true });
});

describe('owned command runtime (real OS processes)', () => {
  it('an unconfirmed connection times out without sending request bytes', async () => {
    let received = 0;
    const server = createServer((socket) =>
      socket.on('data', (bytes) => {
        received += bytes.length;
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('port unavailable');
      await expect(ownedConnection('unowned', address.port, async () => false)).rejects.toThrow();
      expect(received).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15000);
  it.skipIf(process.platform !== 'linux')(
    'waits for the service to accept the connected socket before attesting it',
    async () => {
      const directory = await folder();
      const runtime = new CommandRuntime();
      const service = runtime.startService(
        {
          operationId: 'delayed_accept',
          owner: {
            hostId: 'local',
            sessionId: 's',
            runId: 'r',
            executionId: 'e',
            attemptNo: 1,
            effectId: 'accept',
          },
          directory,
          command: {
            shellId: 'powershell',
            executable: process.execPath,
            args: [
              '-e',
              `
            const fs = require('node:fs'), net = require('node:net');
            const server = net.createServer(socket => socket.on('data', data => fs.writeFileSync('received.json', JSON.stringify(data.toString()))));
            server.listen(0, '127.0.0.1', () => {
              fs.writeFileSync('port.json', JSON.stringify(server.address().port));
              const wait = new Int32Array(new SharedArrayBuffer(4));
              while (!fs.existsSync('accept.flag')) Atomics.wait(wait, 0, 0, 10);
            });
          `,
            ],
          },
          timeoutMs: 20000,
        },
        live(),
      );
      let socket: import('node:net').Socket | undefined;
      try {
        const port = await json(join(directory, 'port.json'));
        let observed: (owned: boolean) => void = () => {};
        const firstCheck = new Promise<boolean>((resolve) => {
          observed = resolve;
        });
        const connecting = ownedConnection(service.operationId, port, async (...args) => {
          const owned = await runtime.attestConnection(...args);
          observed(owned);
          return owned;
        });
        void connecting.catch(() => {});
        expect(await firstCheck).toBe(false);
        await expect(readFile(join(directory, 'received.json'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
        await writeFile(join(directory, 'accept.flag'), '');
        socket = await connecting;
        socket.write('owned');
        expect(await json(join(directory, 'received.json'))).toBe('owned');
      } finally {
        socket?.destroy();
        await runtime.close();
      }
    },
    30000,
  );
  it.skipIf(!['win32', 'linux'].includes(process.platform))(
    'attests an established connection to this exact job and refuses foreign or stale endpoints',
    async () => {
      const directory = await folder();
      const runtime = new CommandRuntime();
      const service = runtime.startService(
        {
          operationId: 'server',
          owner: {
            hostId: 'local',
            sessionId: 's',
            runId: 'r',
            executionId: 'e',
            attemptNo: 1,
            effectId: 'server',
          },
          directory,
          command: {
            shellId: 'powershell',
            executable: process.execPath,
            args: [
              '-e',
              `const s=require('node:net').createServer(c=>{});s.listen(0,'127.0.0.1',()=>require('node:fs').writeFileSync('port.json',JSON.stringify(s.address().port)));`,
            ],
          },
          timeoutMs: 20000,
        },
        live(),
      );
      const port = await json(join(directory, 'port.json'));
      const socket = createConnection({ host: '127.0.0.1', port });
      socket.on('error', () => {}); // Killing the owned server resets this established connection.
      const foreign = createServer();
      await new Promise<void>((resolve) => foreign.listen(0, '127.0.0.1', resolve));
      const foreignPort = (foreign.address() as { port: number }).port;
      const outsider = createConnection({ host: '127.0.0.1', port: foreignPort });
      outsider.on('error', () => {});
      try {
        await Promise.all([once(socket, 'connect'), once(outsider, 'connect')]);
        expect(
          await runtime.attestConnection(service.operationId, port, socket.localPort as number),
        ).toBe(true);
        expect(
          await runtime.attestConnection(
            service.operationId,
            foreignPort,
            outsider.localPort as number,
          ),
        ).toBe(false);
        expect(
          await runtime.attestConnection('another-operation', port, socket.localPort as number),
        ).toBe(false);
        await runtime.stop(service.operationId);
        expect(
          await runtime.attestConnection(service.operationId, port, socket.localPort as number),
        ).toBe(false);
      } finally {
        socket.destroy();
        outsider.destroy();
        foreign.close();
        await runtime.close();
      }
    },
    30000,
  );
  it('executes all installed shell choices with quoted paths and native failure codes', async () => {
    const directory = await folder();
    const script = join(directory, 'script with spaces.cjs');
    await writeFile(script, 'console.log("quoted-output");process.exit(9);');
    const runtime = new CommandRuntime();
    for (const shell of await listShells()) {
      const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
      const command =
        shell.id === 'cmd'
          ? `echo 한글 & "${process.execPath}" "${script}"`
          : shell.id === 'powershell' || shell.id === 'pwsh'
            ? `Write-Output '한글'; & ${quote(process.execPath)} ${quote(script)}`
            : `printf '한글\\n'; ${quote(process.execPath.replaceAll('\\', '/'))} ${quote(script.replaceAll('\\', '/'))}`;
      const result = await runtime.run(
        {
          operationId: shell.id,
          owner: {
            hostId: 'local',
            sessionId: 's',
            runId: 'r',
            executionId: 'e',
            attemptNo: 1,
            effectId: shell.id,
          },
          directory,
          command: await resolveShellCommand(command, shell.id),
          timeoutMs: 20000,
        },
        live(),
      );
      expect(result, shell.id).toMatchObject({ exitCode: 9, cleanupConfirmed: true });
      expect(result.output.text, shell.id).toContain('quoted-output');
      expect(result.output.text, shell.id).toContain('한글');
    }
  }, 60000);
  it('runs a real shell in the chosen worktree, retains native exit code and does not replay duplicate effects', async () => {
    const directory = await folder();
    const runtime = new CommandRuntime();
    const command =
      process.platform === 'win32'
        ? "'hello' | Add-Content -LiteralPath 'result.txt'; [Console]::Error.WriteLine('stderr'); exit 7"
        : "printf 'hello\\n' >> result.txt; printf stderr >&2; exit 7";
    const input: OwnedCommandInput = {
      operationId: 'effect-one',
      owner: {
        hostId: 'local',
        sessionId: 'session-one',
        runId: 'run-one',
        executionId: 'execution-one',
        attemptNo: 1,
        effectId: 'effect-one',
      },
      directory,
      command: await resolveShellCommand(command),
      timeoutMs: 20000,
    };
    const [first, duplicate] = await Promise.all([
      runtime.run(input, live()),
      runtime.run(input, live()),
    ]);
    expect(first).toEqual(duplicate);
    expect(first).toMatchObject({ state: 'completed', exitCode: 7, cleanupConfirmed: true });
    expect(first.output.text).toContain('stderr');
    expect((await readFile(join(directory, 'result.txt'), 'utf8')).trim()).toBe('hello');
    expect(() =>
      runtime.startService(
        { ...input, command: { ...input.command, args: ['different'] } },
        live(),
      ),
    ).toThrow(/identity/);
  }, 30000);

  it('cancels a service and confirms that its real child and grandchild stopped', async () => {
    const directory = await folder();
    const grandchild = join(directory, 'grandchild.cjs');
    const parent = join(directory, 'parent.cjs');
    await writeFile(
      grandchild,
      `require('node:fs').writeFileSync('grandchild.json', JSON.stringify(process.pid)); setInterval(()=>{},1000);`,
    );
    await writeFile(
      parent,
      `const child=require('node:child_process').spawn(process.execPath,[${JSON.stringify(grandchild)}],{stdio:'ignore',detached:process.platform==='win32'}); require('node:fs').writeFileSync('parent.json',JSON.stringify(process.pid)); setInterval(()=>{},1000);`,
    );
    const runtime = new CommandRuntime();
    const lease = runtime.startService(
      {
        operationId: 'service-one',
        owner: {
          hostId: 'local',
          sessionId: 'session-one',
          runId: 'run-one',
          executionId: 'execution-one',
          attemptNo: 1,
          effectId: 'effect-service',
        },
        directory,
        command: {
          shellId: process.platform === 'win32' ? 'powershell' : 'bash',
          executable: process.execPath,
          args: [parent],
        },
        timeoutMs: 20000,
      },
      live(),
    );
    const parentPid = await json(join(directory, 'parent.json'));
    const childPid = await json(join(directory, 'grandchild.json'));
    expect(runtime.list({ sessionId: 'session-one' })[0]?.state).toBe('running');
    const report = await runtime.stop(lease.operationId);
    expect(report).toMatchObject({ state: 'cancelled', cleanupConfirmed: true });
    await gone(parentPid);
    await gone(childPid);
    expect(await runtime.stop(lease.operationId)).toEqual(report);
  }, 30000);

  it('keeps bounded output, reports timeout, and excludes inherited credentials', async () => {
    const directory = await folder();
    const runtime = new CommandRuntime();
    const report = await runtime.run(
      {
        operationId: 'large',
        owner: {
          hostId: 'local',
          sessionId: 'session-one',
          runId: 'run-one',
          executionId: 'execution-one',
          attemptNo: 1,
          effectId: 'large',
        },
        directory,
        command: {
          shellId: process.platform === 'win32' ? 'powershell' : 'bash',
          executable: process.execPath,
          args: ['-e', 'console.log("x".repeat(200000));setInterval(()=>{},1000)'],
        },
        timeoutMs: 8000,
      },
      live(),
    );
    expect(report).toMatchObject({ state: 'failed', timedOut: true, cleanupConfirmed: true });
    expect(report.output.truncated).toBe(true);
    expect(report.output.text.length).toBeLessThan(33000);
    expect(runtime.read('large', 0, 100000)?.text.length).toBeLessThanOrEqual(8192);
    expect(Object.keys(commandEnvironment(directory))).not.toContain('OPENAI_API_KEY');
    expect((await listShells()).length).toBeGreaterThan(0);
    await expect(resolveShellCommand('echo no', 'not-installed')).rejects.toThrow(/not installed/);
  }, 20000);

  it.skipIf(process.platform !== 'win32')(
    'kills the entire native Job if the helper crashes, without falsely confirming cleanup',
    async () => {
      const directory = await folder();
      const child = spawnOwnedProcess(
        process.execPath,
        [
          '-e',
          `const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true});require('node:fs').writeFileSync('pids.json',JSON.stringify([process.pid,c.pid]));setInterval(()=>{},1000)`,
        ],
        { cwd: directory },
      );
      children.push(child);
      const pids = await json(join(directory, 'pids.json'));
      const closed = once(child, 'close');
      child.kill('SIGKILL');
      await closed;
      for (const pid of pids) await gone(pid);
      if (!child.pid) throw new Error('Native job owner did not start');
      expect(await processGroupGone(child.pid, timers)).toBe(false);
    },
    25000,
  );

  it.skipIf(process.platform !== 'win32')(
    'monitors the original host HANDLE and kills descendants after the host exits',
    async () => {
      const directory = await folder();
      const module = fileURLToPath(new URL('../src/processes/owned-process.ts', import.meta.url));
      const hostPath = join(directory, 'host.mjs');
      await writeFile(
        hostPath,
        `import {spawnOwnedProcess} from ${JSON.stringify(new URL(`file:///${module.replaceAll('\\', '/')}`).href)};const c=spawnOwnedProcess(process.execPath,['-e', ${JSON.stringify(`require('node:fs').writeFileSync('target.json',JSON.stringify(process.pid));setInterval(()=>{},1000)`)}],{cwd:${JSON.stringify(directory)}});setInterval(()=>{},1000);`,
      );
      const host = spawn(process.execPath, [hostPath], { stdio: 'ignore' });
      const pid = await json(join(directory, 'target.json'));
      const closed = once(host, 'close');
      host.kill('SIGKILL');
      await closed;
      await gone(pid);
    },
    25000,
  );
});
