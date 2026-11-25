import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '@corral/storage-sqlite';
import { FakeClock } from '@corral/testkit';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkspaceService } from '../src/files/service.ts';

// docs/specs/workbench.md#paddock의-브랜치: a Paddock is made on its own branch.

vi.setConfig({ testTimeout: 30000 });

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'corral-paddock-branch-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const short = (sessionId: string) =>
  createHash('sha256').update(sessionId).digest('hex').slice(0, 6);

async function setup(title: string) {
  const original = temp();
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], {
      cwd,
      encoding: 'utf8',
    }).trim();
  git(original, 'init', '-q');
  writeFileSync(join(original, 'a.txt'), 'one\n');
  git(original, 'add', '.');
  git(original, 'commit', '-q', '-m', 'first');
  const db = openDatabase(':memory:');
  db.prepare(
    "INSERT INTO work_sessions (id, project_id, corral_id, title, objective, pinned, revision, created_at, updated_at, archived_at, entries_json) VALUES ('session_1', 'default', NULL, ?, '', 0, 1, 'x', 'x', NULL, '[]')",
  ).run(title);
  const service = new WorkspaceService({
    db,
    clock: new FakeClock(),
    worktreeRoot: join(temp(), 'worktrees'),
    forbidden: [],
  });
  await service.bind('default', original);
  await service.configure('default', { trusted: true });
  const branchOf = () =>
    git(service.copyOf('session_1')?.worktree ?? original, 'symbolic-ref', '--short', 'HEAD');
  return { db, service, original, git, branchOf };
}

it('makes a Paddock on a branch named from the session title and a short id', async () => {
  const s = await setup('Fix the Login bug!');
  try {
    await s.service.createWorktree('session_1', 'default');
    expect(s.branchOf()).toBe(`corral/fix-the-login-bug-${short('session_1')}`);
    expect(s.git(s.original, 'branch', '--list', 'corral/*')).toContain('corral/fix-the-login-bug');
  } finally {
    await s.service.dispose();
    s.db.close();
  }
});

it('keeps letters of any script, cuts at 40 characters, and falls back to session', async () => {
  for (const [title, slug] of [
    ['로그인 고치기', '로그인-고치기'],
    ['!!!', 'session'],
    [`${'a'.repeat(30)} ${'b'.repeat(30)}`, `${'a'.repeat(30)}-${'b'.repeat(9)}`],
  ] as const) {
    const s = await setup(title);
    try {
      await s.service.createWorktree('session_1', 'default');
      expect(s.branchOf()).toBe(`corral/${slug}-${short('session_1')}`);
    } finally {
      await s.service.dispose();
      s.db.close();
    }
  }
});

it('leaves the branch when the copy is removed and numbers the next copy', async () => {
  const s = await setup('Plan');
  const name = `corral/plan-${short('session_1')}`;
  try {
    await s.service.createWorktree('session_1', 'default');
    const tip = s.git(s.service.copyOf('session_1')!.worktree, 'rev-parse', 'HEAD');
    await s.service.removeWorktree('session_1');
    expect(s.git(s.original, 'rev-parse', `refs/heads/${name}`)).toBe(tip);
    await s.service.createWorktree('session_1', 'default');
    expect(s.branchOf()).toBe(`${name}-2`);
  } finally {
    await s.service.dispose();
    s.db.close();
  }
});

it('does not move a branch of the same name that the person made', async () => {
  const s = await setup('Plan');
  const name = `corral/plan-${short('session_1')}`;
  try {
    s.git(s.original, 'commit', '-q', '--allow-empty', '-m', 'second');
    s.git(s.original, 'branch', name, 'HEAD~1');
    const theirs = s.git(s.original, 'rev-parse', name);
    await s.service.createWorktree('session_1', 'default');
    expect(s.branchOf()).toBe(`${name}-2`);
    expect(s.git(s.original, 'rev-parse', name)).toBe(theirs);
  } finally {
    await s.service.dispose();
    s.db.close();
  }
});
