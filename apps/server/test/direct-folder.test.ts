import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
      s.db
        .prepare('UPDATE runs SET snapshot_json = ? WHERE id = ?')
        .run('{"permissionMode":"auto"}', 'run_1');
      const report = await s.service.runCommand(input, plan, null, live());
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
