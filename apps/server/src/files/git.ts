import { execFile } from 'node:child_process';

// Git as a bounded child process (CR-012): argv only, never a shell string. Hooks, fsmonitor,
// pagers and external diff helpers are switched off; prompts never wait for input. Repository
// filters may still run on `add` (clean filters), which is why worktrees and checks need the
// person to trust the repository first.

const SAFE_CONFIG = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.pager=cat',
  '-c',
  'core.quotePath=false',
  '-c',
  'diff.external=',
  '-c',
  'gc.auto=0',
];

export class GitError extends Error {
  readonly code: number | null;
  constructor(message: string, code: number | null) {
    super(message);
    this.code = code;
  }
}

export interface GitResult {
  stdout: Buffer;
  stderr: string;
}

export function git(
  cwd: string,
  args: string[],
  options: { env?: Record<string, string>; maxBuffer?: number; input?: Buffer } = {},
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      [...SAFE_CONFIG, ...args],
      {
        cwd,
        encoding: 'buffer',
        maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: process.env.HOME ?? '',
          LANG: 'C.UTF-8',
          GIT_TERMINAL_PROMPT: '0',
          GIT_OPTIONAL_LOCKS: '0',
          GIT_CONFIG_NOSYSTEM: '1',
          ...options.env,
        },
        timeout: 60_000,
      },
      (error, stdout, stderr) => {
        if (error) {
          const code = typeof error.code === 'number' ? error.code : null;
          // Git's own words name the step that failed; callers decide what to show.
          reject(
            new GitError(`git ${args[0]} failed: ${stderr.toString().trim().slice(0, 300)}`, code),
          );
          return;
        }
        resolve({ stdout, stderr: stderr.toString() });
      },
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end(options.input);
  });
}

export async function gitText(cwd: string, args: string[], env?: Record<string, string>) {
  return (await git(cwd, args, env ? { env } : {})).stdout.toString('utf8').trim();
}
