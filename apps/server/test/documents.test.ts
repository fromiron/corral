import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DocumentCommand, WorkspaceTarget } from '@corral/contracts';
import { openDatabase } from '@corral/storage-sqlite';
import { FakeClock, Gate } from '@corral/testkit';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkspaceService } from '../src/files/service.ts';
import { WorkbenchOperations } from '../src/files/workbench-operations.ts';

// Match the existing real-Git file suite; this is a runaway limit, not a latency assertion.
vi.setConfig({ testTimeout: 30_000 });

const hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function setup(io?: ConstructorParameters<typeof WorkspaceService>[0]['io']) {
  const root = mkdtempSync(join(tmpdir(), 'corral-documents-'));
  const original = join(root, 'original');
  execFileSync('git', ['init', '-q', original]);
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], { cwd: original });
  git('config', 'core.autocrlf', 'false');
  writeFileSync(join(original, 'a.txt'), '\ufeffone\r\n');
  git('add', '.');
  git('commit', '-qm', 'first');
  const db = openDatabase(':memory:');
  db.prepare(
    "INSERT INTO work_sessions(id,project_id,corral_id,title,objective,pinned,revision,created_at,updated_at,entries_json) VALUES('s1','default',NULL,'t','',0,1,'x','x','[]')",
  ).run();
  const service = new WorkspaceService({
    db,
    clock: new FakeClock(),
    worktreeRoot: join(root, 'copies'),
    forbidden: [],
    hostId: 'host-test',
    io,
  });
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
  const path = service.copyOf('s1')?.worktree;
  if (!path) throw new Error('fixture copy missing');
  const save = (
    patch: Partial<Extract<DocumentCommand, { kind: 'save' }>> = {},
  ): DocumentCommand => ({
    kind: 'save',
    operationId: 'save_1',
    target,
    path: 'a.txt',
    baseHash: hash('\ufeffone\r\n'),
    text: '\ufefftwo\r\n',
    editVersion: 2,
    ...patch,
  });
  return { service, db, path, target, save, original };
}

it('reads full bytes and saves exact format/mode with an idempotent receipt', async () => {
  const s = await setup();
  chmodSync(join(s.path, 'a.txt'), 0o770);
  expect(await s.service.readDocument('s1', './a.txt')).toMatchObject({
    target: s.target,
    path: 'a.txt',
    content: { kind: 'text', text: '\ufeffone\r\n' },
    version: { sha256: hash('\ufeffone\r\n'), bytes: 8, encoding: 'utf-8', bom: true, eol: 'crlf' },
    writable: true,
  });
  const command = s.save();
  const result = await s.service.changeDocument('s1', command);
  expect(result).toMatchObject({
    state: 'succeeded',
    kind: 'document.save',
    result: {
      kind: 'saved',
      path: 'a.txt',
      sha256: hash('\ufefftwo\r\n'),
      bytes: 8,
      editVersion: 2,
    },
  });
  expect(readFileSync(join(s.path, 'a.txt'), 'utf8')).toBe('\ufefftwo\r\n');
  if (process.platform !== 'win32')
    expect(statSync(join(s.path, 'a.txt')).mode & 0o777).toBe(0o770);
  expect(s.service.documentOperation('s1', 'save_1')).toEqual(result);
  expect(await s.service.changeDocument('s1', command)).toEqual(result);
  await expect(s.service.changeDocument('s1', s.save({ text: 'different' }))).rejects.toThrow(
    /changed|conflict/,
  );
  expect(JSON.stringify(s.db.prepare('SELECT * FROM workbench_operations').all())).not.toContain(
    'two',
  );
  await s.service.removeWorktree('s1');
  expect(await s.service.changeDocument('s1', command)).toEqual(result);
});

it('refuses stale bytes and foreign generation without changing disk', async () => {
  const s = await setup();
  expect(await s.service.changeDocument('s1', s.save({ baseHash: hash('stale') }))).toMatchObject({
    state: 'failed',
    result: { kind: 'error', code: 'REVISION_CONFLICT' },
  });
  for (const target of [
    { ...s.target, hostId: 'other' },
    { ...s.target, copyGeneration: 2 },
  ])
    await expect(
      s.service.changeDocument('s1', s.save({ operationId: 'foreign', target })),
    ).rejects.toThrow(/target|copy|host/);
  expect(readFileSync(join(s.path, 'a.txt'), 'utf8')).toBe('\ufeffone\r\n');
  expect(
    s.db.prepare("SELECT * FROM workspace_access WHERE state IN ('active','uncertain')").all(),
  ).toEqual([]);
});

