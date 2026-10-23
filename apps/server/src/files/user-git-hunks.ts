import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GitFileSide, GitHunks, GitHunksRequest } from '@corral/contracts';
import { ToolRefusal } from '@corral/core';
import { checkGitEnvironment, GitError, git, gitText } from './git.ts';
import { readUserGitDiff, readUserGitStatus } from './user-git.ts';
import { GitWriteError, gitDir } from './user-git-write.ts';

type Request = Omit<GitHunksRequest, 'target'>;
type View = GitHunks extends infer T ? (T extends GitHunks ? Omit<T, 'target'> : never) : never;
type ReadFile = (path: string) => Promise<GitFileSide>;
type Write = Request & { identity: string; hunkIds: string[] };
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const stale = () =>
  new ToolRefusal(
    'REVISION_CONFLICT',
    'Git HEAD, index or working file changed; review the hunks again',
  );
const textHash = (file: GitFileSide) => (file.kind === 'text' ? hash(file.text) : null);

async function indexBytes(path: string) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size > 64 * 1024 * 1024)
    throw new ToolRefusal('CAPABILITY_DENIED', 'The Git index cannot be safely copied');
  return readFile(path);
}
async function indexHash(root: string, env: Record<string, string>) {
  return hash((await git(root, ['ls-files', '--stage', '-z'], { env })).stdout);
}
async function transformations(root: string, path: string, env: Record<string, string>) {
  const attrs = (
    await git(
      root,
      ['check-attr', '-z', 'filter', 'text', 'eol', 'working-tree-encoding', 'ident', '--', path],
      { env },
    )
  ).stdout
    .toString('utf8')
    .split('\0');
  if (attrs.some((value, index) => index % 3 === 2 && value !== 'unspecified' && value !== 'unset'))
    return true;
  try {
    const autocrlf = await gitText(root, ['config', '--get', 'core.autocrlf'], env);
    return !['false', 'no', 'off', '0', ''].includes(autocrlf.toLowerCase());
  } catch (error) {
    if (error instanceof GitError && error.code === 1) return false;
    throw error;
  }
}

