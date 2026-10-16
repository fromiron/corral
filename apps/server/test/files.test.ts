import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '@corral/storage-sqlite';
import { FakeClock } from '@corral/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { safeRelative, WorkspaceService } from '../src/files/service.ts';

// The file broker's rules (CR-012): paths, the read-before-change rule, and what a stop leaves.

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'corral-files-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function setup() {
  const original = temp();
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], { cwd: original });
  git('init', '-q');
  writeFileSync(join(original, 'a.txt'), 'one\n');
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  const db = openDatabase(':memory:');
  db.prepare(
    "INSERT INTO work_sessions VALUES ('session_1', 'default', NULL, 't', '', 0, 1, 'x', 'x', NULL, '[]')",
  ).run();
  db.prepare(
    `INSERT INTO runs (id, corral_id, definition_hash, snapshot_json, status, last_seq,
       projection_json, started_at, project_id, session_id)
     VALUES ('run_1', 'c', 'h', '{}', 'running', 0, '{}', 'x', 'default', 'session_1')`,
  ).run();
  const service = new WorkspaceService({
    db,
    clock: new FakeClock(),
    worktreeRoot: join(temp(), 'worktrees'),
    forbidden: [],
  });
  await service.bind('default', original);
  await service.configure('default', { trusted: true });
  await service.createWorktree('session_1', 'default');
  const call = (
    name: 'read_file' | 'write_file' | 'delete_file' | 'move_file',
    args: Record<string, unknown>,
  ) =>
    service.execute(
      { name, args, runId: 'run_1', executionId: 'exec_1', toolCallId: `tool_${Math.random()}` },
      { aborted: false, onCancel: () => () => {} },
    );
  return { db, service, call, original };
}

describe('file broker (CR-012)', () => {
  it('refuses paths that leave the copy, reach .git or .corral, or are absolute', () => {
    for (const bad of [
      '../x',
      'a/../../x',
      '/etc/passwd',
      '.git/config',
      'sub/.GIT/x',
      '.corral/corral.db',
      'a\\b',
    ]) {
      expect(() => safeRelative(bad)).toThrow();
    }
    expect(safeRelative('./src//a.ts')).toBe('src/a.ts');
  });

  it('[WB-WSP-004] changes an existing file only as this run read it', async () => {
    const { service, call } = await setup();
    await expect(call('write_file', { path: 'a.txt', text: 'two\n' })).rejects.toThrow(
      /read a.txt/,
    );
    await call('read_file', { path: 'a.txt' });
    const root = (
      service as unknown as { worktree(id: string): { worktree_path: string } }
    ).worktree('session_1').worktree_path;
    writeFileSync(join(root, 'a.txt'), 'edited by someone else\n');
    await expect(call('write_file', { path: 'a.txt', text: 'two\n' })).rejects.toThrow(
      /changed since/,
    );
    await call('read_file', { path: 'a.txt' });
    await expect(call('write_file', { path: 'a.txt', text: 'two\n' })).resolves.toMatchObject({
      created: false,
    });
    await expect(call('write_file', { path: 'new/b.txt', text: 'b' })).resolves.toMatchObject({
      created: true,
    });
    symlinkSync('/etc', join(root, 'link'));
    await expect(call('write_file', { path: 'link/x', text: 'x' })).rejects.toThrow(
      /symbolic link/,
    );
  });

  it('[WB-WSP-005] a write planned before a stop is uncertain afterwards, never redone', async () => {
    const { db } = await setup();
    db.prepare(
      `INSERT INTO file_operations VALUES ('op_1', 'session_1', 'run_1', 'exec_1', 'tool_1', 'write',
         'a.txt', NULL, NULL, 'h', 'planned', NULL, 'x', 'x')`,
    ).run();
    new WorkspaceService({ db, clock: new FakeClock(), worktreeRoot: temp(), forbidden: [] });
    expect(db.prepare("SELECT state FROM file_operations WHERE id = 'op_1'").get()).toEqual({
      state: 'uncertain',
    });
  });
});