it('creates, renames exclusively and deletes only with retained recovery bytes', async () => {
  const s = await setup();
  const created = await s.service.changeDocument(
    's1',
    s.save({ operationId: 'create', path: 'nested/new.txt', baseHash: null, text: 'new\nlast' }),
  );
  expect(created.state).toBe('succeeded');
  expect(await s.service.readDocument('s1', 'nested/new.txt')).toMatchObject({
    version: { eol: 'lf', bom: false },
    content: { text: 'new\nlast' },
  });
  const renameCommand = {
    kind: 'rename',
    operationId: 'rename',
    target: s.target,
    path: 'nested/new.txt',
    toPath: 'a.txt',
    baseHash: hash('new\nlast'),
  } as const;
  expect(await s.service.changeDocument('s1', renameCommand)).toMatchObject({
    state: 'failed',
    result: { code: 'REVISION_CONFLICT' },
  });
  expect(
    await s.service.changeDocument('s1', {
      ...renameCommand,
      operationId: 'rename_ok',
      toPath: 'nested/renamed.txt',
    }),
  ).toMatchObject({
    state: 'succeeded',
    result: { kind: 'renamed', toPath: 'nested/renamed.txt' },
  });
  expect(existsSync(join(s.path, 'nested/new.txt'))).toBe(false);
  const removed = await s.service.changeDocument('s1', {
    kind: 'delete',
    operationId: 'delete',
    target: s.target,
    path: 'nested/renamed.txt',
    baseHash: hash('new\nlast'),
    confirmed: true,
  });
  expect(removed.state).toBe('succeeded');
  if (removed.result?.kind !== 'deleted') throw new Error('delete result missing');
  const checkpointId = removed.result.checkpointId;
  const checkpoint = s.service.checkpoints('s1').find((item) => item.checkpointId === checkpointId);
  expect(checkpoint).toMatchObject({ state: 'ready', pinned: true });
  expect(
    execFileSync('git', ['show', `${checkpoint?.tree}:nested/renamed.txt`], {
      cwd: s.path,
      encoding: 'utf8',
    }),
  ).toBe('new\nlast');
  expect(await s.service.readDocument('s1', 'nested/renamed.txt')).toMatchObject({
    content: { kind: 'absent' },
    version: null,
  });
  expect(readFileSync(join(s.original, 'a.txt'), 'utf8')).toBe('\ufeffone\r\n');
  expect(s.db.prepare('SELECT id FROM runs').all()).toEqual([]);
});

it('refuses deletion when a checkpoint omits or normalizes the original bytes', async () => {
  const s = await setup();
  writeFileSync(join(s.path, '.gitignore'), 'ignored.txt\n');
  writeFileSync(join(s.path, 'ignored.txt'), 'keep secret');
  writeFileSync(join(s.path, '.gitattributes'), 'a.txt text eol=lf\n');
  for (const [path, text] of [
    ['ignored.txt', 'keep secret'],
    ['a.txt', '\ufeffone\r\n'],
  ] as const) {
    const result = await s.service.changeDocument('s1', {
      kind: 'delete',
      operationId: `delete_${path}`,
      target: s.target,
      path,
      baseHash: hash(text),
      confirmed: true,
    });
    expect(result).toMatchObject({
      state: 'failed',
      result: { kind: 'error', code: 'CAPABILITY_DENIED' },
    });
    expect(readFileSync(join(s.path, path), 'utf8')).toBe(text);
  }
});

it('releases an unchanged failed write but retains an applied write whose IO acknowledgement was lost', async () => {
  const unchanged = await setup({
    writeFile: async () => {
      throw new Error('injected disk failure');
    },
  });
  expect(await unchanged.service.changeDocument('s1', unchanged.save())).toMatchObject({
    state: 'failed',
    result: { code: 'STORAGE_UNAVAILABLE' },
  });
  expect(readFileSync(join(unchanged.path, 'a.txt'), 'utf8')).toBe('\ufeffone\r\n');
  expect(unchanged.service.hasUnsafeWorktreeOwner('s1')).toBe(false);
  let writes = 0;
  const lost = await setup({
    rename: async (from, to) => {
      writes++;
      await rename(from, to);
      throw new Error('injected lost acknowledgement');
    },
  });
  const result = await lost.service.changeDocument('s1', lost.save());
  expect(result).toMatchObject({ state: 'uncertain', result: { code: 'STORAGE_UNAVAILABLE' } });
  expect(readFileSync(join(lost.path, 'a.txt'), 'utf8')).toBe('\ufefftwo\r\n');
  expect(lost.service.hasUnsafeWorktreeOwner('s1')).toBe(true);
  expect(await lost.service.changeDocument('s1', lost.save())).toEqual(result);
  expect(writes).toBe(1);
});

it('retains both paths and the writer when a rename cannot remove its source', async () => {
  const s = await setup({
    unlink: async () => {
      throw new Error('source is locked');
    },
  });
  const command: DocumentCommand = {
    kind: 'rename',
    operationId: 'partial_rename',
    target: s.target,
    path: 'a.txt',
    toPath: 'renamed.txt',
    baseHash: hash('\ufeffone\r\n'),
  };
  const result = await s.service.changeDocument('s1', command);
  expect(result.state).toBe('uncertain');
  for (const path of ['a.txt', 'renamed.txt'])
    expect(readFileSync(join(s.path, path), 'utf8')).toBe('\ufeffone\r\n');
  expect(s.service.hasUnsafeWorktreeOwner('s1')).toBe(true);
  expect(await s.service.changeDocument('s1', command)).toEqual(result);
});

