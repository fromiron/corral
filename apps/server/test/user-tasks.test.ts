import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkspaceTarget } from '@corral/contracts';
import { openDatabase } from '@corral/storage-sqlite';
import { FakeClock } from '@corral/testkit';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkspaceService } from '../src/files/service.ts';

// Real child processes share CI workers; this is a runaway limit, not a latency assertion.
vi.setConfig({ testTimeout: 40_000 });

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'corral-tasks-'));
  const original = join(root, 'original');
  execFileSync('git', ['init', '-q', '-b', 'main', original]);
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], { cwd: original });
  const port = await freePort();
  writeFileSync(
    join(original, 'package.json'),
    JSON.stringify({
      name: 'fixture',
      scripts: {
        serve: 'node server.js',
        prepare: "node -e \"require('fs').writeFileSync('prepared','x')\"",
      },
    }),
  );
  writeFileSync(
    join(original, 'server.js'),
    `require('http').createServer((q,s)=>s.end('hello from task')).listen(${port},'127.0.0.1',()=>console.log('listening ${port}'));\n`,
  );
  writeFileSync(join(original, 'a.txt'), 'one\n');
  git('add', '.');
  git('commit', '-qm', 'first');
  const db = openDatabase(':memory:');
  db.prepare(
    "INSERT INTO work_sessions(id,project_id,corral_id,title,objective,pinned,revision,created_at,updated_at,entries_json) VALUES('s1','default',NULL,'t','',0,1,'x','x','[]')",
  ).run();
  const make = () =>
    new WorkspaceService({
      db,
      clock: new FakeClock(),
      worktreeRoot: join(root, 'copies'),
      forbidden: [],
      hostId: 'host-test',
    });
  let service = make();
  cleanups.push(async () => {
    await service.dispose();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  await service.bind('default', original);
  await service.configure('default', { trusted: true });
  const view = await service.createWorktree('s1', 'default');
  const target: WorkspaceTarget = {
    hostId: 'host-test',
    projectId: 'default',
    bindingId: view.bindingId,
    sessionId: 's1',
    copyGeneration: view.copyGeneration,
  };
  const copy = service.copyOf('s1')?.worktree;
  if (!copy) throw new Error('fixture copy missing');
  const output = async (operationId: string, text: string) =>
    vi.waitFor(() => expect(service.taskOutput('s1', operationId, 0)?.text ?? '').toContain(text), {
      timeout: 15_000,
    });
  return {
    get service() {
      return service;
    },
    restart: () => {
      // The old service is abandoned with its child running, as after a host crash.
      service = make();
    },
    root,
    copy,
    port,
    target,
    output,
  };
}

/** A real connection to the port, as the preview proxy makes before attesting. */
async function connection(port: number): Promise<Socket> {
  const socket = connect(port, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('error', reject);
  });
  cleanups.push(() => {
    socket.destroy();
  });
  return socket;
}

