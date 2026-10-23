import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, readlink, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type {
  GitConflict,
  GitConflictRequest,
  GitFileSide,
  GitSequenceCommand,
  GitSequenceState,
  Scheduler,
} from '@corral/contracts';
import { ToolRefusal } from '@corral/core';
import { checkGitEnvironment, GitError, git, gitText } from './git.ts';
import { readGitBlob, readUserGitStatus } from './user-git.ts';
import {
  type GitPlanProcessOptions,
  type GitWritePlan,
  planGitCommit,
  startGitPlan,
} from './user-git-write.ts';

export type SequenceState = Omit<GitSequenceState, 'target' | 'ownerOperationId'>;
const env = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_LAZY_FETCH: '1', GIT_LITERAL_PATHSPECS: '1' };
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const changed = () =>
  new ToolRefusal('REVISION_CONFLICT', 'Git sequence or working files changed; review them again');
const refused = (message: string) => new ToolRefusal('CAPABILITY_DENIED', message);
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

async function gitPath(root: string, name: string) {
  const path = await gitText(root, ['rev-parse', '--git-path', name], env);
  return isAbsolute(path) ? path : resolve(root, path);
}

async function fileBytes(path: string, max: number): Promise<Buffer | null> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (missing(error)) return null;
    throw refused('Git state contains an unreadable or symbolic file');
  }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > max)
      throw refused('Git state exceeds the supported file size');
    const buffer = Buffer.alloc(Math.min(max + 1, before.size + 1));
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (!chunk.bytesRead) break;
      bytesRead += chunk.bytesRead;
    }
    const after = await handle.stat();
    if (
      bytesRead !== before.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw changed();
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Full contents, not mtimes, bind resume to the files Git itself will consume. */
async function stateFiles(root: string) {
  const files = new Map<string, Buffer>();
  let total = 0;
  for (const name of [
    'MERGE_HEAD',
    'MERGE_MSG',
    'MERGE_MODE',
    'MERGE_AUTOSTASH',
    'ORIG_HEAD',
    'REBASE_HEAD',
    'CHERRY_PICK_HEAD',
    'REVERT_HEAD',
  ]) {
    const bytes = await fileBytes(await gitPath(root, name), 1024 * 1024);
    if (bytes) files.set(name, bytes);
  }
  for (const name of ['rebase-merge', 'rebase-apply', 'sequencer']) {
    const path = await gitPath(root, name);
    let names: string[];
    try {
      if (!(await lstat(path)).isDirectory())
        throw refused('Git sequence directory is not a plain directory');
      names = await readdir(path);
    } catch (error) {
      if (missing(error)) continue;
      throw error;
    }
    if (names.length > 100) throw refused('Git sequence has too many state files');
    files.set(name, Buffer.alloc(0));
    for (const file of names.sort()) {
      const bytes = await fileBytes(join(path, file), 8 * 1024 * 1024);
      if (bytes === null) throw changed();
      total += bytes.length;
      if (total > 32 * 1024 * 1024) throw refused('Git sequence exceeds the supported state size');
      files.set(`${name}/${file}`, bytes);
    }
  }
  const branch = files.get('rebase-merge/head-name')?.toString('utf8').trim();
  if (branch?.startsWith('refs/heads/')) {
    let oid = '';
    try {
      oid = await gitText(
        root,
        ['rev-parse', '--verify', '--quiet', '--end-of-options', branch],
        env,
      );
    } catch (error) {
      if (!(error instanceof GitError) || error.code !== 1) throw error;
    }
    files.set('@original-branch-ref', Buffer.from(oid));
  }
  return files;
}

/** Ignored files are absent from status but Git may overwrite them during a checkout. */
async function guardIgnored(root: string, tree: string, commits: string[] = []) {
  const ignored = (
    await git(
      root,
      ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'],
      { env, maxBuffer: 2 * 1024 * 1024 },
    )
  ).stdout
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((path) => path.replace(/\/$/, ''));
  if (!ignored.length) return;
  if (![tree, ...commits].every((oid) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid)))
    throw refused('Git sequence contains an unsupported commit');
  const paths = (
    await git(root, ['ls-tree', '-r', '-z', '--name-only', tree], {
      env,
      maxBuffer: 8 * 1024 * 1024,
    })
  ).stdout
    .toString('utf8')
    .split('\0');
  if (commits.length)
    paths.push(
      ...(
        await git(
          root,
          [
            'diff-tree',
            '--stdin',
            '--root',
            '--no-commit-id',
            '--name-only',
            '--diff-filter=ACMR',
            '-r',
            '-z',
          ],
          { env, input: Buffer.from(`${commits.join('\n')}\n`), maxBuffer: 8 * 1024 * 1024 },
        )
      ).stdout
        .toString('utf8')
        .split('\0'),
    );
  const parents = (path: string) =>
    path.split('/').map((_, i, parts) => parts.slice(0, i + 1).join('/'));
  const ignoredSet = new Set(ignored);
  const ignoredParents = new Set(ignored.flatMap(parents));
  if (
    paths.some(
      (path) =>
        path && (ignoredParents.has(path) || parents(path).some((part) => ignoredSet.has(part))),
    )
  )
    throw refused('Ignored personal files obstruct this Git change; move them before continuing');
}

