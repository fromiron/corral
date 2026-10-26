import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '@corral/storage-sqlite';
import { FakeClock } from '@corral/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceService } from '../src/files/service.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function setup(io?: ConstructorParameters<typeof WorkspaceService>[0]['io']) {
  const original = mkdtempSync(join(tmpdir(), 'corral-hashline-source-'));
  const managed = mkdtempSync(join(tmpdir(), 'corral-hashline-work-'));
  cleanups.push(() => rmSync(original, { recursive: true, force: true }));
  cleanups.push(() => rmSync(managed, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], { cwd: original });
  git('init', '-q');
  git('config', 'core.autocrlf', 'false');
  writeFileSync(join(original, 'a.txt'), '\ufeffone\r\ntwo\r\nthree\r\n');
  writeFileSync(join(original, 'occupied.txt'), 'do not overwrite\n');
  git('add', '.');
  git('commit', '-q', '-m', 'initial');
  const db = openDatabase(':memory:');
  cleanups.push(() => db.close());
  db.prepare(
    "INSERT INTO work_sessions (id, project_id, corral_id, title, objective, pinned, revision, created_at, updated_at, archived_at, entries_json) VALUES ('session_1', 'default', NULL, 't', '', 0, 1, 'x', 'x', NULL, '[]')",
  ).run();
  db.prepare(
    `INSERT INTO runs (id, corral_id, definition_hash, snapshot_json, status, last_seq,
       projection_json, started_at, project_id, session_id)
     VALUES ('run_1', 'c', 'h', '{}', 'running', 0,
       '{"executions":{"exec_1":{"attemptNo":1},"foreign":{"attemptNo":1}}}', 'x', 'default', 'session_1')`,
  ).run();
  const service = new WorkspaceService({
    db,
    clock: new FakeClock(),
    worktreeRoot: join(managed, 'worktrees'),
    forbidden: [],
    ...(io ? { io } : {}),
  });
  await service.bind('default', original);
  await service.configure('default', { trusted: true });
  await service.createWorktree('session_1', 'default');
  const copy = service.copyOf('session_1');
  if (!copy) throw new Error('managed worktree was not created');
  const root = copy.worktree;
  let callId = 0;
  let attemptNo = 1;
  const call = (
    name: 'read_hashline' | 'edit_hashline' | 'read_file' | 'edit' | 'write_file',
    args: Record<string, unknown>,
    executionId = 'exec_1',
    aborted = false,
  ) =>
    service.execute(
      {
        name,
        args,
        runId: 'run_1',
        executionId,
        attemptNo,
        toolCallId: `hashline_${++callId}`,
      },
      { aborted, onCancel: () => () => {} },
    );
  const read = (path = 'a.txt', extra = {}) => call('read_hashline', { path, ...extra });
  const edit = (
    tag: unknown,
    ops: string,
    path = 'a.txt',
    executionId = 'exec_1',
    aborted = false,
  ) => call('edit_hashline', { version: 1, path, tag, ops }, executionId, aborted);
  return {
    db,
    root,
    call,
    read,
    edit,
    setAttempt: (value: number) => {
      attemptNo = value;
    },
  };
}

