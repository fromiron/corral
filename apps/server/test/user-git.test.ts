import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { GitFileSide, GitStatus } from '@corral/contracts';
import { afterEach, expect, it, vi } from 'vitest';
import * as gitModule from '../src/files/git.ts';
import { readUserGitDiff, readUserGitStatus } from '../src/files/user-git.ts';

// Real Git subprocesses share CI workers; this is a runaway limit, not a latency assertion.
vi.setConfig({ testTimeout: 30_000 });

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function git(root: string, ...args: string[]) {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=Git fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.attributesFile=/dev/null',
      '-c',
      'core.autocrlf=false',
      '-c',
      'commit.gpgSign=false',
      ...args,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_ATTR_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

function setup(files: Record<string, string | Buffer> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'corral-user-git-'));
  directories.push(directory);
  const root = join(directory, 'original');
  git(directory, 'init', '-q', '-b', 'main', root);
  git(root, 'config', 'core.autocrlf', 'false');
  for (const [path, content] of Object.entries(files)) writeFileSync(join(root, path), content);
  if (Object.keys(files).length) {
    git(root, 'add', '--', '.');
    git(root, 'commit', '-qm', 'fixture');
  }
  return { directory, root };
}

function disk(root: string) {
  return async (path: string): Promise<GitFileSide> => {
    const file = join(root, path);
    if (!existsSync(file)) return { kind: 'absent' };
    const bytes = readFileSync(file);
    return bytes.includes(0)
      ? { kind: 'binary', bytes: bytes.length }
      : { kind: 'text', text: bytes.toString('utf8') };
  };
}

function basis(status: Omit<GitStatus, 'target'>) {
  return { head: status.head.oid, indexHash: status.indexHash };
}

it('[TC-WBD-008-H] separates staged and unstaged bytes and preserves raw renamed/untracked paths', async () => {
  const path = '함께 수정.txt';
  const originalPath = '이전 이름.txt';
  const renamedPath = ' 새 이름\n줄.txt ';
  const untrackedPath = ' 새 파일\n둘.txt ';
  const before = '\ufeff처음\r\n끝\r\n';
  const staged = '\ufeff스테이지\r\n끝\r\n';
  const working = '\ufeff작업 파일\r\n끝\r\n';
  const f = setup({
    [path]: before,
    [originalPath]: 'rename me\n',
    'binary.bin': Buffer.from([0, 1]),
  });
  writeFileSync(join(f.root, path), staged);
  git(f.root, 'add', '--', path);
  writeFileSync(join(f.root, path), working);
  git(f.root, 'mv', '--', originalPath, renamedPath);
  writeFileSync(join(f.root, untrackedPath), 'new file\n');
  writeFileSync(join(f.root, 'binary.bin'), Buffer.from([0, 2, 3]));

  const status = await readUserGitStatus(f.root);
  expect(status).toMatchObject({ truncated: false, filtersDisabled: false });
  expect(status.entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: 'ordinary', path, indexStatus: 'M', worktreeStatus: 'M' }),
      expect.objectContaining({
        kind: 'renamed',
        path: renamedPath,
        originalPath,
        indexStatus: 'R',
        worktreeStatus: '.',
      }),
      expect.objectContaining({ kind: 'untracked', path: untrackedPath }),
    ]),
  );
  const read = (side: 'staged' | 'unstaged' | 'untracked', path: string) =>
    readUserGitDiff(f.root, { side, path, ...basis(status) }, disk(f.root));
  expect(await read('staged', path)).toMatchObject({
    kind: 'diff',
    before: { kind: 'text', text: before },
    after: { kind: 'text', text: staged },
  });
  expect(await read('unstaged', path)).toMatchObject({
    kind: 'diff',
    before: { kind: 'text', text: staged },
    after: { kind: 'text', text: working },
  });
  expect(await read('staged', renamedPath)).toMatchObject({
    kind: 'diff',
    before: { kind: 'text', text: 'rename me\n' },
    after: { kind: 'text', text: 'rename me\n' },
  });
  expect(await read('untracked', untrackedPath)).toMatchObject({
    kind: 'diff',
    before: { kind: 'absent' },
    after: { kind: 'text', text: 'new file\n' },
  });
  expect(await read('unstaged', 'binary.bin')).toMatchObject({
    kind: 'diff',
    before: { kind: 'binary', bytes: 2 },
    after: { kind: 'binary', bytes: 3 },
  });
  expect(readFileSync(join(f.root, path), 'utf8')).toBe(working);
});