async function workingHash(root: string, paths: string[], branch: string | null) {
  const hash = createHash('sha256').update(JSON.stringify({ branch }));
  let total = 0;
  for (const path of [...paths].sort()) {
    if (
      !path ||
      path.split('/').some((part) => part === '..' || part.toLowerCase() === '.git') ||
      isAbsolute(path) ||
      path.includes('\\')
    )
      throw refused('Git returned an unsafe file path');
    hash.update(`${path}\0`);
    const absolute = resolve(root, path);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(absolute);
    } catch (error) {
      if (missing(error)) {
        hash.update('absent\0');
        continue;
      }
      throw error;
    }
    if ((await realpath(resolve(absolute, '..'))) !== resolve(absolute, '..'))
      throw refused('Git working file goes through a symbolic directory');
    if (info.isSymbolicLink()) {
      hash.update(`symlink:${await readlink(absolute)}\0`);
      continue;
    }
    if (!info.isFile()) {
      hash.update('directory\0');
      continue;
    }
    total += info.size;
    if (total > 64 * 1024 * 1024)
      throw refused('Git working changes exceed the supported 64 MiB review size');
    const bytes = await fileBytes(absolute, 64 * 1024 * 1024);
    if (bytes === null) throw changed();
    hash.update(`${info.mode}:`).update(digest(bytes)).update('\0');
  }
  return hash.digest('hex');
}

function sequence(
  files: Map<string, Buffer>,
  head: string | null,
  indexHash: string,
  branch: string | null,
): SequenceState['sequence'] {
  const text = (name: string) => files.get(name)?.toString('utf8').trim() || null;
  const rebase = files.has('rebase-merge');
  const merge = files.has('MERGE_HEAD');
  const external = ['rebase-apply', 'sequencer', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'].some((name) =>
    files.has(name),
  );
  if (!rebase && !merge && !external) return null;
  let reason: string | null =
    external || (rebase && merge) ? 'Unsupported external Git sequence' : null;
  if (
    files.has('MERGE_AUTOSTASH') ||
    files.has('rebase-merge/autostash') ||
    files.has('rebase-merge/update-refs')
  )
    reason = 'Autostash and update-refs sequences are unsupported';
  if (rebase) {
    if (
      !text('@original-branch-ref') ||
      text('@original-branch-ref') !== text('rebase-merge/orig-head')
    )
      reason = 'The original rebase branch moved; restore it or finish outside Corral';
    // Modern Git writes an "interactive" marker even for --merge; only pick-only work is accepted.
    for (const name of ['git-rebase-todo', 'done'])
      if (
        (text(`rebase-merge/${name}`) ?? '')
          .split('\n')
          .some(
            (line) =>
              line.trim() &&
              !line.trim().startsWith('#') &&
              !/^pick (?:[a-f0-9]{40}|[a-f0-9]{64})(?:\s|$)/.test(line.trim()),
          )
      )
        reason = 'Interactive or executable rebase todo is unsupported';
    if (
      [
        'exec',
        'amend',
        'message-squash',
        'message-fixup',
        'squash-onto',
        'strategy',
        'strategy_opts',
      ].some((name) => files.has(`rebase-merge/${name}`))
    )
      reason = 'Interactive or custom-strategy rebase state is unsupported';
  }
  const hash = createHash('sha256').update(JSON.stringify({ head, indexHash, branch }));
  for (const [name, bytes] of [...files].sort(([a], [b]) => a.localeCompare(b)))
    hash.update(`${name}\0${bytes.length}\0`).update(bytes);
  return {
    kind: external ? 'unsupported' : rebase ? 'rebase' : 'merge',
    identity: hash.digest('hex'),
    originalHead: text(rebase ? 'rebase-merge/orig-head' : 'ORIG_HEAD'),
    onto: text(rebase ? 'rebase-merge/onto' : 'MERGE_HEAD'),
    headName: rebase ? text('rebase-merge/head-name') : branch ? `refs/heads/${branch}` : null,
    reason,
  };
}

