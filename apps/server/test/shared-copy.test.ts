import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '@corral/storage-sqlite';
import { FakeClock } from '@corral/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceService } from '../src/files/service.ts';
import { WorkbenchOperations } from '../src/files/workbench-operations.ts';

// A local host shares the Paddock (workbench.md 공유 개발 모드): agent writing runs, tasks,
// terminals, documents, Git work and checks run side by side, the compare-and-swap protections
// kept. A server without sharing keeps the single writer, and its refusal names the holder
// (api-contract.md 오류, `owner`).
vi.setConfig({ testTimeout: 40_000 });
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
const live = () => ({ aborted: false, onCancel: (_fn: () => void) => () => {} });
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

async function setup(shares: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'corral-shared-copy-'));
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
  git('branch', 'topic');
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
      allowSharedDevelopment: shares,
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
  /** An agent run of this session, as the coordinator records it before admitting it. */
  const run = (id: string, permissionMode?: string) =>
    db
      .prepare(`INSERT INTO runs
      (id,corral_id,definition_hash,snapshot_json,status,last_seq,projection_json,started_at,project_id,session_id)
      VALUES(?,'c','h',?,'running',0,'{}','x','default','s1')`)
      .run(id, JSON.stringify(permissionMode ? { permissionMode } : {}));
  const save = (operationId: string, base = 'one\n', text = 'two\n', at = target) => ({
    operationId,
    kind: 'save' as const,
    target: at,
    path: 'a.txt',
    baseHash: hash(base),
    text,
    editVersion: 1,
  });
  const task = async (operationId: string) => {
    await service.startTask('s1', { operationId, target, script: 'serve' });
    await vi.waitFor(
      () => expect(service.taskOutput('s1', operationId, 0)?.text).toMatch(/READY \d+/),
      { timeout: 15_000 },
    );
  };
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
    path,
    run,
    save,
    task,
  };
}

