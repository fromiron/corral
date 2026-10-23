import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '@corral/storage-sqlite';
import { FakeClock } from '@corral/testkit';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkspaceService } from '../src/files/service.ts';
import { WorkbenchOperations } from '../src/files/workbench-operations.ts';

vi.setConfig({ testTimeout: 40_000 });
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
async function setup(enabled = true) {
  const root = mkdtempSync(join(tmpdir(), 'corral-development-'));
  const original = join(root, 'original');
  execFileSync('git', ['init', '-q', '-b', 'main', original]);
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=f@example.test', ...args], {
      cwd: original,
    });
  writeFileSync(join(original, 'a.txt'), 'one\n');
  writeFileSync(
    join(original, 'package.json'),
    JSON.stringify({ scripts: { serve: 'node server.cjs' } }),
  );
  writeFileSync(
    join(original, 'server.cjs'),
    "const fs=require('fs'); const s=require('http').createServer((q,r)=>r.end(fs.readFileSync('a.txt')));s.listen(0,'127.0.0.1',()=>console.log('READY '+s.address().port));\n",
  );
  git('add', '.');
  git('commit', '-qm', 'base');
  const db = openDatabase(':memory:');
  db.prepare(
    "INSERT INTO work_sessions(id,project_id,corral_id,title,objective,pinned,revision,created_at,updated_at,entries_json) VALUES('s1','default',NULL,'t','',0,1,'x','x','[]')",
  ).run();
  const clock = new FakeClock();
  const make = () =>
    new WorkspaceService({
      db,
      clock,
      worktreeRoot: join(root, 'copies'),
      forbidden: [],
      hostId: 'host',
      allowSharedDevelopment: enabled,
    });
  let service = make();
  cleanups.push(async () => {
    await service.dispose();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  await service.bind('default', original);
  await service.configure('default', {
    trusted: true,
    verifyCommands: [
      {
        id: 'check',
        name: 'Check',
        timeoutMs: 30000,
        argv: [process.execPath, '-e', "console.log(require('fs').readFileSync('a.txt','utf8'))"],
      },
    ],
  });
  const copy = await service.createWorktree('s1', 'default');
  const target = {
    hostId: 'host',
    projectId: 'default',
    bindingId: copy.bindingId,
    sessionId: 's1',
    copyGeneration: copy.copyGeneration,
  };
  const path = join(root, 'copies', copy.bindingId, 's1');
  const start = { operationId: 'development_1', target };
  const save = (operationId: string, base = 'one\n', text = 'two\n') => ({
    operationId,
    kind: 'save' as const,
    target,
    path: 'a.txt',
    baseHash: hash(base),
    text,
    editVersion: 1,
  });
  return {
    get service() {
      return service;
    },
    restart: async () => {
      await service.dispose();
      service = make();
    },
    db,
    clock,
    target,
    start,
    path,
    original,
    save,
  };
}

it('[TC-WBD-017-H] saves while a real development task stays alive, keeps Git and checks scoped, then returns to strict', async () => {
  const s = await setup();
  expect(s.service.developmentState('s1')).toMatchObject({ available: true, operation: null });
  const entered = await s.service.startDevelopment('s1', s.start);
  expect(entered.operation).toMatchObject({ kind: 'development', state: 'running' });
  expect(await s.service.startDevelopment('s1', s.start)).toEqual(entered);
  await s.service.startTask('s1', { operationId: 'task', target: s.target, script: 'serve' });
  let port = '';
  await vi.waitFor(
    () => {
      port = s.service.taskOutput('s1', 'task', 0)?.text.match(/READY (\d+)/)?.[1] ?? '';
      expect(port).not.toBe('');
    },
    { timeout: 15_000 },
  );
  expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe('one\n');
  expect((await s.service.readDocument('s1', 'a.txt')).writable).toBe(true);
  expect(await s.service.changeDocument('s1', s.save('save'))).toMatchObject({
    state: 'succeeded',
  });
  expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe('two\n');
  expect(s.service.worktreeView('s1')?.copyGeneration).toBe(s.target.copyGeneration);
  const scope = { kind: 'session' as const, id: 's1' };
  let status = await s.service.gitStatus(scope);
  expect(
    await s.service.changeGit('s1', {
      kind: 'stage',
      operationId: 'stage',
      target: s.target,
      expect: { head: status.head.oid, indexHash: status.indexHash },
      paths: ['a.txt'],
    }),
  ).toMatchObject({ state: 'succeeded' });
  status = await s.service.gitStatus(scope);
  expect(
    await s.service.changeGit('s1', {
      kind: 'commit',
      operationId: 'commit',
      target: s.target,
      expect: { head: status.head.oid, indexHash: status.indexHash },
      staged: ['a.txt'],
      message: 'shared save',
      runHooks: false,
    }),
  ).toMatchObject({ state: 'succeeded' });
  await expect(s.service.verify('s1', 'default', 'check')).resolves.toBeTypeOf('string');
  await expect(s.service.finishDevelopment('s1', 'development_1', s.target)).rejects.toMatchObject({
    code: 'RUN_ALREADY_ACTIVE',
  });
  expect((await s.service.stopTask('s1', 'task')).cleanupConfirmed).toBe(true);
  expect(await s.service.finishDevelopment('s1', 'development_1', s.target)).toMatchObject({
    operation: null,
  });
  expect(await s.service.finishDevelopment('s1', 'development_1', s.target)).toMatchObject({
    operation: null,
  });
  expect(await s.service.startDevelopment('s1', s.start)).toMatchObject({ operation: null });
  expect(readFileSync(join(s.original, 'a.txt'), 'utf8')).toBe('one\n');
});

it('[TC-WBD-017-N] denies foreign/disabled targets and exclusive writers while preserving external-write CAS', async () => {
  const disabled = await setup(false);
  await expect(disabled.service.startDevelopment('s1', disabled.start)).rejects.toMatchObject({
    code: 'CAPABILITY_DENIED',
  });
  const s = await setup();
  await expect(
    s.service.startDevelopment('s1', { ...s.start, target: { ...s.target, copyGeneration: 2 } }),
  ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  await s.service.startDevelopment('s1', s.start);
  expect(() => s.service.acquireRun('writer', 's1', true)).toThrow(/shared development/);
  const ops = new WorkbenchOperations(s.db, s.clock);
  for (const kind of ['terminal', 'git.branch', 'git.switch', 'git.pull'])
    expect(() =>
      ops.admit({ ...s.start, operationId: kind, kind, requestHash: kind }, s.path),
    ).toThrow(/shared development/);
  writeFileSync(join(s.path, 'a.txt'), 'external\n');
  expect(await s.service.changeDocument('s1', s.save('stale'))).toMatchObject({
    state: 'failed',
    result: { code: 'REVISION_CONFLICT' },
  });
  expect(readFileSync(join(s.path, 'a.txt'), 'utf8')).toBe('external\n');
  await expect(
    s.service.finishDevelopment('s1', 'development_1', { ...s.target, copyGeneration: 2 }),
  ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
});

it('[TC-WBD-017-H] each read-only Run pins its own snapshot across shared saves', async () => {
  const s = await setup();
  await s.service.startDevelopment('s1', s.start);
  for (const id of ['reader_before', 'reader_after']) {
    s.db
      .prepare(`INSERT INTO runs
      (id,corral_id,definition_hash,snapshot_json,status,last_seq,projection_json,started_at,project_id,session_id)
      VALUES(?,'c','h','{}','running',0,'{}','x','default','s1')`)
      .run(id);
  }
  s.service.acquireRun('reader_before', 's1', false);
  await s.service.prepareRun('reader_before');
  await s.service.changeDocument('s1', s.save('between_readers'));
  s.service.acquireRun('reader_after', 's1', false);
  await s.service.prepareRun('reader_after');
  expect((await s.service.readPreviewSnapshot('reader_before', 'a.txt'))?.toString()).toBe('one\n');
  expect((await s.service.readPreviewSnapshot('reader_after', 'a.txt'))?.toString()).toBe('two\n');
  expect(await s.service.finishDevelopment('s1', 'development_1', s.target)).toMatchObject({
    operation: null,
  });
  s.service.releaseRun('reader_before', true);
  s.service.releaseRun('reader_after', true);
});

it('[TC-WBD-017-F] restart never restores sharing, and uncertain children hold the parent until explicitly reconciled', async () => {
  const s = await setup();
  await s.service.startDevelopment('s1', s.start);
  const ops = new WorkbenchOperations(s.db, s.clock);
  ops.admit(
    { ...s.start, operationId: 'save_pending', kind: 'document.save', requestHash: 'save' },
    s.path,
  );
  await s.restart();
  expect(s.service.developmentState('s1').operation?.state).toBe('uncertain');
  await expect(s.service.changeDocument('s1', s.save('after_restart'))).rejects.toMatchObject({
    code: 'RUN_ALREADY_ACTIVE',
  });
  await expect(s.service.finishDevelopment('s1', 'development_1', s.target)).rejects.toMatchObject({
    code: 'RUN_ALREADY_ACTIVE',
  });
  ops.reconcile('save_pending', ['document.save'], 'failed', {
    reason: 'fixture confirmed no effect',
  });
  expect(await s.service.finishDevelopment('s1', 'development_1', s.target)).toMatchObject({
    operation: null,
  });
  await s.service.startDevelopment('s1', { ...s.start, operationId: 'development_2' });
  await s.service.finishDevelopment('s1', 'development_1', s.target);
  expect(s.service.developmentState('s1').operation?.operationId).toBe('development_2');
});
