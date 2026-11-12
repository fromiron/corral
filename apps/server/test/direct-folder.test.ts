import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '@corral/storage-sqlite';
import { FakeClock } from '@corral/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceService } from '../src/files/service.ts';

// Direct mode reads and searches the linked folder, and runs commands there.
// File tools do not write. A working copy, when present, is still the only tree the run uses.

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'corral-direct-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const live = () => ({ aborted: false, onCancel: () => () => {} });

function filePaths(result: Record<string, unknown>): string[] {
  if (!Array.isArray(result.files)) throw new Error('expected a file list');
  return result.files.map((file) => {
    if (
      typeof file !== 'object' ||
      file === null ||
      !('path' in file) ||
      typeof file.path !== 'string'
    )
      throw new Error('expected a file path');
    return file.path;
  });
}

function database() {
  const db = openDatabase(':memory:');
  db.prepare(
    "INSERT INTO work_sessions (id, project_id, corral_id, title, objective, pinned, revision, created_at, updated_at, archived_at, entries_json) VALUES ('session_1', 'default', NULL, 't', '', 0, 1, 'x', 'x', NULL, '[]')",
  ).run();
  db.prepare(
    "INSERT INTO work_sessions (id, project_id, corral_id, title, objective, pinned, revision, created_at, updated_at, archived_at, entries_json) VALUES ('session_copy', 'default', NULL, 't', '', 0, 1, 'x', 'x', NULL, '[]')",
  ).run();
  db.prepare(
    `INSERT INTO runs (id, corral_id, definition_hash, snapshot_json, status, last_seq,
       projection_json, started_at, project_id, session_id)
     VALUES ('run_1', 'c', 'h', '{"permissionMode":"ask"}', 'running', 0, '{}', 'x', 'default', 'session_1')`,
  ).run();
  db.prepare(
    "INSERT INTO work_sessions (id, project_id, corral_id, title, objective, pinned, revision, created_at, updated_at, archived_at, entries_json) VALUES ('session_2', 'default', NULL, 't', '', 0, 1, 'x', 'x', NULL, '[]')",
  ).run();
  db.prepare(
    `INSERT INTO runs (id, corral_id, definition_hash, snapshot_json, status, last_seq,
       projection_json, started_at, project_id, session_id)
     VALUES ('run_2', 'c', 'h', '{"permissionMode":"auto"}', 'running', 0, '{}', 'x', 'default', 'session_2')`,
  ).run();
  db.prepare(
    `INSERT INTO runs (id, corral_id, definition_hash, snapshot_json, status, last_seq,
       projection_json, started_at, project_id, session_id)
     VALUES ('run_copy', 'c', 'h', '{}', 'running', 0, '{}', 'x', 'default', 'session_copy')`,
  ).run();
  return db;
}

async function directFolder() {
  const root = temp();
  const outside = temp();
  writeFileSync(join(outside, 'secret.txt'), 'secret-bytes');
  writeFileSync(join(root, 'a.txt'), 'needle\n');
  writeFileSync(join(root, 'other.txt'), 'nope\n');
  symlinkSync(outside, join(root, 'outside'));
  symlinkSync(join(outside, 'secret.txt'), join(root, 'linked.txt'));
  const db = database();
  const service = new WorkspaceService({
    db,
    clock: new FakeClock(),
    worktreeRoot: join(temp(), 'worktrees'),
    forbidden: [],
  });
  await service.bind('default', root);
  await service.configure('default', { trusted: true });
  const call = (name: 'list_files' | 'read_file' | 'write_file', args: Record<string, unknown>) =>
    service.execute(
      { name, args, runId: 'run_1', executionId: 'exec_1', toolCallId: `tool_${Math.random()}` },
      live(),
    );
  return { root, outside, db, service, call };
}

function command(runId: string, effectId: string, line: string) {
  return {
    runId,
    executionId: `exec_${effectId}`,
    attemptNo: 1,
    effectId,
    request: { command: line },
  };
}

