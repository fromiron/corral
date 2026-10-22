import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  GitDiff,
  GitDiffRequest,
  GitFileSide,
  GitHead,
  GitStatus,
  GitStatusEntry,
} from '@corral/contracts';
import { ToolRefusal } from '@corral/core';
import { checkGitEnvironment, GitError, git, gitText } from './git.ts';

type WithoutTarget<T> = T extends unknown ? Omit<T, 'target'> : never;
type Environment = Record<string, string>;
const MAX_TEXT = 1024 * 1024;
const MAX_ENTRIES = 2000;
const statusArgs = [
  'status',
  '--porcelain=v2',
  '-z',
  '--branch',
  '--untracked-files=all',
  '--renames',
  '--ignore-submodules=dirty',
];

interface Entry {
  value: GitStatusEntry;
  modes: string[];
  headOid: string | null;
  indexOid: string | null;
}

const oid = (value: string) => (/^0+$/.test(value) ? null : value);
const conflict = () =>
  new ToolRefusal('REVISION_CONFLICT', 'Git HEAD or index changed; refresh the Git view');

/** Fixed porcelain fields precede a verbatim path, which can contain spaces and newlines. */
function fields(record: string, count: number) {
  const values: string[] = [];
  let start = 0;
  for (let index = 0; index < count; index += 1) {
    const end = record.indexOf(' ', start);
    if (end < 0) throw new ToolRefusal('SCHEMA_INVALID', 'Git returned an invalid status record');
    values.push(record.slice(start, end));
    start = end + 1;
  }
  values.push(record.slice(start));
  return values;
}

function parseStatus(bytes: Buffer) {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ToolRefusal('CAPABILITY_DENIED', 'Git paths must use UTF-8 to be displayed');
  }
  const records = text.split('\0');
  const head: GitHead = {
    oid: null,
    branch: null,
    detached: false,
    unborn: false,
    shallow: false,
    upstream: null,
  };
  let ahead: number | null = null,
    behind: number | null = null;
  const entries: Entry[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    if (record.startsWith('# branch.oid ')) {
      const value = record.slice('# branch.oid '.length);
      head.unborn = value === '(initial)';
      head.oid = head.unborn ? null : value;
    } else if (record.startsWith('# branch.head ')) {
      const value = record.slice('# branch.head '.length);
      head.detached = value === '(detached)';
      head.branch = head.detached ? null : value;
    } else if (record.startsWith('# branch.upstream ')) {
      head.upstream = {
        name: record.slice('# branch.upstream '.length),
        ahead: null,
        behind: null,
      };
    } else if (record.startsWith('# branch.ab ')) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(record);
      if (match) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
    } else if (record.startsWith('# ')) {
      // Porcelain v2 permits new headers without changing the record format.
    } else if (record.startsWith('? ')) {
      entries.push({
        value: {
          kind: 'untracked',
          path: record.slice(2),
          indexStatus: '.',
          worktreeStatus: '?',
          submodule: false,
        },
        modes: [],
        headOid: null,
        indexOid: null,
      });
    } else if (record.startsWith('1 ') || record.startsWith('2 ') || record.startsWith('u ')) {
      const kind = record[0] === '1' ? 'ordinary' : record[0] === '2' ? 'renamed' : 'unmerged';
      const count = kind === 'ordinary' ? 8 : kind === 'renamed' ? 9 : 10;
      const parts = fields(record, count);
      const originalPath = kind === 'renamed' ? records[++index] : undefined;
      if (kind === 'renamed' && !originalPath)
        throw new ToolRefusal('SCHEMA_INVALID', 'Git returned an incomplete rename');
      const xy = parts[1] ?? '';
      const modes = parts.slice(3, kind === 'unmerged' ? 7 : 6);
      entries.push({
        value: {
          kind,
          path: parts[count] ?? '',
          ...(originalPath ? { originalPath } : {}),
          indexStatus: xy[0] ?? '.',
          worktreeStatus: xy[1] ?? '.',
          submodule: parts[2]?.startsWith('S') ?? false,
        },
        modes,
        headOid: kind === 'unmerged' ? null : oid(parts[6] ?? ''),
        indexOid: kind === 'unmerged' ? null : oid(parts[7] ?? ''),
      });
    } else {
      throw new ToolRefusal('SCHEMA_INVALID', 'Git returned an unsupported status record');
    }
  }
  if (head.upstream) {
    head.upstream.ahead = ahead;
    head.upstream.behind = behind;
  }
  return { head, entries };
}

async function environment(root: string): Promise<Environment> {
  return { ...(await checkGitEnvironment(root)), GIT_NO_LAZY_FETCH: '1' };
}

