import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import {
  GIT_IDENTITY_KEYS,
  type GitAuthor,
  type GitWriteCommand,
  type GitWriteFailure,
  type Scheduler,
} from '@corral/contracts';
import { ToolRefusal } from '@corral/core';
import { spawnOwnedProcess } from '../processes/owned-process.ts';
import { GitError, git, gitText } from './git.ts';
import { killProcessGroup, processGroupGone } from './process-group.ts';

// User Git writes (CR-046 P13, D5). Separate from the snapshot helper in git.ts, which keeps
// hooks off for every internal call: here the repository's own hooks run when the person asks,
// identity and signing come only from the allowed config keys, and each Git process is an owned
// process group so cancellation and timeouts confirm cleanup.

const BASE_CONFIG = [
  'core.fsmonitor=false',
  'core.pager=cat',
  'core.quotePath=false',
  'diff.external=',
  'gc.auto=0',
];
const TIMEOUT: Record<GitWriteCommand['kind'], number> = {
  stage: 2 * 60_000,
  unstage: 2 * 60_000,
  commit: 10 * 60_000,
  branch: 60_000,
  switch: 2 * 60_000,
  fetch: 5 * 60_000,
  pull: 5 * 60_000,
  push: 10 * 60_000,
};
const REMOTE_KINDS = new Set<GitWriteCommand['kind']>(['fetch', 'pull', 'push']);
const HOOKS_OFF = `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`;

export class GitWriteError extends ToolRefusal {
  readonly reason: GitWriteFailure | undefined;
  constructor(
    code: ConstructorParameters<typeof ToolRefusal>[0],
    message: string,
    reason?: GitWriteFailure,
  ) {
    super(code, message);
    this.reason = reason;
  }
}

/** The person's identity and signing settings, read from local and global config only. */
export async function gitIdentity(root: string): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const key of GIT_IDENTITY_KEYS) {
    try {
      const value = await gitText(root, ['config', '--get', key], { GIT_NO_LAZY_FETCH: '1' });
      if (value) values[key] = value;
    } catch (error) {
      if (!(error instanceof GitError) || error.code !== 1) throw error;
    }
  }
  return values;
}

export function signingRequired(identity: Record<string, string>) {
  return /^(true|yes|on|1)$/i.test(identity['commit.gpgsign'] ?? '');
}

function environment(signing: boolean, remote = false): NodeJS.ProcessEnv {
  if (remote) {
    // Remote work in a trusted project uses the person's own Git setup: credential helpers,
    // SSH agent and global config. Prompts stay off; nothing waits for input.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: process.env.HOME ?? '',
      LANG: 'C.UTF-8',
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
      GIT_NO_LAZY_FETCH: '1',
    };
    for (const key of [
      'SSH_AUTH_SOCK',
      'USERPROFILE',
      'APPDATA',
      'LOCALAPPDATA',
      'XDG_CONFIG_HOME',
    ])
      if (process.env[key]) env[key] = process.env[key];
    return env;
  }
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? '',
    LANG: 'C.UTF-8',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    // Allowed identity keys arrive as -c flags; nothing else from the global file applies.
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_NO_LAZY_FETCH: '1',
    GIT_LITERAL_PATHSPECS: '1',
  };
  if (signing)
    for (const key of ['GNUPGHOME', 'SSH_AUTH_SOCK', 'GPG_AGENT_INFO'])
      if (process.env[key]) env[key] = process.env[key];
  return env;
}

export interface GitWriteRun {
  /** Kills the owned Git process group, hooks included. */
  cancel(): void;
  done: Promise<{ code: number | null; stderr: string; cancelled: boolean; cleaned: boolean }>;
}

