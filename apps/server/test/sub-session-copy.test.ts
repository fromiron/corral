import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '@corral/storage-sqlite';
import { FakeClock } from '@corral/testkit';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkspaceService } from '../src/files/service.ts';

// docs/specs/features/sub-sessions.md: a failed preparation leaves the sub-session without a
// copy, and a retry prepares it whole.

vi.setConfig({ testTimeout: 30000 });

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'corral-sub-copy-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();

it('leaves no copy and no stray branch when the start state cannot be restored', async () => {
  const original = temp();
  git(original, 'init', '-q');
  writeFileSync(join(original, 'a.txt'), 'one\n');
  git(original, 'add', '.');
  git(original, 'commit', '-q', '-m', 'first');
  const db = openDatabase(':memory:');
  const insert = db.prepare(
    "INSERT INTO work_sessions (id, project_id, corral_id, title, objective, pinned, revision, created_at, updated_at, archived_at, entries_json) VALUES (?, 'default', NULL, ?, '', 0, 1, 'x', 'x', NULL, '[]')",
  );
  insert.run('parent', 'Parent');
  insert.run('sub', 'New conversation');
  const service = new WorkspaceService({
    db,
    clock: new FakeClock(),
    worktreeRoot: join(temp(), 'worktrees'),
    forbidden: [],
  });
  try {
    await service.bind('default', original);
    await service.configure('default', { trusted: true });
    await service.createWorktree('parent', 'default');
    writeFileSync(join(service.copyOf('parent')!.worktree, 'a.txt'), 'changed\n');
    const branches = git(original, 'branch', '--list', 'corral/*');
    const restore = vi
      .spyOn(service, 'restoreCheckpoint')
      .mockRejectedValueOnce(new Error('disk full'));
    await expect(service.branchFromCopy('parent', 'sub', 'Parent')).rejects.toThrow('disk full');
    expect(service.worktreeView('sub')).toBeNull();
    expect(git(original, 'branch', '--list', 'corral/*')).toBe(branches);
    restore.mockRestore();
    await service.branchFromCopy('parent', 'sub', 'Parent');
    expect(git(service.copyOf('sub')!.worktree, 'status', '--porcelain')).toBe('M a.txt');
  } finally {
    await service.dispose();
    db.close();
  }
});