it('[TC-WBD-008-N] observes unborn, detached and shallow branches without inventing upstream counts', async () => {
  const f = setup();
  const empty = await readUserGitStatus(f.root);
  expect(empty).toMatchObject({
    head: {
      oid: null,
      branch: 'main',
      detached: false,
      unborn: true,
      shallow: false,
      upstream: null,
    },
    entries: [],
    indexHash: createHash('sha256').update('').digest('hex'),
  });
  writeFileSync(join(f.root, 'first.txt'), 'first\n');
  git(f.root, 'add', '--', 'first.txt');
  const initial = await readUserGitStatus(f.root);
  expect(
    await readUserGitDiff(
      f.root,
      {
        side: 'staged',
        path: 'first.txt',
        ...basis(initial),
      },
      disk(f.root),
    ),
  ).toMatchObject({
    kind: 'diff',
    before: { kind: 'absent' },
    after: { kind: 'text', text: 'first\n' },
  });
  git(f.root, 'commit', '-qm', 'first');
  writeFileSync(join(f.root, 'first.txt'), 'second\n');
  git(f.root, 'add', '--', 'first.txt');
  git(f.root, 'commit', '-qm', 'second');

  // file:// applies --depth to this local fixture; no remote network is involved.
  const shallow = join(f.directory, 'shallow');
  git(f.directory, 'clone', '-q', '--depth=1', pathToFileURL(f.root).href, shallow);
  expect((await readUserGitStatus(shallow)).head).toMatchObject({
    branch: 'main',
    detached: false,
    unborn: false,
    shallow: true,
    upstream: { name: 'origin/main', ahead: 0, behind: 0 },
  });
  writeFileSync(join(shallow, 'first.txt'), 'local commit\n');
  git(shallow, 'add', '--', 'first.txt');
  git(shallow, 'commit', '-qm', 'local');
  expect((await readUserGitStatus(shallow)).head.upstream).toEqual({
    name: 'origin/main',
    ahead: 1,
    behind: 0,
  });
  git(shallow, 'update-ref', '-d', 'refs/remotes/origin/main');
  expect((await readUserGitStatus(shallow)).head.upstream).toEqual({
    name: 'origin/main',
    ahead: null,
    behind: null,
  });

  const oid = git(f.root, 'rev-parse', 'HEAD').toString().trim();
  git(f.root, 'checkout', '-q', '--detach');
  expect((await readUserGitStatus(f.root)).head).toEqual({
    oid,
    branch: null,
    detached: true,
    unborn: false,
    shallow: false,
    upstream: null,
  });
});

