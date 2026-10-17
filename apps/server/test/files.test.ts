import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, SqliteProjectToolStore } from '@corral/storage-sqlite';
import { FakeClock, Gate } from '@corral/testkit';
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

async function setup(edit?: ConstructorParameters<typeof WorkspaceService>[0]['edit']) {
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
    ...(edit ? { edit } : {}),
  });
  await service.bind('default', original);
  await service.configure('default', { trusted: true });
  await service.createWorktree('session_1', 'default');
  const call = (
    name: 'read_file' | 'write_file' | 'delete_file' | 'move_file' | 'edit' | 'write',
    args: Record<string, unknown>,
    executionId = 'exec_1',
  ) =>
    service.execute(
      { name, args, runId: 'run_1', executionId, toolCallId: `tool_${Math.random()}` },
      { aborted: false, onCancel: () => () => {} },
    );
  return { db, service, call, original };
}

describe('file broker (CR-012)', () => {
  it('[TC-HAR-012-H] existing workspace settings write immutable check revisions and read their authority', async () => {
    const { service, db } = await setup();
    const check = { id: 'types', name: 'Types', argv: ['node', 'check.mjs'], timeoutMs: 10000 };
    await service.configure('default', { verifyCommands: [check] });
    const store = new SqliteProjectToolStore(db, new FakeClock());
    const first = store.latest('default');
    expect(first).toMatchObject({ checks: [check] });
    await service.configure('default', { verifyCommands: [] });
    expect(store.latest('default')?.revision).toBe((first?.revision ?? 0) + 1);
    expect(store.get('default', first?.revision ?? 0)?.checks).toEqual([check]);
    db.prepare('UPDATE workspace_bindings SET verify_json = ?').run(JSON.stringify([check]));
    expect((await service.view('default'))?.verifyCommands).toEqual([]);
    await expect(service.configure('default', { verifyCommands: [{ ...check, argv: [] }] })).rejects.toThrow();
    expect(store.latest('default')?.checks).toEqual([]);
  });
  it('[TC-HAR-010-N] cancellation or an external change during edit calculation leaves the file untouched', async () => {
    for (const cause of ['cancel', 'changed']) {
      const entered = new Gate();
      const release = new Gate();
      let aborted = false;
      const { service, call, db } = await setup(async () => {
        entered.open();
        await release.wait();
        return {
          text: 'two\n',
          result: {
            content: [{ type: 'text', text: 'Changed.' }],
            details: { diff: 'diff', patch: 'patch', firstChangedLine: 1 },
          },
        };
      });
      await call('read_file', { path: 'a.txt' });
      const root = (
        service as unknown as { worktree(id: string): { worktree_path: string } }
      ).worktree('session_1').worktree_path;
      const pending = service.execute(
        {
          name: 'edit',
          args: { path: 'a.txt', edits: [{ oldText: 'one', newText: 'two' }] },
          runId: 'run_1',
          executionId: 'exec_1',
          toolCallId: 'tool_edit',
        },
        {
          get aborted() {
            return aborted;
          },
          onCancel: () => () => {},
        },
      );
      const rejected = expect(pending).rejects.toThrow(
        cause === 'cancel' ? /cancelled/ : /changed since/,
      );
      await entered.wait();
      if (cause === 'cancel') aborted = true;
      else writeFileSync(join(root, 'a.txt'), 'external\n');
      release.open();
      await rejected;
      expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe(
        cause === 'cancel' ? 'one\n' : 'external\n',
      );
      expect(db.prepare('SELECT COUNT(*) AS n FROM file_operations').get()).toEqual({ n: 0 });
    }
  });
  it('[TC-HAR-010-H] Pi edit and write use the same read evidence and recorded atomic write path', async () => {
    const { call, db } = await setup();
    await call('read_file', { path: 'a.txt' });
    const edit = await call('edit', { path: 'a.txt', edits: [{ oldText: 'one', newText: 'two' }] });
    expect(edit).toMatchObject({
      path: 'a.txt',
      piResult: {
        content: [{ type: 'text', text: 'Successfully replaced 1 block(s) in a.txt.' }],
        details: { firstChangedLine: 1 },
      },
    });
    expect(await call('read_file', { path: 'a.txt' })).toMatchObject({ text: 'two\n' });
    await call('write', { path: 'new.txt', content: 'A new file.' });
    expect(await call('read_file', { path: 'new.txt' })).toMatchObject({ text: 'A new file.' });
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM file_operations WHERE state = 'applied'").get(),
    ).toEqual({ n: 2 });
  });
  it('[TC-HAR-010-N] all edit blocks must validate before any bytes are changed', async () => {
    const { call, db } = await setup();
    await call('read_file', { path: 'a.txt' });
    await expect(
      call('edit', {
        path: 'a.txt',
        edits: [
          { oldText: 'one', newText: 'two' },
          { oldText: 'missing', newText: 'three' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'SCHEMA_INVALID', message: expect.stringContaining('a.txt') });
    expect(await call('read_file', { path: 'a.txt' })).toMatchObject({ text: 'one\n' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM file_operations').get()).toEqual({ n: 0 });
  });
  it('[TC-HAR-011-N] a different execution or restarted attempt cannot borrow another execution’s read', async () => {
    const { call } = await setup();
    await call('read_file', { path: 'a.txt' }, 'exec_a');
    await expect(
      call('write_file', { path: 'a.txt', text: 'unread overwrite' }, 'exec_b'),
    ).rejects.toThrow(/read a.txt/);
    await expect(call('delete_file', { path: 'a.txt' }, 'exec_a_retry')).rejects.toThrow(
      /read a.txt/,
    );
  });
  it('[TC-HAR-011-H] [TC-HAR-011-N] B writing after A reads does not refresh A’s evidence', async () => {
    const { call } = await setup();
    await call('read_file', { path: 'a.txt' }, 'exec_a');
    await call('read_file', { path: 'a.txt' }, 'exec_b');
    await call('write_file', { path: 'a.txt', text: 'B changed this\n' }, 'exec_b');
    await expect(
      call('write_file', { path: 'a.txt', text: 'A stale change\n' }, 'exec_a'),
    ).rejects.toThrow(/changed since/);
    await call('read_file', { path: 'a.txt' }, 'exec_a');
    await expect(
      call('write_file', { path: 'a.txt', text: 'A reviewed change\n' }, 'exec_a'),
    ).resolves.toMatchObject({ created: false });
  });
  it('[DW-05] browsing stays inside its project or session and does not grant an agent a read', async () => {
    const { service, call, original } = await setup();
    const scope = { kind: 'project' as const, id: 'default' };
    mkdirSync(join(original, 'nested'));
    writeFileSync(join(original, 'nested', 'plain.txt'), 'hello');
    writeFileSync(join(original, 'binary.dat'), Buffer.from([0, 1, 2]));
    writeFileSync(join(original, 'large.txt'), 'x'.repeat(1024 * 1024 + 1));
    symlinkSync('/etc', join(original, 'outside'));
    const listed = await service.listFiles(scope);
    expect(listed.files.map((f) => f.path)).toEqual(
      expect.arrayContaining(['a.txt', 'nested/plain.txt']),
    );
    expect(
      listed.files.some((f) => f.path.startsWith('.git/') || f.path.startsWith('outside/')),
    ).toBe(false);
    await expect(service.readFile(scope, 'nested/plain.txt')).resolves.toMatchObject({
      content: { kind: 'text', text: 'hello' },
    });
    await expect(service.readFile(scope, 'binary.dat')).resolves.toMatchObject({
      content: { kind: 'binary' },
    });
    await expect(service.readFile(scope, 'large.txt')).resolves.toMatchObject({
      content: { kind: 'too_large' },
    });
    for (const bad of ['../a.txt', '/etc/passwd', '.git/config', 'outside/passwd']) {
      await expect(service.readFile(scope, bad)).rejects.toThrow();
    }
    await expect(service.listFiles(scope, 'outside')).rejects.toThrow();
    await expect(
      service.readFile({ kind: 'session', id: 'session_1' }, 'a.txt'),
    ).resolves.toMatchObject({ content: { kind: 'text', text: 'one\n' } });
    await expect(call('write_file', { path: 'a.txt', text: 'two' })).rejects.toThrow(/read a.txt/);
    await expect(service.readFile({ kind: 'project', id: 'missing' }, 'a.txt')).rejects.toThrow();
    rmSync(original, { recursive: true });
    await expect(service.listFiles(scope)).rejects.toThrow();
  });

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

describe('path search for `@` references (CR-016)', () => {
  it('[TC-REF-010-H] finds files and folders by fuzzy name, file names first, without reading them', async () => {
    const { service, original } = await setup();
    const scope = { kind: 'project' as const, id: 'default' };
    mkdirSync(join(original, 'src', 'pages'), { recursive: true });
    writeFileSync(join(original, 'src', 'pages', 'SessionPage.tsx'), 'x');
    writeFileSync(join(original, 'src', 'session.ts'), 'x');
    mkdirSync(join(original, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(original, 'node_modules', 'dep', 'session.js'), 'x');
    writeFileSync(join(original, '.gitignore'), 'node_modules\n');
    symlinkSync('/etc', join(original, 'outside'));
    const found = await service.searchPaths(scope, 'sesspage', 10);
    expect(found.items[0]).toEqual({ path: 'src/pages/SessionPage.tsx', kind: 'file' });
    const folders = await service.searchPaths(scope, 'pages', 10);
    expect(folders.items).toContainEqual({ path: 'src/pages', kind: 'folder' });
    const all = await service.searchPaths(scope, 'session', 50);
    expect(all.items.some((i) => i.path.startsWith('node_modules'))).toBe(false);
    expect(all.items.some((i) => i.path.startsWith('outside') || i.path.startsWith('.git'))).toBe(
      false,
    );
    expect((await service.searchPaths(scope, 'session', 1)).items).toHaveLength(1);
    expect((await service.searchPaths(scope, 'zzzz', 10)).items).toEqual([]);
  });

  it('[TC-REF-011-F] searches only registered scopes', async () => {
    const { service } = await setup();
    await expect(service.searchPaths({ kind: 'project', id: 'missing' }, 'a', 5)).rejects.toThrow();
    await expect(
      service.searchPaths({ kind: 'session', id: 'session_1' }, 'a', 5),
    ).resolves.toMatchObject({ items: [{ path: 'a.txt', kind: 'file' }] });
  });
});

describe('review, applying and reverting (CR-013)', () => {
  it('[WB-REV-004/005] applies the approved tree, skips or refuses conflicts, and reverts only what is unchanged', async () => {
    const { db, service, call, original } = await setup();
    const { ReviewService } = await import('../src/files/review.ts');
    const review = new ReviewService({ db, clock: new FakeClock(), files: service });
    await call('read_file', { path: 'a.txt' });
    await call('write_file', { path: 'a.txt', text: 'two\n' });
    await call('write_file', { path: 'b.txt', text: 'bee\n' });
    await call('write_file', { path: 'c.txt', text: 'sea\n' });
    const copy = service.copyOf('session_1');
    if (!copy) throw new Error('no copy');
    const to = (await service.latestTree('session_1')) as string;

    // A comment fixed to these trees, sent as a batch.
    const comment = review.addComment('session_1', {
      from: copy.baseTree,
      to,
      path: 'a.txt',
      side: 'after',
      startLine: 1,
      endLine: 1,
      quote: 'two',
      body: 'Say three instead.',
    });
    expect(review.batchText('session_1', [comment.commentId])).toContain('a.txt lines 1–1');
    review.recordBatch('session_1', {
      commentIds: [comment.commentId],
      intent: 'next',
      runId: 'run_2',
      executionId: null,
      text: 'x',
      sent: true,
      detail: null,
    });
    expect(review.comments('session_1')[0]?.state).toBe('submitted');

    // c.txt already exists in the folder with other content: a conflict, never overwritten.
    writeFileSync(join(original, 'c.txt'), 'mine\n');
    const decisionId = review.decide('session_1', {
      from: copy.baseTree,
      to,
      decision: 'approved',
      note: '',
    });
    const plan = await review.plan('session_1', decisionId);
    expect(Object.fromEntries(plan.map((p) => [p.path, p.outcome]))).toEqual({
      'a.txt': 'apply',
      'b.txt': 'apply',
      'c.txt': 'conflict',
    });
    const applied = await review.integrate('session_1', decisionId);
    expect(applied.state).toBe('partial');
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(join(original, 'a.txt'), 'utf8')).toBe('two\n');
    expect(readFileSync(join(original, 'b.txt'), 'utf8')).toBe('bee\n');
    expect(readFileSync(join(original, 'c.txt'), 'utf8')).toBe('mine\n');

    // A person edits b.txt afterwards: reverting leaves it, and undoes a.txt.
    writeFileSync(join(original, 'b.txt'), 'edited\n');
    const reverted = await review.revert('session_1', applied.integrationId);
    expect(Object.fromEntries(reverted.files.map((f) => [f.path, f.outcome]))).toEqual({
      'a.txt': 'reverted',
      'b.txt': 'revert_conflict',
      'c.txt': 'conflict',
    });
    expect(readFileSync(join(original, 'a.txt'), 'utf8')).toBe('one\n');
    expect(readFileSync(join(original, 'b.txt'), 'utf8')).toBe('edited\n');

    // Decisions go stale when the copy changes; unreviewed writes show in the inbox.
    await call('write_file', { path: 'd.txt', text: 'dee\n' });
    expect((await review.decisions('session_1'))[0]?.stale).toBe(true);
    const inbox = review.inbox(
      [{ sessionId: 'session_1', title: 't', entries: [{ state: 'queued', text: 'next' }] }],
      [{ runId: 'run_1', status: 'awaiting_user', sessionId: 'session_1' }],
    );
    expect(inbox.map((i) => i.kind).sort()).toEqual([
      'decision',
      'integration',
      'queued',
      'unreviewed',
    ]);
  });
});

describe('missing folders (02-UX-Spec §8)', () => {
  it('says when the linked folder or the working copy is gone, instead of failing', async () => {
    const { service, original } = await setup();
    const copy = service.copyOf('session_1');
    if (!copy) throw new Error('no copy');
    rmSync(copy.worktree, { recursive: true, force: true });
    expect(service.worktreeView('session_1')?.missing).toBe(true);
    rmSync(original, { recursive: true, force: true });
    expect((await service.view('default'))?.missing).toBe(true);
  });
});

describe('the linked folder as Git sees it (02-UX-Spec §4)', () => {
  it('lists tracked changes against HEAD and untracked files, and reads the disk side', async () => {
    const { service, original } = await setup();
    writeFileSync(join(original, 'a.txt'), 'one\nmore\n');
    writeFileSync(join(original, 'new.txt'), 'fresh\n');
    const changes = await service.folderChanges('default');
    expect(changes.files.map((f) => [f.path, f.status])).toEqual([
      ['a.txt', 'modified'],
      ['new.txt', 'added'],
    ]);
    const versions = await service.folderFileVersions('default', 'a.txt');
    expect(versions.before).toEqual({ kind: 'text', text: 'one\n' });
    expect(versions.after).toEqual({ kind: 'text', text: 'one\nmore\n' });
  });
});