it('[TC-WBD-011-H] [TC-WBD-011-N] lists scripts without running them, runs one on request, attests its port and stops it', async () => {
  const s = await setup();
  const candidates = await s.service.taskCandidates('s1');
  expect(candidates).toMatchObject({
    packageManager: 'npm',
    scripts: expect.arrayContaining([{ name: 'serve', command: 'node server.js' }]),
  });
  // Discovery is not execution: the prepare script did not run.
  expect(existsSync(join(s.copy, 'prepared'))).toBe(false);
  await expect(
    s.service.startTask('s1', { operationId: 'task_missing', target: s.target, script: 'nope' }),
  ).rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' });

  const started = await s.service.startTask('s1', {
    operationId: 'task_serve',
    target: s.target,
    script: 'serve',
  });
  expect(started).toMatchObject({ operationId: 'task_serve', script: 'serve', state: 'running' });
  await s.output('task_serve', `listening ${s.port}`);
  expect((await s.service.tasks('s1')).map((task) => [task.operationId, task.state])).toEqual([
    ['task_serve', 'running'],
  ]);
  const socket = await connection(s.port);
  expect(
    await s.service.attestCommandConnection('s1', 'task_serve', s.port, socket.localPort ?? 0),
  ).toBe(true);

  // Another process's port is not this task's.
  const otherPort = await freePort();
  const other = spawn(process.execPath, [
    '-e',
    `require('net').createServer(()=>{}).listen(${otherPort},'127.0.0.1')`,
  ]);
  cleanups.push(() => {
    other.kill('SIGKILL');
  });
  await vi.waitFor(async () => {
    const probe = await connection(otherPort);
    expect(probe.localPort).toBeGreaterThan(0);
  });
  const foreign = await connection(otherPort);
  expect(
    await s.service.attestCommandConnection('s1', 'task_serve', otherPort, foreign.localPort ?? 0),
  ).toBe(false);

  // Strict mode: while the task holds the copy, a save is refused; after stop it goes through.
  const read = await s.service.readDocument('s1', 'a.txt');
  const save = (operationId: string) =>
    s.service.changeDocument('s1', {
      kind: 'save',
      operationId,
      target: s.target,
      path: 'a.txt',
      baseHash: read.version?.sha256 ?? hash('one\n'),
      text: 'two\n',
      editVersion: 1,
    });
  await expect(save('save_blocked')).rejects.toMatchObject({ code: 'RUN_ALREADY_ACTIVE' });
  const stopped = await s.service.stopTask('s1', 'task_serve');
  expect(stopped).toMatchObject({ state: 'cancelled', cleanupConfirmed: true });
  expect(await save('save_after')).toMatchObject({ state: 'succeeded' });
});

it('[TC-WBD-011-F] a check runs from its snapshot while a task holds the copy', async () => {
  const s = await setup();
  await s.service.configure('default', {
    verifyCommands: [
      {
        id: 'ok',
        name: 'OK',
        argv: [process.execPath, '-e', 'console.log("ok")'],
        timeoutMs: 10000,
      },
    ],
  });
  await s.service.startTask('s1', { operationId: 'task_a', target: s.target, script: 'serve' });
  await s.output('task_a', 'listening');
  const id = await s.service.verify('s1', 'default', 'ok');
  expect(await s.service.waitVerification(id)).toMatchObject({ state: 'completed' });
  await s.service.stopTask('s1', 'task_a');
});

it('[TC-WBD-011-F] after a restart, a task whose process group is gone is settled and frees the copy', async () => {
  const s = await setup();
  await s.service.startTask('s1', { operationId: 'task_r', target: s.target, script: 'serve' });
  await s.output('task_r', 'listening');
  const pid = (await s.service.tasks('s1'))[0]?.pid;
  expect(pid).toBeGreaterThan(0);
  s.restart();
  // The process is still alive: the receipt stays unconfirmed and keeps the writer.
  expect((await s.service.tasks('s1'))[0]).toMatchObject({ state: 'uncertain' });
  process.kill(-(pid as number), 'SIGKILL');
  await vi.waitFor(
    async () => expect((await s.service.tasks('s1'))[0]).toMatchObject({ state: 'cancelled' }),
    { timeout: 15_000 },
  );
  // The writer was returned.
  expect(
    await s.service.startTask('s1', {
      operationId: 'task_again',
      target: s.target,
      script: 'serve',
    }),
  ).toMatchObject({ state: 'running' });
  await s.output('task_again', 'listening');
  await s.service.stopTask('s1', 'task_again');
});

it('[TC-WBD-011-N] a session without a working copy has no task candidates, not an error', async () => {
  const s = await setup();
  await s.service.removeWorktree('s1');
  expect(await s.service.taskCandidates('s1')).toEqual({ packageManager: null, scripts: [] });
  expect(await s.service.tasks('s1')).toEqual([]);
});
