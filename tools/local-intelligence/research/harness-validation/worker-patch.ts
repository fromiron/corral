import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

/** The worker's changes as one diff, without the command files the sandbox read. */
export function workerPatch(repository: string, baseCommit: string) {
  const list = execFileSync('git', ['-C', repository, 'worktree', 'list', '--porcelain'], {
    encoding: 'utf8',
  });
  const copy = [...list.matchAll(/^worktree (.+)$/gm)]
    .map((match) => match[1] as string)
    .find((path) => resolve(path) !== resolve(repository));
  assert(copy, 'the managed copy is gone');
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', copy, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  git('add', '-A', '--', '.', ':(exclude).harness');
  return git('diff', '--cached', '--binary', baseCommit);
}