async function indexHash(root: string, env: Environment) {
  // Semantic entries exclude refresh timestamps and extensions from Git's binary index.
  const { stdout } = await git(root, ['ls-files', '--stage', '-z'], { env });
  return createHash('sha256').update(stdout).digest('hex');
}

async function headOid(root: string, env: Environment) {
  try {
    return await gitText(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], env);
  } catch (error) {
    if (error instanceof GitError && error.code === 1) return null;
    throw error;
  }
}

async function status(root: string, env: Environment) {
  return parseStatus((await git(root, statusArgs, { env })).stdout);
}

const filtersDisabled = (env: Environment) => Number(env.GIT_CONFIG_COUNT) > 0;

export async function readUserGitStatus(root: string): Promise<Omit<GitStatus, 'target'>> {
  const env = await environment(root);
  const hash = await indexHash(root, env);
  const [observed, shallow] = await Promise.all([
    status(root, env),
    gitText(root, ['rev-parse', '--is-shallow-repository'], env),
  ]);
  const [branches, remotes] = await Promise.all([
    gitText(root, ['for-each-ref', '--count=200', '--format=%(refname:short)', 'refs/heads'], env),
    gitText(root, ['remote'], env),
  ]);
  const [lastHead, lastIndex] = await Promise.all([headOid(root, env), indexHash(root, env)]);
  if (lastHead !== observed.head.oid || lastIndex !== hash) throw conflict();
  const lines = (text: string) => text.split('\n').filter(Boolean);
  return {
    head: { ...observed.head, shallow: shallow === 'true' },
    indexHash: hash,
    entries: observed.entries.slice(0, MAX_ENTRIES).map((entry) => entry.value),
    truncated: observed.entries.length > MAX_ENTRIES,
    filtersDisabled: filtersDisabled(env),
    branches: lines(branches),
    remotes: lines(remotes),
  };
}

async function blob(root: string, object: string | null, env: Environment): Promise<GitFileSide> {
  if (!object) return { kind: 'absent' };
  const bytes = Number(await gitText(root, ['cat-file', '-s', object], env));
  if (bytes > MAX_TEXT) return { kind: 'too_large', bytes };
  const { stdout } = await git(root, ['cat-file', 'blob', object], {
    env,
    maxBuffer: MAX_TEXT + 1,
  });
  if (stdout.includes(0)) return { kind: 'binary', bytes: stdout.length };
  try {
    return {
      kind: 'text',
      text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(stdout),
    };
  } catch {
    return { kind: 'binary', bytes: stdout.length };
  }
}

export async function readUserGitDiff(
  root: string,
  request: Omit<GitDiffRequest, 'target'>,
  readWorktreeFile: (path: string) => Promise<GitFileSide>,
): Promise<WithoutTarget<GitDiff>> {
  const env = await environment(root);
  const firstIndex = await indexHash(root, env);
  const observed = await status(root, env);
  if (request.indexHash !== firstIndex || request.head !== observed.head.oid) throw conflict();
  const entry = observed.entries.find(({ value }) => value.path === request.path);
  if (
    !entry ||
    (request.side === 'untracked'
      ? entry.value.kind !== 'untracked'
      : entry.value.kind === 'untracked' ||
        (request.side === 'staged' ? entry.value.indexStatus : entry.value.worktreeStatus) === '.')
  ) {
    throw new ToolRefusal('REVISION_CONFLICT', 'The selected Git change is no longer available');
  }
  const common = {
    ...request,
    ...(entry.value.originalPath ? { originalPath: entry.value.originalPath } : {}),
    filtersDisabled: filtersDisabled(env),
  };
  let reason: 'unmerged' | 'symlink' | 'gitlink' | undefined;
  if (entry.value.kind === 'unmerged') reason = 'unmerged';
  else if (entry.modes.includes('160000')) reason = 'gitlink';
  else if (entry.modes.includes('120000')) reason = 'symlink';
  else if (request.side === 'untracked' && (await lstat(join(root, request.path))).isSymbolicLink())
    reason = 'symlink';
  let result: WithoutTarget<GitDiff>;
  if (reason) result = { ...common, kind: 'unsupported', reason };
  else {
    const before = await blob(
      root,
      request.side === 'staged' ? entry.headOid : entry.indexOid,
      env,
    );
    const after =
      request.side === 'staged'
        ? await blob(root, entry.indexOid, env)
        : await readWorktreeFile(request.path);
    result = { ...common, kind: 'diff', before, after };
  }
  const [lastHead, lastIndex] = await Promise.all([headOid(root, env), indexHash(root, env)]);
  if (lastHead !== request.head || lastIndex !== request.indexHash) throw conflict();
  return result;
}
