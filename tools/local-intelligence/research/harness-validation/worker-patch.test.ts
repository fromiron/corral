import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { workerPatch } from './worker-patch.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository() {
  const root = mkdtempSync(join(tmpdir(), 'worker-patch-'));
  roots.push(root);
  const main = join(root, 'repository');
  mkdirSync(main);
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-C', main, ...args],
      { encoding: 'utf8' },
    ).trim();
  git('init', '-q');
  writeFileSync(join(main, 'kept.txt'), 'one\n');
  writeFileSync(join(main, 'gone.txt'), 'gone\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  const copy = join(root, 'copy');
  git('worktree', 'add', '-q', '--detach', copy, 'HEAD');
  return { main, copy, base: git('rev-parse', 'HEAD') };
}

test('a patch holds edits, new files and deletions', () => {
  const { main, copy, base } = repository();
  writeFileSync(join(copy, 'kept.txt'), 'two\n');
  writeFileSync(join(copy, 'new.txt'), 'new\n');
  rmSync(join(copy, 'gone.txt'));
  const patch = workerPatch(main, base);
  assert.match(patch, /\+two/);
  assert.match(patch, /new file mode[\s\S]*\+new/);
  assert.match(patch, /deleted file mode/);
});

test('the sandbox command files never enter the patch', () => {
  const { main, copy, base } = repository();
  mkdirSync(join(copy, '.harness/commands'), { recursive: true });
  writeFileSync(join(copy, '.harness/commands/001.sh'), 'grep -r secret .\n');
  assert.equal(workerPatch(main, base), '');
});

test('a run that only read the code has an empty patch', () => {
  const { main, base } = repository();
  assert.equal(workerPatch(main, base), '');
});

test('the main checkout is not the copy', () => {
  const { main, copy, base } = repository();
  writeFileSync(join(main, 'kept.txt'), 'never\n');
  writeFileSync(join(copy, 'kept.txt'), 'graded\n');
  const patch = workerPatch(main, base);
  assert.match(patch, /\+graded/);
  assert.doesNotMatch(patch, /\+never/);
  assert.equal(readFileSync(join(main, 'kept.txt'), 'utf8'), 'never\n');
});

test('a missing copy is an error, not an empty patch', () => {
  const { main, copy, base } = repository();
  execFileSync('git', ['-C', main, 'worktree', 'remove', '--force', copy]);
  assert.throws(() => workerPatch(main, base), /managed copy/);
});
