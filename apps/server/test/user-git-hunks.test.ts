import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GitFileSide } from '@corral/contracts';
import { afterEach, expect, it, vi } from 'vitest';
import { readUserGitStatus } from '../src/files/user-git.ts';
import { applyGitHunks, readGitHunks } from '../src/files/user-git-hunks.ts';

vi.setConfig({ testTimeout: 30_000 });
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const path = '여러 변경.txt';
const base = `${Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n')}\n`;
const first = base.replace('line 2\n', 'first change\n');
const second = base.replace('line 27\n', 'second change\n');
const both = first.replace('line 27\n', 'second change\n');
function git(root: string, ...args: string[]) {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgsign=false',
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
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'corral-git-hunks-'));
  roots.push(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(root, path), base);
  writeFileSync(join(root, 'other.txt'), 'other\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'base');
  writeFileSync(join(root, path), both);
  return root;
}
function disk(root: string) {
  return async (file: string): Promise<GitFileSide> => {
    const bytes = readFileSync(join(root, file));
    return bytes.includes(0)
      ? { kind: 'binary', bytes: bytes.length }
      : { kind: 'text', text: bytes.toString('utf8') };
  };
}
async function request(root: string, side: 'staged' | 'unstaged' = 'unstaged') {
  const status = await readUserGitStatus(root);
  return { path, side, head: status.head.oid, indexHash: status.indexHash };
}
async function selection(root: string, side: 'staged' | 'unstaged' = 'unstaged', index = 0) {
  const input = await request(root, side);
  const view = await readGitHunks(root, input, disk(root));
  expect(view.kind).toBe('hunks');
  if (view.kind !== 'hunks') throw new Error('expected hunks');
  const hunk = view.hunks[index];
  if (!hunk) throw new Error('expected selected hunk');
  return { ...input, identity: view.identity, hunkIds: [hunk.id] };
}

it('stages and unstages selected real Git hunks without changing other entries or working bytes', async () => {
  const root = setup();
  writeFileSync(join(root, 'other.txt'), 'other staged\n');
  git(root, 'add', 'other.txt');
  let planned: string | undefined;
  const result = await applyGitHunks(root, await selection(root), disk(root), (hash) => {
    planned = hash;
  });
  expect(result.indexHash).toBe(planned);
  expect(git(root, 'show', `:${path}`).toString()).toBe(first);
  expect(git(root, 'show', ':other.txt').toString()).toBe('other staged\n');
  expect(readFileSync(join(root, path), 'utf8')).toBe(both);
  await applyGitHunks(root, await selection(root), disk(root), () => {});
  expect(git(root, 'show', `:${path}`).toString()).toBe(both);
  await applyGitHunks(root, await selection(root, 'staged'), disk(root), () => {});
  expect(git(root, 'show', `:${path}`).toString()).toBe(second);
  expect(readFileSync(join(root, path), 'utf8')).toBe(both);
  expect(existsSync(join(root, '.git/index.lock'))).toBe(false);
});

it('refuses stale index, changed working bytes and unsafe content without applying a selected hunk', async () => {
  const root = setup();
  const staleIndex = await selection(root);
  writeFileSync(join(root, 'other.txt'), 'outside stage\n');
  git(root, 'add', 'other.txt');
  const outsideIndex = readFileSync(join(root, '.git/index'));
  await expect(applyGitHunks(root, staleIndex, disk(root), () => {})).rejects.toMatchObject({
    code: 'REVISION_CONFLICT',
  });
  expect(readFileSync(join(root, '.git/index'))).toEqual(outsideIndex);
  const staleWorktree = await selection(root);
  writeFileSync(join(root, path), `${both}outside edit\n`);
  await expect(applyGitHunks(root, staleWorktree, disk(root), () => {})).rejects.toMatchObject({
    code: 'REVISION_CONFLICT',
  });
  expect(readFileSync(join(root, '.git/index'))).toEqual(outsideIndex);
  writeFileSync(join(root, path), Buffer.from([0, 1, 2]));
  expect(await readGitHunks(root, await request(root), disk(root))).toMatchObject({
    kind: 'unsupported',
    reason: 'binary',
  });
  writeFileSync(join(root, path), both);
  writeFileSync(join(root, '.gitattributes'), '*.txt filter=fixture\n');
  expect(await readGitHunks(root, await request(root), disk(root))).toMatchObject({
    kind: 'unsupported',
    reason: 'filter',
  });
});

it('preserves another index lock and revalidates external writes immediately before publishing', async () => {
  const root = setup();
  const input = await selection(root);
  const originalIndex = readFileSync(join(root, '.git/index'));
  const lock = join(root, '.git/index.lock');
  writeFileSync(lock, 'outside lock');
  await expect(applyGitHunks(root, input, disk(root), () => {})).rejects.toMatchObject({
    code: 'RESOURCE_CAPACITY',
    reason: 'locked',
  });
  expect(readFileSync(lock, 'utf8')).toBe('outside lock');
  rmSync(lock);
  await expect(
    applyGitHunks(root, input, disk(root), () => {
      writeFileSync(join(root, path), 'changed during effect preparation\n');
    }),
  ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  expect(readFileSync(join(root, '.git/index'))).toEqual(originalIndex);
  expect(existsSync(lock)).toBe(false);
  writeFileSync(join(root, path), both);
  const cancellation = new AbortController();
  await expect(
    applyGitHunks(root, input, disk(root), () => cancellation.abort(), cancellation.signal),
  ).rejects.toMatchObject({ code: 'TARGET_TERMINAL' });
  expect(readFileSync(join(root, '.git/index'))).toEqual(originalIndex);
  expect(existsSync(lock)).toBe(false);
  const lateCancellation = new AbortController();
  const realOpen = fs.open;
  const openSpy = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await realOpen(...args);
    if (args[0] === lock) {
      const close = handle.close.bind(handle);
      handle.close = async () => {
        await close();
        lateCancellation.abort();
      };
    }
    return handle;
  });
  syncBuiltinESMExports();
  await expect(
    applyGitHunks(root, input, disk(root), () => {}, lateCancellation.signal),
  ).rejects.toMatchObject({ code: 'TARGET_TERMINAL' });
  openSpy.mockRestore();
  syncBuiltinESMExports();
  expect(readFileSync(join(root, '.git/index'))).toEqual(originalIndex);
  expect(existsSync(lock)).toBe(false);
  writeFileSync(join(root, 'other.txt'), 'external index replacement\n');
  git(root, 'add', 'other.txt');
  const externalIndex = readFileSync(join(root, '.git/index'));
  writeFileSync(join(root, '.git/index'), originalIndex);
  await expect(
    applyGitHunks(root, input, disk(root), () => {
      writeFileSync(join(root, '.git/index'), externalIndex);
    }),
  ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  expect(readFileSync(join(root, '.git/index'))).toEqual(externalIndex);
  expect(existsSync(lock)).toBe(false);
});