export async function readGitSequence(root: string): Promise<SequenceState> {
  const status = await readUserGitStatus(root);
  if (status.truncated) throw refused('Git changes exceed the supported review size');
  const files = await stateFiles(root);
  const workingTreeHash = await workingHash(
    root,
    status.entries.map((entry) => entry.path),
    status.head.branch,
  );
  const after = await readUserGitStatus(root);
  const value = sequence(files, status.head.oid, status.indexHash, status.head.branch);
  if (
    status.head.oid !== after.head.oid ||
    status.head.branch !== after.head.branch ||
    status.indexHash !== after.indexHash ||
    JSON.stringify(status.entries) !== JSON.stringify(after.entries) ||
    value?.identity !==
      sequence(await stateFiles(root), after.head.oid, after.indexHash, after.head.branch)?.identity
  )
    throw changed();
  const localBranches = (
    await gitText(
      root,
      ['for-each-ref', '--count=200', '--format=%(refname)%09%(objectname)', 'refs/heads'],
      env,
    )
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [ref, oid] = line.split('\t');
      if (!ref?.startsWith('refs/heads/') || !oid || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid))
        throw refused('Git returned an invalid local branch');
      return { name: ref.slice('refs/heads/'.length), oid };
    });
  return {
    head: status.head.oid,
    indexHash: status.indexHash,
    workingTreeHash,
    sequence: value,
    localBranches,
    conflicts: status.entries
      .filter((entry) => entry.kind === 'unmerged')
      .map((entry) => entry.path),
  };
}

function matches(
  state: SequenceState,
  input: { head: string | null; indexHash: string; sequenceIdentity: string | null },
) {
  if (
    state.head !== input.head ||
    state.indexHash !== input.indexHash ||
    (state.sequence?.identity ?? null) !== input.sequenceIdentity
  )
    throw changed();
}

export async function readGitConflict(
  root: string,
  input: Omit<GitConflictRequest, 'target'>,
  readCurrent: (path: string) => Promise<GitFileSide>,
): Promise<Omit<GitConflict, 'target'>> {
  const state = await readGitSequence(root);
  matches(state, input);
  if (!state.conflicts.includes(input.path)) throw changed();
  const environment = { ...(await checkGitEnvironment(root)), ...env };
  const { stdout } = await git(root, ['ls-files', '--unmerged', '-z', '--', input.path], {
    env: environment,
  });
  const stages = new Map<number, { mode: string; oid: string }>();
  for (const record of stdout.toString('utf8').split('\0').filter(Boolean)) {
    const match = /^(\d+) ([a-f0-9]{40}|[a-f0-9]{64}) ([123])\t([\s\S]*)$/.exec(record);
    if (!match?.[1] || !match[2] || match[4] !== input.path) throw changed();
    stages.set(Number(match[3]), { mode: match[1], oid: match[2] });
  }
  const unsupported = [...stages.values()].some(
    (stage) => !['100644', '100755'].includes(stage.mode),
  )
    ? 'Symbolic link and submodule conflicts cannot be edited as text'
    : null;
  const side = (stage: number): Promise<GitFileSide> =>
    unsupported
      ? Promise.resolve({ kind: 'absent' })
      : readGitBlob(root, stages.get(stage)?.oid ?? null, environment);
  const [base, ours, theirs] = await Promise.all([side(1), side(2), side(3)]);
  const current = unsupported ? ({ kind: 'absent' } as const) : await readCurrent(input.path);
  matches(await readGitSequence(root), input);
  return {
    ...input,
    base,
    ours,
    theirs,
    current,
    currentHash: current.kind === 'text' ? digest(current.text) : null,
    unsupported,
  };
}