function cancellable() {
  let aborted = false;
  const listeners = new Set<() => void>();
  return {
    get aborted() {
      return aborted;
    },
    onCancel(fn: () => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    cancel() {
      aborted = true;
      for (const fn of listeners) fn();
    },
  };
}

/** The durable writer reservations held now (direct mode: only a running command's). */
function folderWriters(db: ReturnType<typeof database>) {
  return db
    .prepare(
      "SELECT owner_kind, owner_id, state FROM workspace_access WHERE writer=1 AND state IN ('active','uncertain')",
    )
    .all() as { owner_kind: string; owner_id: string; state: string }[];
}

async function until(check: () => boolean) {
  for (let i = 0; i < 400 && !check(); i += 1) await new Promise((r) => setTimeout(r, 10));
  if (!check()) throw new Error('condition not reached');
}

describe('direct folder file access', () => {
  it('lists, reads and searches the linked folder and refuses paths that leave it', async () => {
    const s = await directFolder();
    try {
      expect(s.service.sessionFiles('session_1')).toEqual({ mode: 'direct' });
      expect(s.service.available('run_1')).toBe(true);
      const listed = await s.call('list_files', {});
      expect(listed.files).toEqual(
        expect.arrayContaining([
          { path: 'a.txt', bytes: 7 },
          { path: 'other.txt', bytes: 5 },
        ]),
      );
      expect(filePaths(listed)).not.toContain('secret.txt');
      expect(filePaths(listed)).not.toContain('outside/secret.txt');
      expect(await s.call('read_file', { path: 'a.txt' })).toMatchObject({ text: 'needle\n' });
      const found = await s.call('list_files', { query: 'needle' });
      expect(found.files).toEqual([{ path: 'a.txt', bytes: 7 }]);
      expect((await s.call('list_files', { query: 'secret' })).files).toEqual([]);
      const folderName = s.root.split('/').at(-1) ?? 'missing';
      for (const path of ['../secret.txt', '/etc/passwd', 'outside/secret.txt', 'linked.txt']) {
        await expect(s.call('read_file', { path })).rejects.toMatchObject({
          code: expect.stringMatching(/CAPABILITY_DENIED|SCHEMA_INVALID|TARGET_NOT_FOUND/),
          message: expect.not.stringContaining(folderName),
        });
      }
      await expect(s.call('list_files', { path: '..' })).rejects.toMatchObject({
        code: 'CAPABILITY_DENIED',
      });
      await expect(
        s.call('write_file', { path: 'a.txt', text: 'changed\n' }),
      ).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
      expect(readFileSync(join(s.root, 'a.txt'), 'utf8')).toBe('needle\n');
      expect(readFileSync(join(s.outside, 'secret.txt'), 'utf8')).toBe('secret-bytes');
    } finally {
      await s.service.dispose();
      s.db.close();
    }
  });

  it('runs a command in the linked folder only after approval, and drops tools when trust is revoked', async () => {
    const s = await directFolder();
    try {
      s.service.acquireRun('run_1', 'session_1', true);
      await s.service.prepareRun('run_1');
      const input = {
        runId: 'run_1',
        executionId: 'exec_1',
        attemptNo: 1,
        effectId: 'effect_1',
        request: { command: 'test -f a.txt && printf ok' },
      };
      const plan = await s.service.planCommand(input, live());
      expect(plan.cwd).toBe('.');
      expect(JSON.stringify(plan)).not.toContain(s.root);
      await expect(s.service.runCommand(input, plan, null, live())).rejects.toMatchObject({
        code: 'CAPABILITY_DENIED',
      });
      expect(readFileSync(join(s.root, 'a.txt'), 'utf8')).toBe('needle\n');
      // In ask mode, only the approved launch fingerprint lets the command run.
      const asked = command('run_1', 'effect_asked', 'touch asked');
      const askedPlan = await s.service.planCommand(asked, live());
      await expect(
        s.service.runCommand(asked, askedPlan, 'not-this-fingerprint', live()),
      ).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
      expect(existsSync(join(s.root, 'asked'))).toBe(false);
      expect(
        await s.service.runCommand(asked, askedPlan, askedPlan.fingerprint, live()),
      ).toMatchObject({ state: 'completed', exitCode: 0 });
      expect(existsSync(join(s.root, 'asked'))).toBe(true);
      s.db
        .prepare('UPDATE runs SET snapshot_json = ? WHERE id = ?')
        .run('{"permissionMode":"auto"}', 'run_1');
      // The approved command changed the folder, so the earlier plan no longer matches it.
      await expect(s.service.runCommand(input, plan, null, live())).rejects.toMatchObject({
        code: 'REVISION_CONFLICT',
      });
      const report = await s.service.runCommand(
        input,
        await s.service.planCommand(input, live()),
        null,
        live(),
      );
      expect(report).toMatchObject({ state: 'completed', exitCode: 0 });
      expect(report.output.text).toBe('ok');
      expect(report.output.text).not.toContain(s.root);
      await expect(
        s.service.planCommand(
          { ...input, effectId: 'effect_out', request: { command: 'printf no', cwd: 'outside' } },
          live(),
        ),
      ).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
      await s.service.configure('default', { trusted: false });
      expect(s.service.sessionFiles('session_1')).toEqual({ mode: 'none', reason: 'untrusted' });
      expect(s.service.available('run_1')).toBe(false);
      await expect(s.call('read_file', { path: 'a.txt' })).rejects.toMatchObject({
        code: 'CAPABILITY_DENIED',
      });
      await expect(s.service.planCommand(input, live())).rejects.toMatchObject({
        code: 'CAPABILITY_DENIED',
      });
    } finally {
      await s.service.dispose();
      s.db.close();
    }
  });

  it('a session with a working copy still reads the copy, and a direct command does not pin refs into the folder', async () => {
    const root = temp();
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['config', 'user.email', 't@e'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
    writeFileSync(join(root, 'a.txt'), 'committed\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'first'], { cwd: root });
    const db = database();
    const service = new WorkspaceService({
      db,
      clock: new FakeClock(),
      worktreeRoot: join(temp(), 'worktrees'),
      forbidden: [],
    });
    try {
      await service.bind('default', root);
      await service.configure('default', { trusted: true });
      await service.createWorktree('session_copy', 'default');
      writeFileSync(join(root, 'only-original.txt'), 'later\n');
      const copy = service.copyOf('session_copy')?.worktree;
      if (!copy) throw new Error('missing copy');
      mkdirSync(join(copy, 'from-copy'), { recursive: true });
      writeFileSync(join(copy, 'from-copy.txt'), 'copy\n');
      service.acquireRun('run_copy', 'session_copy', false);
      const copyList = await service.execute(
        {
          name: 'list_files',
          args: {},
          runId: 'run_copy',
          executionId: 'exec_copy',
          toolCallId: 'list_copy',
        },
        live(),
      );
      const copyPaths = filePaths(copyList);
      expect(copyPaths).toContain('from-copy.txt');
      expect(copyPaths).not.toContain('only-original.txt');
      const copySearch = await service.execute(
        {
          name: 'list_files',
          args: { query: 'COPY' },
          runId: 'run_copy',
          executionId: 'exec_copy',
          toolCallId: 'search_copy',
        },
        live(),
      );
      expect(filePaths(copySearch)).toEqual(['from-copy.txt']);
      expect(service.sessionFiles('session_copy')).toEqual({ mode: 'copy' });
      service.acquireRun('run_1', 'session_1', true);
      await service.prepareRun('run_1');
      const input = {
        runId: 'run_1',
        executionId: 'exec_1',
        attemptNo: 1,
        effectId: 'effect_direct',
        request: { command: 'printf ok' },
      };
      db.prepare('UPDATE runs SET snapshot_json = ? WHERE id = ?').run(
        '{"permissionMode":"auto"}',
        'run_1',
      );
      const plan = await service.planCommand(input, live());
      await service.runCommand(input, plan, null, live());
      const refs = execFileSync('git', ['show-ref'], { cwd: root }).toString();
      expect(refs).not.toContain('refs/corral/session_1');
      const directList = await service.execute(
        {
          name: 'list_files',
          args: {},
          runId: 'run_1',
          executionId: 'exec_1',
          toolCallId: 'list_direct',
        },
        live(),
      );
      expect(filePaths(directList)).toContain('only-original.txt');
      expect(filePaths(directList)).not.toContain('from-copy.txt');
    } finally {
      await service.dispose();
      db.close();
    }
  });

  it('two sessions in one trusted project both start, and neither holds the folder before a command', async () => {
    const s = await directFolder();
    try {
      s.service.acquireRun('run_1', 'session_1', true);
      s.service.acquireRun('run_2', 'session_2', true);
      await s.service.prepareRun('run_1');
      await s.service.prepareRun('run_2');
      expect(folderWriters(s.db)).toEqual([]);
    } finally {
      await s.service.dispose();
      s.db.close();
    }
  });

  it('runs one command at a time in the folder, refuses another while one runs, and releases the folder when it ends', async () => {
    const s = await directFolder();
    try {
      s.db
        .prepare('UPDATE runs SET snapshot_json = ? WHERE id = ?')
        .run('{"permissionMode":"auto"}', 'run_1');
      s.service.acquireRun('run_1', 'session_1', true);
      s.service.acquireRun('run_2', 'session_2', true);
      const first = command(
        'run_1',
        'effect_wait',
        'while [ ! -f go ]; do sleep 0.02; done; printf first',
      );
      const running = s.service.runCommand(
        first,
        await s.service.planCommand(first, live()),
        null,
        live(),
      );
      await until(() => folderWriters(s.db).length === 1);
      // Another session's command, and the same run's next command, are refused, not queued.
      for (const next of [
        command('run_2', 'effect_other', 'printf other'),
        command('run_1', 'effect_again', 'printf again'),
      ])
        await expect(s.service.planCommand(next, live())).rejects.toMatchObject({
          code: 'RUN_ALREADY_ACTIVE',
        });
      writeFileSync(join(s.root, 'go'), '');
      expect(await running).toMatchObject({ state: 'completed', exitCode: 0 });
      expect(folderWriters(s.db)).toEqual([]);
      const next = command('run_2', 'effect_next', 'printf next');
      expect(
        await s.service.runCommand(next, await s.service.planCommand(next, live()), null, live()),
      ).toMatchObject({ state: 'completed', exitCode: 0 });
      expect(folderWriters(s.db)).toEqual([]);
    } finally {
      await s.service.dispose();
      s.db.close();
    }
  });

  it('a cancelled command releases the folder once its end is confirmed', async () => {
    const s = await directFolder();
    try {
      s.db
        .prepare('UPDATE runs SET snapshot_json = ? WHERE id = ?')
        .run('{"permissionMode":"auto"}', 'run_1');
      s.service.acquireRun('run_1', 'session_1', true);
      s.service.acquireRun('run_2', 'session_2', true);
      const slow = command('run_1', 'effect_slow', 'sleep 30');
      const cancellation = cancellable();
      const running = s.service.runCommand(
        slow,
        await s.service.planCommand(slow, live()),
        null,
        cancellation,
      );
      await until(() => folderWriters(s.db).length === 1);
      cancellation.cancel();
      expect(await running).toMatchObject({ cleanupConfirmed: true });
      expect(folderWriters(s.db)).toEqual([]);
      const next = command('run_2', 'effect_after_cancel', 'printf after');
      expect(
        await s.service.runCommand(next, await s.service.planCommand(next, live()), null, live()),
      ).toMatchObject({ state: 'completed' });
    } finally {
      await s.service.dispose();
      s.db.close();
    }
  });

  it('a command whose end is unconfirmed keeps the folder protected', async () => {
    const s = await directFolder();
    try {
      s.db
        .prepare('UPDATE runs SET snapshot_json = ? WHERE id = ?')
        .run('{"permissionMode":"auto"}', 'run_1');
      s.service.acquireRun('run_1', 'session_1', true);
      s.service.acquireRun('run_2', 'session_2', true);
      // The native helper reports that it could not confirm the process group ended.
      const runtime = (
        s.service as unknown as {
          commandRuntime: { startService: (input: { operationId: string }) => unknown };
        }
      ).commandRuntime;
      runtime.startService = (input) => ({
        operationId: input.operationId,
        started: Promise.resolve(true),
        completion: Promise.resolve({
          operationId: input.operationId,
          state: 'uncertain',
          exitCode: null,
          signal: null,
          timedOut: false,
          cleanupConfirmed: false,
          output: { text: '', bytes: 0, hash: '0'.repeat(64), truncated: false },
        }),
      });
      const lost = command('run_1', 'effect_lost', 'printf lost');
      expect(
        await s.service.runCommand(lost, await s.service.planCommand(lost, live()), null, live()),
      ).toMatchObject({ cleanupConfirmed: false });
      expect(folderWriters(s.db)).toEqual([expect.objectContaining({ state: 'uncertain' })]);
      await expect(
        s.service.planCommand(command('run_2', 'effect_blocked', 'printf no'), live()),
      ).rejects.toMatchObject({ code: 'RUN_ALREADY_ACTIVE' });
      // Worker recovery alone does not return a folder whose command is still unconfirmed.
      s.service.confirmWorkerRecovery();
      expect(folderWriters(s.db)).toEqual([expect.objectContaining({ state: 'uncertain' })]);
    } finally {
      await s.service.dispose();
      s.db.close();
    }
  });

  it('a direct run does not run a command in a working copy made after it started', async () => {
    const root = temp();
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['config', 'user.email', 't@e'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
    writeFileSync(join(root, 'a.txt'), 'committed\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'first'], { cwd: root });
    const db = database();
    const service = new WorkspaceService({
      db,
      clock: new FakeClock(),
      worktreeRoot: join(temp(), 'worktrees'),
      forbidden: [],
    });
    try {
      await service.bind('default', root);
      await service.configure('default', { trusted: true });
      db.prepare('UPDATE runs SET snapshot_json = ? WHERE id = ?').run(
        '{"permissionMode":"auto"}',
        'run_1',
      );
      service.acquireRun('run_1', 'session_1', true);
      await service.createWorktree('session_1', 'default');
      const copy = service.copyOf('session_1')?.worktree;
      if (!copy) throw new Error('missing copy');
      const input = command('run_1', 'effect_in_copy', 'touch from-direct-run');
      await expect(service.planCommand(input, live())).rejects.toMatchObject({
        code: 'CAPABILITY_DENIED',
      });
      expect(existsSync(join(copy, 'from-direct-run'))).toBe(false);
      expect(existsSync(join(root, 'from-direct-run'))).toBe(false);
    } finally {
      await service.dispose();
      db.close();
    }
  });

  it('a cancelled read does not return folder contents', async () => {
    const s = await directFolder();
    try {
      await expect(
        s.service.execute(
          {
            name: 'list_files',
            args: {},
            runId: 'run_1',
            executionId: 'exec_1',
            toolCallId: 'cancelled',
          },
          { aborted: true, onCancel: () => () => {} },
        ),
      ).rejects.toMatchObject({ code: 'TARGET_TERMINAL' });
    } finally {
      await s.service.dispose();
      s.db.close();
    }
  });
});