function run(
  root: string,
  args: string[],
  options: { config: string[]; env: NodeJS.ProcessEnv; input?: Buffer; timeout: number },
  timers: Scheduler,
): GitWriteRun {
  const child: ChildProcess = spawnOwnedProcess(
    'git',
    [...[...BASE_CONFIG, ...options.config].flatMap((entry) => ['-c', entry]), ...args],
    { cwd: root, env: options.env, windowsHide: true },
  );
  let cancelled = false;
  let stderr = '';
  child.stdout?.resume();
  child.stderr?.on('data', (chunk: Buffer) => {
    if (stderr.length < 4000) stderr += chunk.toString();
  });
  child.stdin?.on('error', () => {});
  child.stdin?.end(options.input);
  const cancel = () => {
    cancelled = true;
    killProcessGroup(child);
  };
  const timeout = setTimeout(cancel, options.timeout);
  const done = new Promise<number | null>((resolve) => {
    child.once('error', () => resolve(null));
    child.once('close', (code) => resolve(code));
  }).then(async (code) => {
    clearTimeout(timeout);
    // Hooks may leave children behind; the receipt waits for the whole group.
    killProcessGroup(child);
    // Orphaned hook children are reaped by the host's init, which can take a few seconds.
    let cleaned = !child.pid;
    for (let attempt = 0; child.pid && !cleaned && attempt < 10; attempt += 1)
      cleaned = await processGroupGone(child.pid, timers);
    return { code, stderr: stderr.trim(), cancelled, cleaned };
  });
  return { cancel, done };
}

function failure(stderr: string, signing: boolean, hooks: boolean): GitWriteError {
  const message = stderr.slice(0, 300) || 'Git did not complete the change.';
  if (/index\.lock|Unable to create .*\.lock/i.test(stderr))
    return new GitWriteError('RESOURCE_CAPACITY', message, 'locked');
  if (signing && /sign|gpg|ssh-keygen/i.test(stderr))
    return new GitWriteError('CAPABILITY_DENIED', message, 'signing_unavailable');
  if (/already (?:checked out|used by worktree)/i.test(stderr))
    return new GitWriteError('CAPABILITY_DENIED', message, 'branch_in_use');
  if (/non-fast-forward|not possible to fast-forward|fetch first|diverg/i.test(stderr))
    return new GitWriteError('REVISION_CONFLICT', message, 'non_fast_forward');
  if (
    /does not appear to be a git repository|could not read from remote|authentication failed|permission denied|could not read username|repository not found|could not resolve host/i.test(
      stderr,
    )
  )
    return new GitWriteError('CAPABILITY_DENIED', message, 'remote_unavailable');
  if (hooks) return new GitWriteError('POLICY_ERROR', message, 'hook_failed');
  return new GitWriteError('POLICY_ERROR', message);
}

/** A Git step before the effect (e.g. write-tree) can also meet another writer's lock. */
export function lockFailure(error: unknown): GitWriteError | null {
  return error instanceof GitError && /index\.lock/i.test(error.message)
    ? new GitWriteError('RESOURCE_CAPACITY', error.message, 'locked')
    : null;
}

export interface GitWritePlan {
  args: string[];
  config: string[];
  input: Buffer;
  signing: boolean;
  hooks: boolean;
}