it('[TC-WBD-008-F] disables executable Git helpers while preserving index bytes, mtime and snapshot refs', async () => {
  const f = setup({
    '.gitattributes':
      'clean.txt filter=cleantrap diff=difftrap\nprocess.txt filter=processtrap\nbinary.bin diff=difftrap\n',
    'clean.txt': 'before clean\n',
    'process.txt': 'before process\n',
    'binary.bin': Buffer.from([0, 1]),
    'unchanged.txt': 'same\n',
  });
  const marker = join(f.directory, 'helper-ran');
  const script = join(f.directory, 'helper.cjs');
  writeFileSync(
    script,
    "require('node:fs').writeFileSync(process.argv[2], 'executed'); process.exit(1);\n",
  );
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const command = `${quote(process.execPath)} ${quote(script)} ${quote(marker)}`;
  for (const [key, value] of [
    ['filter.cleantrap.clean', command],
    ['filter.cleantrap.required', 'true'],
    ['filter.processtrap.process', command],
    ['filter.processtrap.required', 'true'],
    ['core.fsmonitor', command],
    ['diff.external', command],
    ['diff.difftrap.command', command],
    ['diff.difftrap.textconv', command],
  ] as const)
    git(f.root, 'config', key, value);
  const hooks = join(f.directory, 'hooks');
  mkdirSync(hooks);
  writeFileSync(join(hooks, 'post-index-change'), `#!/bin/sh\nexec ${command}\n`, { mode: 0o700 });
  git(f.root, 'config', 'core.hooksPath', hooks);
  writeFileSync(join(f.root, 'clean.txt'), 'after clean\n');
  writeFileSync(join(f.root, 'process.txt'), 'after process\n');
  writeFileSync(join(f.root, 'binary.bin'), Buffer.from([0, 2, 3]));
  utimesSync(join(f.root, 'unchanged.txt'), new Date(0), new Date(0));
  const index = join(f.root, '.git', 'index');
  const before = { bytes: readFileSync(index), mtime: statSync(index, { bigint: true }).mtimeNs };
  const refs = git(f.root, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/corral/');

  const status = await readUserGitStatus(f.root);
  expect(status.filtersDisabled).toBe(true);
  for (const path of ['clean.txt', 'process.txt', 'binary.bin']) {
    const result = await readUserGitDiff(
      f.root,
      {
        side: 'unstaged',
        path,
        ...basis(status),
      },
      disk(f.root),
    );
    expect(result).toMatchObject({ kind: 'diff', filtersDisabled: true });
    if (path !== 'binary.bin')
      expect(result).toMatchObject({ after: { text: `after ${path.split('.')[0]}\n` } });
  }
  expect(existsSync(marker)).toBe(false);
  expect(readFileSync(index)).toEqual(before.bytes);
  expect(statSync(index, { bigint: true }).mtimeNs).toBe(before.mtime);
  expect(git(f.root, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/corral/')).toEqual(
    refs,
  );
  expect(readFileSync(join(f.root, 'clean.txt'), 'utf8')).toBe('after clean\n');
});

it('[TC-WBD-008-F] rejects an old HEAD/index and an index changed while reading the disk side', async () => {
  const f = setup({ 'a.txt': 'base\n' });
  const old = await readUserGitStatus(f.root);
  writeFileSync(join(f.root, 'a.txt'), 'new index\n');
  git(f.root, 'add', '--', 'a.txt');
  writeFileSync(join(f.root, 'a.txt'), 'working\n');
  const reader = vi.fn(disk(f.root));
  await expect(
    readUserGitDiff(
      f.root,
      {
        side: 'unstaged',
        path: 'a.txt',
        ...basis(old),
      },
      reader,
    ),
  ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  expect(reader).not.toHaveBeenCalled();

  const current = await readUserGitStatus(f.root);
  await expect(
    readUserGitDiff(
      f.root,
      {
        side: 'unstaged',
        path: 'a.txt',
        ...basis(current),
      },
      async (path) => {
        const content = await disk(f.root)(path);
        writeFileSync(join(f.root, path), 'changed during read\n');
        git(f.root, 'add', '--', path);
        return content;
      },
    ),
  ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  expect(git(f.root, 'show', ':a.txt').toString()).toBe('changed during read\n');

  const beforeCommit = await readUserGitStatus(f.root);
  git(f.root, 'commit', '-qm', 'external commit');
  const afterCommit = await readUserGitStatus(f.root);
  expect(afterCommit.indexHash).toBe(beforeCommit.indexHash);
  expect(afterCommit.head.oid).not.toBe(beforeCommit.head.oid);
  await expect(
    readUserGitDiff(
      f.root,
      {
        side: 'staged',
        path: 'a.txt',
        ...basis(beforeCommit),
      },
      disk(f.root),
    ),
  ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
});

it('[TC-WBD-008-F] rejects index changes during status rather than returning a mixed observation', async () => {
  const f = setup({ 'a.txt': 'base\n' });
  writeFileSync(join(f.root, 'a.txt'), 'disk\n');
  const execute = gitModule.git;
  let changed = false;
  vi.spyOn(gitModule, 'git').mockImplementation(async (root, args, options) => {
    const result = await execute(root, args, options);
    if (root === f.root && args[0] === 'status' && !changed) {
      changed = true;
      git(f.root, 'add', '--', 'a.txt');
    }
    return result;
  });
  await expect(readUserGitStatus(f.root)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  expect(changed).toBe(true);
  expect(git(f.root, 'show', ':a.txt').toString()).toBe('disk\n');
});

it('[TC-WBD-008-H] reads each linked copy index and reports symlink/gitlink comparisons as unsupported', async () => {
  const f = setup({ 'a.txt': 'original\n' });
  const first = join(f.directory, 'first-copy');
  const second = join(f.directory, 'second-copy');
  git(f.root, 'worktree', 'add', '-q', '--detach', first, 'HEAD');
  git(f.root, 'worktree', 'add', '-q', '--detach', second, 'HEAD');
  writeFileSync(join(first, 'a.txt'), 'first index\n');
  git(first, 'add', '--', 'a.txt');
  writeFileSync(join(first, 'a.txt'), 'first disk\n');
  writeFileSync(join(second, 'a.txt'), 'second index\n');
  git(second, 'add', '--', 'a.txt');
  const a = await readUserGitStatus(first);
  const b = await readUserGitStatus(second);
  expect(a.indexHash).not.toBe(b.indexHash);
  expect(a.head.oid).toBe(b.head.oid);
  for (const [root, status, text] of [
    [first, a, 'first index\n'],
    [second, b, 'second index\n'],
  ] as const) {
    expect(
      await readUserGitDiff(
        root,
        {
          side: 'staged',
          path: 'a.txt',
          ...basis(status),
        },
        disk(root),
      ),
    ).toMatchObject({
      kind: 'diff',
      before: { kind: 'text', text: 'original\n' },
      after: { kind: 'text', text },
    });
  }
  expect(readFileSync(join(f.root, 'a.txt'), 'utf8')).toBe('original\n');
  expect((await readUserGitStatus(f.root)).entries).toEqual([]);

  symlinkSync('a.txt', join(first, 'link'));
  git(first, 'add', '--', 'link');
  git(
    first,
    'update-index',
    '--add',
    '--cacheinfo',
    '160000',
    git(first, 'rev-parse', 'HEAD').toString().trim(),
    'nested',
  );
  const unsupported = await readUserGitStatus(first);
  expect(unsupported.entries).toEqual(
    expect.arrayContaining([expect.objectContaining({ path: 'nested', submodule: true })]),
  );
  const reader = vi.fn(disk(first));
  for (const [path, reason] of [
    ['link', 'symlink'],
    ['nested', 'gitlink'],
  ] as const) {
    expect(
      await readUserGitDiff(
        first,
        {
          side: 'staged',
          path,
          ...basis(unsupported),
        },
        reader,
      ),
    ).toMatchObject({ kind: 'unsupported', reason });
  }
  expect(reader).not.toHaveBeenCalled();
});

it('[TC-WBD-008-N] marks a bounded file list and refuses lossy path decoding', async () => {
  const f = setup();
  for (let i = 0; i < 2001; i += 1)
    writeFileSync(join(f.root, `file-${String(i).padStart(4, '0')}.txt`), 'untracked\n');
  const status = await readUserGitStatus(f.root);
  expect(status.truncated).toBe(true);
  expect(status.entries).toHaveLength(2000);
  expect(new Set(status.entries.map((entry) => entry.path)).size).toBe(2000);
  expect(status.entries.every((entry) => entry.kind === 'untracked')).toBe(true);

  if (process.platform === 'linux') {
    const rawPath = Buffer.concat([Buffer.from(`${f.root}/`), Buffer.from([0xff])]);
    writeFileSync(rawPath, 'invalid UTF-8 filename\n');
    await expect(readUserGitStatus(f.root)).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
  }
});