export async function planGitSequence(
  root: string,
  command: GitSequenceCommand,
  identity: Record<string, string>,
): Promise<{ plan: GitWritePlan; before: SequenceState; branchCommit?: string }> {
  const before = await readGitSequence(root);
  matches(before, { ...command.expect, sequenceIdentity: command.sequenceIdentity });
  if (before.workingTreeHash !== command.workingTreeHash) throw changed();
  const commitPlan = () =>
    planGitCommit(
      {
        message: '',
        runHooks: command.kind === 'abort' ? false : command.runHooks,
        ...(command.kind !== 'abort' && command.author ? { author: command.author } : {}),
      },
      identity,
    );
  const config = [
    'merge.autoStash=false',
    'rebase.autoStash=false',
    'rebase.updateRefs=false',
    'rebase.autoSquash=false',
    'rebase.rebaseMerges=false',
    'rerere.enabled=false',
    'submodule.recurse=false',
  ];
  if (command.kind === 'merge' || command.kind === 'rebase') {
    if (before.sequence || before.conflicts.length)
      throw refused('Finish the existing Git sequence first');
    const status = await readUserGitStatus(root);
    if (status.entries.length || status.head.unborn || status.head.detached)
      throw refused('A clean working tree and local branch are required');
    await git(root, ['check-ref-format', '--branch', command.branch], { env });
    const branchCommit = await gitText(
      root,
      ['rev-parse', '--verify', `refs/heads/${command.branch}^{commit}`],
      env,
    );
    if (branchCommit !== command.branchCommit) throw changed();
    const commits =
      command.kind === 'rebase'
        ? (await gitText(root, ['rev-list', '--no-merges', `${branchCommit}..HEAD`], env))
            .split('\n')
            .filter(Boolean)
        : [];
    await guardIgnored(root, branchCommit, commits);
    const plan = commitPlan();
    plan.config.push(...config);
    plan.args =
      command.kind === 'merge'
        ? [
            'merge',
            '--no-ff',
            '--no-commit',
            '--no-edit',
            '--no-autostash',
            '--no-rerere-autoupdate',
            '--no-overwrite-ignore',
            ...(command.runHooks ? [] : ['--no-verify']),
            '--',
            branchCommit,
          ]
        : [
            'rebase',
            '--merge',
            '--no-autostash',
            '--no-update-refs',
            '--no-rebase-merges',
            '--no-autosquash',
            '--no-rerere-autoupdate',
            '--no-reschedule-failed-exec',
            ...(plan.signing ? ['--gpg-sign'] : ['--no-gpg-sign']),
            '--',
            branchCommit,
          ];
    return { plan, before, branchCommit };
  }
  if (!before.sequence || before.sequence.reason || before.sequence.kind === 'unsupported')
    throw refused(before.sequence?.reason ?? 'There is no supported Git sequence to resume');
  if (command.kind === 'abort') {
    if (!command.confirmed)
      throw refused('Confirm that abort may discard the reviewed resolution changes');
    if (!before.sequence.originalHead) throw refused('The original Git commit is unavailable');
    await guardIgnored(root, before.sequence.originalHead);
    return {
      before,
      plan: {
        args: [before.sequence.kind, '--abort'],
        config: [...config, `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`],
        input: Buffer.alloc(0),
        signing: false,
        hooks: false,
      },
    };
  }
  if (before.conflicts.length)
    throw refused('Resolve and stage the unmerged files before continuing');
  const plan = commitPlan();
  plan.config.push(...config);
  if (before.sequence.kind === 'merge') {
    const message = await fileBytes(await gitPath(root, 'MERGE_MSG'), 1024 * 1024);
    if (!message) throw refused('The merge message is unavailable');
    plan.input = message;
  } else {
    if (!before.sequence.originalHead) throw refused('The original Git commit is unavailable');
    const files = await stateFiles(root);
    const commits = (files.get('rebase-merge/git-rebase-todo')?.toString('utf8') ?? '')
      .split('\n')
      .flatMap((line) => /^pick ([a-f0-9]{40}|[a-f0-9]{64})(?:\s|$)/.exec(line)?.[1] ?? []);
    await guardIgnored(root, before.sequence.originalHead, commits);
    const signing = await fileBytes(await gitPath(root, 'rebase-merge/gpg_sign_opt'), 1024);
    if ((signing?.toString('utf8').trim() ?? null) !== (plan.signing ? '-S' : null))
      throw refused(
        'This rebase signing policy changed; abort and restart with the current signing policy',
      );
    plan.args = ['rebase', '--continue'];
  }
  return { plan, before };
}

export function startGitSequence(
  root: string,
  plan: GitWritePlan,
  timers: Scheduler,
  process?: GitPlanProcessOptions,
) {
  return startGitPlan(root, plan, timers, process);
}