// Windows Git worktree creation uses real subprocesses and can exceed the default
// five seconds when the independent integration suites run concurrently.
describe('Hashline managed file broker', { timeout: 30_000 }, () => {
  it('runs read→PUT/CUT→MV→REM through managed file journals and preserves original bytes', async () => {
    const s = await setup();
    const before = await s.read();
    expect(before.text).toContain('1:one');
    expect(before).not.toHaveProperty('evidence');
    await s.edit(before.tag, 'PUT 2.=2:\n+TWO\nCUT 3.=3');
    expect(readFileSync(join(s.root, 'a.txt'), 'utf8')).toBe('\ufeffone\r\nTWO\r\n');
    const updated = await s.read();
    await s.edit(updated.tag, 'MV moved.txt');
    expect(existsSync(join(s.root, 'a.txt'))).toBe(false);
    expect(readFileSync(join(s.root, 'moved.txt'), 'utf8')).toBe('\ufeffone\r\nTWO\r\n');
    const moved = await s.read('moved.txt');
    await s.edit(moved.tag, 'REM', 'moved.txt');
    expect(existsSync(join(s.root, 'moved.txt'))).toBe(false);
    expect(s.db.prepare('SELECT kind, state FROM file_operations ORDER BY rowid').all()).toEqual([
      { kind: 'write', state: 'applied' },
      { kind: 'move', state: 'applied' },
      { kind: 'delete', state: 'applied' },
    ]);
  });

  it('refuses foreign executions, stale full hashes and cancelled edits before writes', async () => {
    const s = await setup();
    const read = await s.read();
    const original = readFileSync(join(s.root, 'a.txt'));
    await expect(s.edit(read.tag, 'REM', 'a.txt', 'foreign')).rejects.toThrow();
    await expect(s.edit(read.tag, 'REM', 'a.txt', 'exec_1', true)).rejects.toMatchObject({
      code: 'TARGET_TERMINAL',
    });
    expect(readFileSync(join(s.root, 'a.txt'))).toEqual(original);
    // Same displayed tag (trailing whitespace normalization), different full bytes.
    writeFileSync(join(s.root, 'a.txt'), '\ufeffone \r\ntwo\r\nthree\r\n');
    await expect(s.edit(read.tag, 'PUT >$:\n+four')).rejects.toMatchObject({
      code: 'REVISION_CONFLICT',
    });
    expect(s.db.prepare('SELECT count(*) AS n FROM file_operations').get()).toEqual({ n: 0 });
  });

  it('partial reads never authorize unseen rows and errors do not grant evidence', async () => {
    const s = await setup();
    const read = await s.read('a.txt', { offset: 1, limit: 1 });
    expect(read.text).not.toContain('2:two');
    await expect(
      s.call('write_file', { path: 'a.txt', text: 'unseen overwrite' }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    await expect(s.edit(read.tag, 'CUT 2.=2')).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    await expect(s.edit(read.tag, 'CUT 2.=2')).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    const other = await s.read('a.txt', { offset: 2, limit: 1 });
    await s.edit(other.tag, 'PUT 2.=2:\n+TWO');
    expect(readFileSync(join(s.root, 'a.txt'), 'utf8')).toBe('\ufeffone\r\nTWO\r\nthree\r\n');
    await expect(
      s.call('write_file', { path: 'a.txt', text: 'unseen overwrite' }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  });

  it('a new attempt cannot inherit earlier read evidence even with the same execution ID', async () => {
    const s = await setup();
    const read = await s.read();
    s.db
      .prepare(
        "UPDATE runs SET projection_json=json_set(projection_json, '$.executions.exec_1.attemptNo', 2) WHERE id='run_1'",
      )
      .run();
    await expect(s.edit(read.tag, 'REM')).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(existsSync(join(s.root, 'a.txt'))).toBe(true);
    await expect(s.read()).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    s.setAttempt(2);
    const next = await s.read();
    await s.edit(next.tag, 'PUT 1.=1:\n+new attempt');
    expect(readFileSync(join(s.root, 'a.txt'), 'utf8')).toContain('new attempt');
  });

  it('destination collision and mixed move/write leave both paths intact', async () => {
    const s = await setup();
    const read = await s.read();
    const original = readFileSync(join(s.root, 'a.txt'));
    await expect(s.edit(read.tag, 'MV occupied.txt')).rejects.toMatchObject({
      code: 'REVISION_CONFLICT',
    });
    await expect(s.edit(read.tag, 'PUT 1.=1:\n+changed\nMV next.txt')).rejects.toThrow();
    expect(readFileSync(join(s.root, 'a.txt'))).toEqual(original);
    expect(readFileSync(join(s.root, 'occupied.txt'), 'utf8')).toBe('do not overwrite\n');
    expect(existsSync(join(s.root, 'next.txt'))).toBe(false);
  });

  it('failed atomic preparation preserves file bytes and records failure', async () => {
    const s = await setup({
      writeFile: async () => {
        throw new Error('simulated disk error');
      },
    });
    const read = await s.read();
    const original = readFileSync(join(s.root, 'a.txt'));
    await expect(s.edit(read.tag, 'PUT 1.=1:\n+changed')).rejects.toThrow();
    expect(readFileSync(join(s.root, 'a.txt'))).toEqual(original);
    expect(s.db.prepare('SELECT state FROM file_operations').all()).toEqual([{ state: 'failed' }]);
  });

  it('an attempt change during write preparation blocks the final mutation', async () => {
    let onPrepared: (() => void) | undefined;
    const s = await setup({
      writeFile: async (path, bytes, options) => {
        await writeFile(path, bytes, options);
        onPrepared?.();
      },
    });
    const read = await s.read();
    const original = readFileSync(join(s.root, 'a.txt'));
    onPrepared = () => {
      s.db
        .prepare(
          "UPDATE runs SET projection_json=json_set(projection_json, '$.executions.exec_1.attemptNo', 2) WHERE id='run_1'",
        )
        .run();
    };
    await expect(s.edit(read.tag, 'PUT 1.=1:\n+late')).rejects.toMatchObject({
      code: 'REVISION_CONFLICT',
    });
    expect(readFileSync(join(s.root, 'a.txt'))).toEqual(original);
    expect(s.db.prepare('SELECT state FROM file_operations').all()).toEqual([{ state: 'failed' }]);
  });

  it('existing Pi read→oldText/newText remains available', async () => {
    const s = await setup();
    await s.call('read_file', { path: 'a.txt' });
    await s.call('edit', { path: 'a.txt', edits: [{ oldText: 'two', newText: 'TWO' }] });
    expect(readFileSync(join(s.root, 'a.txt'), 'utf8')).toBe('\ufeffone\r\nTWO\r\nthree\r\n');
  });
});