/** Builds the Git invocation for one command; refuses before any effect when it cannot run. */
export function planGitWrite(
  command: GitWriteCommand,
  identity: Record<string, string>,
  head: string | null,
): GitWritePlan {
  const paths = Buffer.from(
    command.kind === 'stage' || command.kind === 'unstage' ? `${command.paths.join('\0')}\0` : '',
    'utf8',
  );
  const pathspec = ['--pathspec-from-file=-', '--pathspec-file-nul'];
  const plain = (args: string[], hooks = false): GitWritePlan => ({
    args,
    config: hooks ? [] : [HOOKS_OFF],
    input: Buffer.alloc(0),
    signing: false,
    hooks,
  });
  if (command.kind === 'branch') return plain(['switch', '-c', command.name]);
  if (command.kind === 'switch') return plain(['switch', command.branch]);
  if (command.kind === 'fetch') return plain(['fetch', command.remote]);
  if (command.kind === 'pull')
    return plain(['pull', '--ff-only', '--no-rebase', command.remote, command.branch]);
  if (command.kind === 'push')
    return plain(
      ['push', command.remote, `refs/heads/${command.branch}:refs/heads/${command.branch}`],
      command.runHooks,
    );
  if (command.kind === 'stage')
    return {
      args: ['add', '-A', ...pathspec],
      config: [],
      input: paths,
      signing: false,
      hooks: false,
    };
  if (command.kind === 'unstage')
    return {
      // An unborn HEAD has nothing to restore from; removing the entries is the same result.
      args: head ? ['reset', '-q', head, ...pathspec] : ['rm', '--cached', '-q', '-r', ...pathspec],
      config: [],
      input: paths,
      signing: false,
      hooks: false,
    };
  const author: GitAuthor | undefined = command.author ?? configuredAuthor(identity);
  if (!author)
    throw new GitWriteError(
      'CAPABILITY_DENIED',
      'Git has no author name and email for this commit',
      'author_missing',
    );
  const signing = signingRequired(identity);
  const config = [
    `user.name=${author.name}`,
    `user.email=${author.email}`,
    ...GIT_IDENTITY_KEYS.filter(
      (key) => key !== 'user.name' && key !== 'user.email' && identity[key] !== undefined,
    ).map((key) => `${key}=${identity[key]}`),
  ];
  if (!command.runHooks) config.push(HOOKS_OFF);
  return {
    args: [
      'commit',
      '-q',
      '--cleanup=strip',
      '-F',
      '-',
      ...(command.runHooks ? [] : ['--no-verify']),
    ],
    config,
    input: Buffer.from(command.message, 'utf8'),
    signing,
    hooks: command.runHooks,
  };
}

function configuredAuthor(identity: Record<string, string>): GitAuthor | undefined {
  const name = identity['user.name'];
  const email = identity['user.email'];
  return name && email ? { name, email } : undefined;
}

export function startGitWrite(
  root: string,
  command: GitWriteCommand,
  plan: GitWritePlan,
  timers: Scheduler,
): GitWriteRun {
  return run(
    root,
    plan.args,
    {
      config: plan.config,
      env: environment(plan.signing, REMOTE_KINDS.has(command.kind)),
      input: plan.input,
      timeout: TIMEOUT[command.kind],
    },
    timers,
  );
}

export function gitWriteFailure(
  result: Awaited<GitWriteRun['done']>,
  plan: GitWritePlan,
): GitWriteError | null {
  if (result.cancelled)
    return new GitWriteError('TARGET_TERMINAL', 'The Git change was cancelled.');
  if (result.code === 0) return null;
  return failure(result.stderr, plan.signing, plan.hooks);
}

/** The Git directory of a linked worktree, where its own index and index.lock live. */
export async function gitDir(root: string) {
  const dir = await gitText(root, ['rev-parse', '--git-dir']);
  return isAbsolute(dir) ? dir : join(root, dir);
}

export async function indexLocked(root: string) {
  return existsSync(join(await gitDir(root), 'index.lock'));
}

/** A commit's first parent and whether it carries a signature, read back after the effect. */
/** The remote branch as the remote reports it now (null when it does not exist). */
export async function remoteBranch(root: string, remote: string, branch: string) {
  const { stdout } = await gitRemoteRead(root, [
    'ls-remote',
    '--heads',
    remote,
    `refs/heads/${branch}`,
  ]);
  return stdout.toString('utf8').split(/\s/)[0] || null;
}

/** A remote read with the same environment as fetch/pull/push. */
export function gitRemoteRead(root: string, args: string[]) {
  return git(root, args, { env: environment(false, true) as Record<string, string> });
}

export async function commitFacts(root: string, oid: string) {
  const { stdout } = await git(root, ['cat-file', 'commit', oid]);
  const text = stdout.toString('utf8');
  const header = text.slice(0, text.indexOf('\n\n'));
  const parent = /^parent ([a-f0-9]+)$/m.exec(header)?.[1] ?? null;
  const tree = /^tree ([a-f0-9]+)$/m.exec(header)?.[1] ?? null;
  return { parent, tree, signed: /^gpgsig(?:-sha256)? /m.test(header) };
}