it('a receipt failure retains uncertain ownership after real IO and cannot replay the save', async () => {
  const s = await setup();
  s.db.exec(
    "CREATE TRIGGER fail_document_receipt BEFORE UPDATE ON workbench_operations BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END",
  );
  await expect(s.service.changeDocument('s1', s.save())).rejects.toThrow(/recorded/);
  expect(readFileSync(join(s.path, 'a.txt'), 'utf8')).toBe('\ufefftwo\r\n');
  expect(s.service.documentOperation('s1', 'save_1').state).toBe('uncertain');
  expect(s.service.hasUnsafeWorktreeOwner('s1')).toBe(true);
  s.db.exec('DROP TRIGGER fail_document_receipt');
  const receipt = await s.service.changeDocument('s1', s.save());
  expect(receipt.state).toBe('uncertain');
  new WorkbenchOperations(s.db, new FakeClock()).recover();
  expect(s.service.documentOperation('s1', 'save_1')).toMatchObject({
    state: 'uncertain',
    result: {
      kind: 'pending',
      intent: {
        path: 'a.txt',
        baseHash: hash('\ufeffone\r\n'),
        submittedHash: hash('\ufefftwo\r\n'),
        editVersion: 2,
      },
    },
  });
  expect(s.db.prepare('SELECT state FROM workspace_access').get()).toEqual({ state: 'uncertain' });
});

it('keeps unsupported paths and bytes read-only and respects Run ownership and trust', async () => {
  const s = await setup();
  for (const [path, bytes, kind, code] of [
    ['binary.bin', Buffer.from([0, 255]), 'binary', 'CAPABILITY_DENIED'],
    ['large.txt', Buffer.alloc(1024 * 1024 + 1, 'x'), 'too_large', 'LIMIT_REACHED'],
  ] as const) {
    writeFileSync(join(s.path, path), bytes);
    expect(await s.service.readDocument('s1', path)).toMatchObject({
      content: { kind, bytes: bytes.length },
      version: null,
      writable: false,
    });
    expect(
      await s.service.changeDocument(
        's1',
        s.save({ operationId: `change_${path}`, path, baseHash: hash(bytes) }),
      ),
    ).toMatchObject({ state: 'failed', result: { code } });
    expect(readFileSync(join(s.path, path))).toEqual(bytes);
  }
  await expect(s.service.changeDocument('s1', s.save({ path: '../outside' }))).rejects.toThrow(
    /leave/,
  );
  expect(
    await s.service.changeDocument('s1', s.save({ operationId: 'nul_text', text: '\0' })),
  ).toMatchObject({
    state: 'failed',
    result: { code: 'CAPABILITY_DENIED' },
  });
  if (process.platform !== 'win32') {
    symlinkSync(join(s.original, 'a.txt'), join(s.path, 'link.txt'));
    await expect(s.service.readDocument('s1', 'link.txt')).rejects.toThrow(/symbolic link/);
    expect(
      await s.service.changeDocument(
        's1',
        s.save({ operationId: 'link_change', path: 'link.txt' }),
      ),
    ).toMatchObject({ state: 'failed', result: { code: 'CAPABILITY_DENIED' } });
  }
  s.service.acquireRun('writer', 's1', true);
  expect(await s.service.readDocument('s1', 'a.txt')).toMatchObject({ writable: false });
  await expect(s.service.changeDocument('s1', s.save())).rejects.toThrow(/writer/);
  s.service.releaseRun('writer', true);
  await s.service.configure('default', { trusted: false });
  expect(await s.service.readDocument('s1', 'a.txt')).toMatchObject({ writable: false });
  await expect(s.service.changeDocument('s1', s.save())).rejects.toThrow(/trust/);
  expect(readFileSync(join(s.original, 'a.txt'), 'utf8')).toBe('\ufeffone\r\n');
});

it('rechecks admission target before replacement and a repeated request cannot replay', async () => {
  const entered = new Gate(),
    release = new Gate();
  let writes = 0;
  const s = await setup({
    writeFile: async (...args) => {
      writes++;
      entered.open();
      await release.wait();
      return writeFile(...args);
    },
  });
  const pending = s.service.changeDocument('s1', s.save());
  await entered.wait();
  const duplicate = s.service.changeDocument('s1', s.save());
  expect(s.service.documentOperation('s1', 'save_1').state).toBe('running');
  await s.service.configure('default', { trusted: false });
  release.open();
  const result = await pending;
  expect(result).toMatchObject({ state: 'failed', result: { code: 'CAPABILITY_DENIED' } });
  expect((await duplicate).operationId).toBe('save_1');
  expect(writes).toBe(1);
  expect(readFileSync(join(s.path, 'a.txt'), 'utf8')).toBe('\ufeffone\r\n');
});