describe('a local host shares the Paddock', () => {
  it('admits a writing agent run while a task runs, and the run commands beside it', async () => {
    const s = await setup(true);
    await s.task('dev');
    s.run('writer');
    expect(() => s.service.acquireRun('writer', 's1', true)).not.toThrow();
    await s.service.prepareRun('writer');
    const input = {
      runId: 'writer',
      executionId: 'exec',
      attemptNo: 1,
      effectId: 'effect',
      request: { command: "printf 'edited\\n' > a.txt" },
    };
    const plan = await s.service.planCommand(input, live());
    expect(await s.service.runCommand(input, plan, plan.fingerprint, live())).toMatchObject({
      state: 'completed',
      exitCode: 0,
    });
  });

  it('admits a task while an agent writes', async () => {
    const s = await setup(true);
    s.run('writer');
    s.service.acquireRun('writer', 's1', true);
    await expect(
      s.service.startTask('s1', { operationId: 'dev', target: s.target, script: 'serve' }),
    ).resolves.toMatchObject({ state: 'running' });
  });

  it.skipIf(process.platform !== 'linux')('admits a terminal while an agent writes', async () => {
    const s = await setup(true);
    s.run('writer');
    s.service.acquireRun('writer', 's1', true);
    await expect(
      s.service.terminals.create('s1', {
        operationId: 'terminal',
        target: s.target,
        shellId: 'bash',
        cols: 80,
        rows: 24,
      }),
    ).resolves.toMatchObject({ terminalId: 'terminal' });
  });

  it('admits a branch switch while an agent writes', async () => {
    const s = await setup(true);
    s.run('writer');
    s.service.acquireRun('writer', 's1', true);
    const status = await s.service.gitStatus({ kind: 'session', id: 's1' });
    await expect(
      s.service.changeGit('s1', {
        kind: 'switch',
        operationId: 'switch',
        target: s.target,
        expect: { head: status.head.oid, indexHash: status.indexHash },
        branch: 'topic',
      }),
    ).resolves.toMatchObject({ state: 'succeeded' });
  });

  it("admits a person's save beside a writing agent run, and still refuses another copy generation", async () => {
    const s = await setup(true);
    s.run('writer');
    s.service.acquireRun('writer', 's1', true);
    expect(await s.service.changeDocument('s1', s.save('save'))).toMatchObject({
      state: 'succeeded',
    });
    await expect(
      s.service.changeDocument(
        's1',
        s.save('stale', 'two\n', 'three\n', {
          ...s.target,
          copyGeneration: s.target.copyGeneration + 1,
        }),
      ),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  });

  it('a run cancelled while writing: confirmed lets the next effect in, unconfirmed holds new effects naming it until recovery', async () => {
    const s = await setup(true);
    s.run('confirmed');
    s.service.acquireRun('confirmed', 's1', true);
    s.service.releaseRun('confirmed', true);
    expect(await s.service.changeDocument('s1', s.save('after_confirmed'))).toMatchObject({
      state: 'succeeded',
    });
    s.run('unconfirmed');
    s.service.acquireRun('unconfirmed', 's1', true);
    s.service.releaseRun('unconfirmed', false);
    await expect(
      s.service.changeDocument('s1', s.save('while_unconfirmed', 'two\n', 'three\n')),
    ).rejects.toMatchObject({ owner: { kind: 'run', id: 'unconfirmed', state: 'uncertain' } });
    s.service.confirmWorkerRecovery();
    expect(
      await s.service.changeDocument('s1', s.save('after_recovery', 'two\n', 'three\n')),
    ).toMatchObject({ state: 'succeeded' });
  });

  it('after a restart an owner stays unconfirmed, holding new effects and named, until its own reconcile settles it', async () => {
    const s = await setup(true);
    const ops = new WorkbenchOperations(s.db, s.clock);
    ops.admit({ operationId: 'dev', target: s.target, kind: 'task', requestHash: 'dev' }, s.path, {
      script: 'serve',
      command: 'node server.cjs',
      packageManager: 'npm',
    });
    await s.restart();
    await expect(s.service.changeDocument('s1', s.save('after_restart'))).rejects.toMatchObject({
      owner: { kind: 'task', id: 'dev', sessionId: 's1', state: 'uncertain' },
    });
    ops.reconcile('dev', ['task'], 'cancelled', { cleanupConfirmed: true });
    expect(await s.service.changeDocument('s1', s.save('after_reconcile'))).toMatchObject({
      state: 'succeeded',
    });
  });

  it('runs an approved command when a person saved between its plan and its launch', async () => {
    const s = await setup(true);
    s.run('writer');
    s.service.acquireRun('writer', 's1', true);
    await s.service.prepareRun('writer');
    const input = {
      runId: 'writer',
      executionId: 'exec',
      attemptNo: 1,
      effectId: 'effect',
      request: { command: "printf 'command\\n' >> b.txt" },
    };
    const plan = await s.service.planCommand(input, live());
    // The person's save lands in the live copy between the plan and the launch.
    writeFileSync(join(s.path, 'a.txt'), 'saved by the person\n');
    expect(await s.service.runCommand(input, plan, plan.fingerprint, live())).toMatchObject({
      state: 'completed',
      exitCode: 0,
    });
  });

  it("runs a person's check while an agent writes, on the copy as it was when the check started", async () => {
    const s = await setup(true);
    s.run('writer');
    s.service.acquireRun('writer', 's1', true);
    await s.service.prepareRun('writer');
    writeFileSync(join(s.path, 'a.txt'), 'agent\n');
    const id = await s.service.verify('s1', 'default', 'check');
    writeFileSync(join(s.path, 'a.txt'), 'after the check started\n');
    const report = await s.service.waitVerification(id);
    expect(report).toMatchObject({ exitCode: 0 });
    expect(JSON.stringify(report.output)).toContain('agent');
    expect(JSON.stringify(report.output)).not.toContain('after the check started');
  });

  it('a read-only run started while an agent writes reads its own snapshot of the copy at its start', async () => {
    const s = await setup(true);
    s.run('writer');
    s.service.acquireRun('writer', 's1', true);
    await s.service.prepareRun('writer');
    s.run('reader_before');
    s.service.acquireRun('reader_before', 's1', false);
    await s.service.prepareRun('reader_before');
    expect(await s.service.changeDocument('s1', s.save('between_readers'))).toMatchObject({
      state: 'succeeded',
    });
    s.run('reader_after');
    s.service.acquireRun('reader_after', 's1', false);
    await s.service.prepareRun('reader_after');
    expect((await s.service.readPreviewSnapshot('reader_before', 'a.txt'))?.toString()).toBe(
      'one\n',
    );
    // Not the writer's start tree: the copy as the person's save left it.
    expect((await s.service.readPreviewSnapshot('reader_after', 'a.txt'))?.toString()).toBe(
      'two\n',
    );
  });

  it('restore is unsafe only while an agent writes, not while a task runs', async () => {
    const s = await setup(true);
    await s.task('dev');
    expect(s.service.hasUnsafeWorktreeOwner('s1')).toBe(false);
    s.run('writer');
    s.service.acquireRun('writer', 's1', true);
    expect(s.service.hasUnsafeWorktreeOwner('s1')).toBe(true);
    s.service.releaseRun('writer', true);
    expect(s.service.hasUnsafeWorktreeOwner('s1')).toBe(false);
  });
});

describe('a server without sharing keeps the single writer', () => {
  it('refuses a writing agent run while a task holds the copy, naming the task', async () => {
    const s = await setup(false);
    await s.task('dev');
    s.run('writer');
    let refusal: unknown;
    try {
      s.service.acquireRun('writer', 's1', true);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toMatchObject({
      code: 'RUN_ALREADY_ACTIVE',
      owner: { kind: 'task', id: 'dev', sessionId: 's1', state: 'active' },
    });
  });

  it("refuses a task and a person's save while an agent writes, naming the run", async () => {
    const s = await setup(false);
    s.run('writer');
    s.service.acquireRun('writer', 's1', true);
    const owner = { kind: 'run', id: 'writer', sessionId: 's1', state: 'active' };
    await expect(
      s.service.startTask('s1', { operationId: 'dev', target: s.target, script: 'serve' }),
    ).rejects.toMatchObject({ code: 'RUN_ALREADY_ACTIVE', owner });
    await expect(s.service.changeDocument('s1', s.save('save'))).rejects.toMatchObject({
      code: 'RUN_ALREADY_ACTIVE',
      owner,
    });
  });

  it('still refuses a command whose copy changed between its plan and its launch', async () => {
    const s = await setup(false);
    s.run('writer');
    s.service.acquireRun('writer', 's1', true);
    await s.service.prepareRun('writer');
    const input = {
      runId: 'writer',
      executionId: 'exec',
      attemptNo: 1,
      effectId: 'effect',
      request: { command: "printf 'command\\n' >> b.txt" },
    };
    const plan = await s.service.planCommand(input, live());
    writeFileSync(join(s.path, 'a.txt'), 'external\n');
    await expect(s.service.runCommand(input, plan, plan.fingerprint, live())).rejects.toMatchObject(
      { code: 'REVISION_CONFLICT' },
    );
  });
});