async function snapshot(root: string, request: Request, readWorking: ReadFile) {
  const { head, indexHash, path, side } = request;
  const input = { head, indexHash, path, side };
  const unsupported = (reason: string) => ({
    view: { ...input, kind: 'unsupported' as const, reason },
  });
  if (/[\r\n\0]/.test(input.path)) return unsupported('path');
  const env = {
    ...(await checkGitEnvironment(root)),
    GIT_NO_LAZY_FETCH: '1',
    GIT_LITERAL_PATHSPECS: '1',
  };
  const directory = await gitDir(root);
  const index = join(directory, 'index');
  const state = await readUserGitStatus(root);
  if (state.head.oid !== input.head || state.indexHash !== input.indexHash) throw stale();
  const entry = state.entries.find((entry) => entry.path === input.path);
  if (!entry) throw stale();
  if (entry.kind !== 'ordinary') return unsupported(entry.kind);
  if (entry.submodule) return unsupported('gitlink');
  if (
    !input.head ||
    [entry.indexStatus, entry.worktreeStatus].some((value) => value === 'A' || value === 'D')
  )
    return unsupported('added_deleted');
  const originalIndex = await indexBytes(index);
  const modes = await Promise.all([
    gitText(root, ['ls-tree', input.head ?? '', '--', input.path], env),
    gitText(root, ['ls-files', '--stage', '--', input.path], env),
  ]);
  if (modes.some((value) => value.startsWith('120000 '))) return unsupported('symlink');
  if (modes.some((value) => value.startsWith('160000 '))) return unsupported('gitlink');
  const mode = modes[0]?.slice(0, 6);
  if (!['100644', '100755'].includes(mode ?? '') || modes[1]?.slice(0, 6) !== mode)
    return unsupported('mode');
  let stat: Stats;
  try {
    stat = await lstat(join(root, input.path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return unsupported('added_deleted');
    throw error;
  }
  if (stat.isSymbolicLink()) return unsupported('symlink');
  if (!stat.isFile()) return unsupported('mode');
  if (process.platform !== 'win32' && (stat.mode & 0o111 ? '100755' : '100644') !== mode)
    return unsupported('mode');
  if (await transformations(root, input.path, env)) return unsupported('filter');
  const working = await readWorking(input.path);
  if (working.kind !== 'text')
    return unsupported(working.kind === 'absent' ? 'added_deleted' : working.kind);
  const diff = await readUserGitDiff(root, input, readWorking);
  if (diff.kind === 'unsupported') return unsupported(diff.reason);
  for (const side of [diff.before, diff.after])
    if (side.kind !== 'text')
      return unsupported(side.kind === 'absent' ? 'added_deleted' : side.kind);
  const patch = (
    await git(
      root,
      [
        '-c',
        'diff.suppressBlankEmpty=false',
        'diff',
        '--no-color',
        '--no-ext-diff',
        '--no-textconv',
        '--full-index',
        '--no-renames',
        '--unified=3',
        '--inter-hunk-context=0',
        '--src-prefix=a/',
        '--dst-prefix=b/',
        '--no-relative',
        '--diff-algorithm=myers',
        ...(input.side === 'staged' ? ['--cached', input.head] : []),
        '--',
        input.path,
      ],
      { env, maxBuffer: 3 * 1024 * 1024 },
    )
  ).stdout.toString('utf8');
  const chunks = patch.split(/(?=^@@ )/m);
  const header = chunks.shift() ?? '';
  if (!chunks.length || chunks.length > 200) return unsupported('no_hunks');
  const workingHash = textHash(working);
  const identity = hash(JSON.stringify({ ...input, workingHash, patch }));
  const hunks = chunks.map((patch, index) => ({
    id: hash(`${identity}:${index}:${patch}`),
    header: patch.split('\n')[0] ?? '',
    patch,
  }));
  const lastWorking = await readWorking(input.path);
  const lastStat = await lstat(join(root, input.path));
  const [lastIndex, lastHead] = await Promise.all([
    indexBytes(index),
    gitText(root, ['rev-parse', '--verify', 'HEAD'], env),
  ]);
  if (
    !originalIndex.equals(lastIndex) ||
    lastHead !== input.head ||
    textHash(lastWorking) !== workingHash ||
    stat.dev !== lastStat.dev ||
    stat.ino !== lastStat.ino ||
    stat.mode !== lastStat.mode ||
    stat.mtimeMs !== lastStat.mtimeMs
  )
    throw stale();
  return {
    view: { ...input, kind: 'hunks' as const, identity, workingHash, hunks },
    header,
    originalIndex,
    index,
    directory,
    env,
    stat,
  };
}

export async function readGitHunks(
  root: string,
  input: Request,
  readWorking: ReadFile,
): Promise<View> {
  return (await snapshot(root, input, readWorking)).view;
}

/** Publishes a private index under Git's real lock; never changes working files. */
export async function applyGitHunks(
  root: string,
  input: Write,
  readWorking: ReadFile,
  guard: (expectedIndexHash: string) => void,
  signal?: AbortSignal,
) {
  const checkCancelled = () => {
    if (signal?.aborted)
      throw new ToolRefusal('TARGET_TERMINAL', 'The selected Git change was cancelled');
  };
  checkCancelled();
  const state = await snapshot(root, input, readWorking);
  if (!('originalIndex' in state))
    throw new ToolRefusal('CAPABILITY_DENIED', 'This change requires whole-file staging');
  if (
    state.view.identity !== input.identity ||
    !input.hunkIds.length ||
    new Set(input.hunkIds).size !== input.hunkIds.length ||
    input.hunkIds.some((id) => !state.view.hunks.some((hunk) => hunk.id === id))
  )
    throw stale();
  const selected = Buffer.from(
    state.header +
      state.view.hunks
        .filter((hunk) => input.hunkIds.includes(hunk.id))
        .map((hunk) => hunk.patch)
        .join(''),
  );
  const directory = await mkdtemp(join(state.directory, 'corral-hunks-'));
  const temporaryIndex = join(directory, 'index');
  const env = { ...state.env, GIT_INDEX_FILE: temporaryIndex };
  const lockPath = `${state.index}.lock`;
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  let lockIdentity: { dev: number; ino: number } | undefined;
  try {
    await writeFile(temporaryIndex, state.originalIndex, { mode: 0o600 });
    await git(root, ['update-index', '--no-split-index'], { env, signal });
    await git(
      root,
      [
        'apply',
        '--cached',
        '--whitespace=nowarn',
        ...(input.side === 'staged' ? ['--reverse'] : []),
      ],
      { env, input: selected, signal },
    );
    const expectedIndexHash = await indexHash(root, env);
    checkCancelled();
    try {
      lock = await open(lockPath, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new GitWriteError(
          'RESOURCE_CAPACITY',
          'Another Git process holds the index lock',
          'locked',
        );
      throw error;
    }
    lockIdentity = await lock.stat();
    await lock.writeFile(await readFile(temporaryIndex));
    await lock.sync();
    guard(expectedIndexHash);
    checkCancelled();
    const current = await snapshot(root, input, readWorking);
    const lockStat = await lstat(lockPath);
    if (
      !('originalIndex' in current) ||
      current.view.identity !== input.identity ||
      !current.originalIndex.equals(state.originalIndex) ||
      current.stat.dev !== state.stat.dev ||
      current.stat.ino !== state.stat.ino ||
      current.stat.mtimeMs !== state.stat.mtimeMs ||
      lockStat.dev !== lockIdentity.dev ||
      lockStat.ino !== lockIdentity.ino
    )
      throw stale();
    checkCancelled();
    await lock.close();
    lock = undefined;
    checkCancelled();
    guard(expectedIndexHash);
    await rename(lockPath, state.index);
    lockIdentity = undefined;
    const actualIndexHash = await indexHash(root, state.env);
    const head = await gitText(root, ['rev-parse', '--verify', 'HEAD'], state.env);
    if (actualIndexHash !== expectedIndexHash || head !== input.head) throw stale();
    return { head, indexHash: actualIndexHash, expectedIndexHash };
  } finally {
    await lock?.close();
    if (lockIdentity) {
      const remaining = await lstat(lockPath).catch(() => null);
      if (remaining?.dev === lockIdentity.dev && remaining.ino === lockIdentity.ino)
        await rm(lockPath, { force: true });
    }
    await rm(directory, { recursive: true, force: true });
  }
}
