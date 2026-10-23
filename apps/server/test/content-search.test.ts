import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '@corral/storage-sqlite';
import { FakeClock } from '@corral/testkit';
import { afterEach, expect, it } from 'vitest';
import { WorkspaceService } from '../src/files/service.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'corral-content-search-'));
  const original = join(root, 'original');
  execFileSync('git', ['init', '-q', original]);
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=f@example.test', ...args], {
      cwd: original,
    });
  writeFileSync(join(original, 'base.txt'), 'original text\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  const db = openDatabase(':memory:');
  db.prepare(
    "INSERT INTO work_sessions(id,project_id,corral_id,title,objective,pinned,revision,created_at,updated_at,entries_json) VALUES('s1','default',NULL,'t','',0,1,'x','x','[]')",
  ).run();
  const service = new WorkspaceService({
    db,
    clock: new FakeClock(),
    worktreeRoot: join(root, 'copies'),
    forbidden: [],
    hostId: 'host',
  });
  cleanups.push(async () => {
    await service.dispose();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  await service.bind('default', original);
  await service.configure('default', { trusted: true });
  const copy = await service.createWorktree('s1', 'default');
  const target = {
    hostId: 'host',
    projectId: 'default',
    bindingId: copy.bindingId,
    sessionId: 's1',
    copyGeneration: copy.copyGeneration,
  };
  const path = service.copyOf('s1')?.worktree;
  if (!path) throw new Error('fixture copy missing');
  const input = { target, queryId: 'query_1', query: 'A.b', caseSensitive: false };
  return { service, target, path, original, input };
}

it('[TC-WBD-019-H] searches literal disk text with UTF-16 positions and byte hashes while excluding ignored, protected and binary files', async () => {
  const s = await setup();
  const text = '😀 İ A.b A.B\r\nA.b AxB\n';
  writeFileSync(join(s.path, 'source.ts'), text);
  writeFileSync(join(s.path, '.gitignore'), 'ignored.txt\n');
  writeFileSync(join(s.path, 'ignored.txt'), 'A.b');
  writeFileSync(join(s.path, 'binary.dat'), Buffer.from([65, 46, 98, 0]));
  writeFileSync(join(s.path, 'large.txt'), 'A.b' + 'x'.repeat(1024 * 1024));
  mkdirSync(join(s.path, '.corral'));
  writeFileSync(join(s.path, '.corral', 'private.txt'), 'A.b');
  symlinkSync(join(s.path, 'source.ts'), join(s.path, 'link.ts'));
  const before = execFileSync('git', ['status', '--porcelain'], { cwd: s.path }).toString();
  const result = await s.service.searchContents('s1', s.input);
  expect(result).toMatchObject({
    target: s.target,
    queryId: 'query_1',
    query: 'A.b',
    caseSensitive: false,
    truncated: false,
    skippedFiles: 2,
  });
  expect(result.matches).toEqual([
    {
      path: 'source.ts',
      sha256: hash(text),
      range: { startLine: 1, startColumn: 6, endLine: 1, endColumn: 9 },
      preview: '😀 İ A.b A.B',
    },
    {
      path: 'source.ts',
      sha256: hash(text),
      range: { startLine: 1, startColumn: 10, endLine: 1, endColumn: 13 },
      preview: '😀 İ A.b A.B',
    },
    {
      path: 'source.ts',
      sha256: hash(text),
      range: { startLine: 2, startColumn: 1, endLine: 2, endColumn: 4 },
      preview: 'A.b AxB',
    },
  ]);
  expect(
    (await s.service.searchContents('s1', { ...s.input, caseSensitive: true })).matches,
  ).toHaveLength(2);
  expect((await s.service.readDocument('s1', 'source.ts')).version?.sha256).toBe(
    result.matches[0]?.sha256,
  );
  expect(execFileSync('git', ['status', '--porcelain'], { cwd: s.path }).toString()).toBe(before);
  expect(readFileSync(join(s.original, 'base.txt'), 'utf8')).toBe('original text\n');
});

it('[TC-WBD-019-N] rejects foreign or stale copy targets while preserving the existing read-only trust policy', async () => {
  const s = await setup();
  await expect(
    s.service.searchContents('s1', { ...s.input, target: { ...s.target, hostId: 'another' } }),
  ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  await expect(
    s.service.searchContents('s1', {
      ...s.input,
      target: { ...s.target, copyGeneration: s.target.copyGeneration + 1 },
    }),
  ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  await s.service.configure('default', { trusted: false });
  await expect(s.service.searchContents('s1', s.input)).resolves.toMatchObject({
    target: s.target,
    matches: [],
  });
});

it('[TC-WBD-019-F] cancels pending work and reports bounded results and disk-read truncation', async () => {
  const s = await setup();
  const cancelled = new AbortController();
  const pending = s.service.searchContents('s1', s.input, cancelled.signal);
  cancelled.abort();
  await expect(pending).rejects.toMatchObject({ code: 'TARGET_TERMINAL' });
  writeFileSync(join(s.path, 'matches.txt'), 'A.b\n'.repeat(201));
  const limited = await s.service.searchContents('s1', s.input);
  expect(limited.matches).toHaveLength(200);
  expect(limited.truncated).toBe(true);
  rmSync(join(s.path, 'matches.txt'));
  for (let index = 0; index < 9; index++)
    writeFileSync(join(s.path, `large-${index}.txt`), 'x'.repeat(1024 * 1024));
  const bounded = await s.service.searchContents('s1', s.input);
  expect(bounded.matches).toEqual([]);
  expect(bounded.truncated).toBe(true);
  expect(bounded.scannedFiles).toBeLessThanOrEqual(8);
});
