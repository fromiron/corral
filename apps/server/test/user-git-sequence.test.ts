import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GitSequenceCommand, Scheduler } from '@corral/contracts';
import { afterEach, expect, it, vi } from 'vitest';
import {
  planGitSequence,
  readGitConflict,
  readGitSequence,
  startGitSequence,
} from '../src/files/user-git-sequence.ts';

vi.setConfig({ testTimeout: 30_000 });
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const timers: Scheduler = {
  after(ms, fn) {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};
const identity = { 'user.name': 'Fixture', 'user.email': 'fixture@example.test' };
const target = {
  hostId: 'host',
  projectId: 'project',
  bindingId: 'binding',
  sessionId: 'session',
  copyGeneration: 1,
};
const basis = (state: Awaited<ReturnType<typeof readGitSequence>>) => ({
  operationId: 'operation',
  target,
  expect: { head: state.head, indexHash: state.indexHash },
  sequenceIdentity: state.sequence?.identity ?? null,
  workingTreeHash: state.workingTreeHash,
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'corral-git-sequence-'));
  roots.push(root);
  vi.stubEnv('HOME', root);
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        '-c',
        'core.hooksPath=/dev/null',
        ...args,
      ],
      {
        cwd: root,
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
      },
    )
      .toString()
      .trim();
  git('init', '-q', '-b', 'main');
  writeFileSync(join(root, 'a.txt'), 'base\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  git('switch', '-qc', 'topic');
  writeFileSync(join(root, 'a.txt'), 'topic\n');
  git('commit', '-qam', 'topic');
  const topic = git('rev-parse', 'HEAD');
  git('switch', '-q', 'main');
  writeFileSync(join(root, 'a.txt'), 'main\n');
  git('commit', '-qam', 'main');
  mkdirSync(join(root, 'node_modules'));
  writeFileSync(join(root, 'node_modules', 'cache'), 'unrelated ignored content\n');
  writeFileSync(join(root, '.git', 'info', 'exclude'), 'node_modules/\n');
  return { root, git, topic };
}

it('local merge exposes three sides and continues only after explicit resolution', async () => {
  const f = fixture();
  const initial = await readGitSequence(f.root);
  const plan = await planGitSequence(
    f.root,
    { kind: 'merge', branch: 'topic', branchCommit: f.topic, ...basis(initial), runHooks: false },
    identity,
  );
  expect((await startGitSequence(f.root, plan.plan, timers).done).code).toBe(1);
  const state = await readGitSequence(f.root);
  expect(state.sequence?.kind).toBe('merge');
  expect(state.conflicts).toEqual(['a.txt']);
  const conflict = await readGitConflict(
    f.root,
    {
      path: 'a.txt',
      head: state.head,
      indexHash: state.indexHash,
      sequenceIdentity: state.sequence?.identity ?? null,
    },
    async (path) => ({ kind: 'text', text: readFileSync(join(f.root, path), 'utf8') }),
  );
  expect(conflict).toMatchObject({
    base: { kind: 'text', text: 'base\n' },
    ours: { kind: 'text', text: 'main\n' },
    theirs: { kind: 'text', text: 'topic\n' },
  });
  await expect(
    planGitSequence(f.root, { kind: 'continue', ...basis(state), runHooks: false }, identity),
  ).rejects.toThrow(/unmerged|conflict/i);
  writeFileSync(join(f.root, 'a.txt'), 'resolved\n');
  f.git('add', 'a.txt');
  const resolved = await readGitSequence(f.root);
  const resume = await planGitSequence(
    f.root,
    { kind: 'continue', ...basis(resolved), runHooks: false },
    identity,
  );
  expect((await startGitSequence(f.root, resume.plan, timers).done).code).toBe(0);
  expect((await readGitSequence(f.root)).sequence).toBeNull();
  expect(f.git('show', 'HEAD:a.txt')).toBe('resolved');
  expect(f.git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ')).toHaveLength(3);
});

it('stale or unreviewed abort cannot discard changes and unsafe rebase todo cannot run', async () => {
  const f = fixture();
  const initial = await readGitSequence(f.root);
  const plan = await planGitSequence(
    f.root,
    { kind: 'rebase', branch: 'topic', branchCommit: f.topic, ...basis(initial), runHooks: false },
    identity,
  );
  expect((await startGitSequence(f.root, plan.plan, timers).done).code).toBe(1);
  const state = await readGitSequence(f.root);
  expect(state.sequence?.kind).toBe('rebase');
  expect(state.sequence?.reason).toBeNull();
  f.git('update-ref', 'refs/heads/main', f.topic);
  await expect(
    planGitSequence(f.root, { kind: 'abort', ...basis(state), confirmed: true }, identity),
  ).rejects.toThrow(/changed|moved/i);
  expect(f.git('rev-parse', 'refs/heads/main')).toBe(f.topic);
  f.git('update-ref', 'refs/heads/main', initial.head ?? '');
  writeFileSync(join(f.root, 'a.txt'), 'my resolution\n');
  await expect(
    planGitSequence(f.root, { kind: 'abort', ...basis(state), confirmed: true }, identity),
  ).rejects.toThrow(/changed/i);
  expect(readFileSync(join(f.root, 'a.txt'), 'utf8')).toBe('my resolution\n');
  const now = await readGitSequence(f.root);
  await expect(
    planGitSequence(
      f.root,
      { kind: 'abort', ...basis(now), confirmed: false } as unknown as GitSequenceCommand,
      identity,
    ),
  ).rejects.toThrow(/confirm/i);
  const todo = f.git('rev-parse', '--git-path', 'rebase-merge/git-rebase-todo');
  writeFileSync(join(f.root, todo), 'exec touch forbidden-marker\n');
  const unsafe = await readGitSequence(f.root);
  expect(unsafe.sequence?.reason).toMatch(/unsupported/i);
  await expect(
    planGitSequence(f.root, { kind: 'continue', ...basis(unsafe), runHooks: false }, identity),
  ).rejects.toThrow(/unsupported|exec|todo/i);
  writeFileSync(join(f.root, todo), '');
  const abort = await planGitSequence(
    f.root,
    { kind: 'abort', ...basis(await readGitSequence(f.root)), confirmed: true },
    identity,
  );
  expect((await startGitSequence(f.root, abort.plan, timers).done).code).toBe(0);
  expect(f.git('show', 'HEAD:a.txt')).toBe('main');
  expect((await readGitSequence(f.root)).sequence).toBeNull();
});

it('ignored personal files obstruct start and abort without being overwritten', async () => {
  const f = fixture();
  writeFileSync(join(f.root, 'personal.txt'), 'tracked original\n');
  f.git('add', 'personal.txt');
  f.git('commit', '-qm', 'original file');
  f.git('switch', '-q', 'topic');
  writeFileSync(join(f.root, '.gitignore'), 'personal.txt\n');
  f.git('add', '.gitignore');
  f.git('commit', '-qm', 'ignore file');
  const topic = f.git('rev-parse', 'HEAD');
  f.git('switch', '-q', 'main');
  const start = await planGitSequence(
    f.root,
    {
      kind: 'rebase',
      ...basis(await readGitSequence(f.root)),
      branch: 'topic',
      branchCommit: topic,
      runHooks: false,
    },
    identity,
  );
  expect((await startGitSequence(f.root, start.plan, timers).done).code).toBe(1);
  const before = await readGitSequence(f.root);
  writeFileSync(join(f.root, 'personal.txt'), 'personal ignored bytes\n');
  await expect(
    planGitSequence(f.root, { kind: 'abort', ...basis(before), confirmed: true }, identity),
  ).rejects.toThrow(/ignored|obstruct/i);
  expect(readFileSync(join(f.root, 'personal.txt'), 'utf8')).toBe('personal ignored bytes\n');
  rmSync(join(f.root, 'personal.txt'));
  const abort = await planGitSequence(
    f.root,
    { kind: 'abort', ...basis(await readGitSequence(f.root)), confirmed: true },
    identity,
  );
  expect((await startGitSequence(f.root, abort.plan, timers).done).code).toBe(0);
  f.git('switch', '-q', 'topic');
  writeFileSync(join(f.root, 'personal.txt'), 'personal ignored bytes\n');
  for (const kind of ['merge', 'rebase'] as const)
    await expect(
      planGitSequence(
        f.root,
        {
          kind,
          ...basis(await readGitSequence(f.root)),
          branch: 'main',
          branchCommit: f.git('rev-parse', 'main'),
          runHooks: false,
        },
        identity,
      ),
    ).rejects.toThrow(/ignored|obstruct/i);
  expect(readFileSync(join(f.root, 'personal.txt'), 'utf8')).toBe('personal ignored bytes\n');
});

it('rebase continuation preserves required signing and rejects a moved reviewed branch', async () => {
  const f = fixture();
  const state = await readGitSequence(f.root);
  await expect(
    planGitSequence(
      f.root,
      {
        kind: 'rebase',
        ...basis(state),
        branch: 'topic',
        branchCommit: state.head ?? '',
        runHooks: false,
      },
      identity,
    ),
  ).rejects.toThrow(/changed/i);
  const key = join(f.root, '.git', 'signer');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
  const signedIdentity = {
    ...identity,
    'commit.gpgsign': 'true',
    'gpg.format': 'ssh',
    'user.signingkey': key,
  };
  const start = await planGitSequence(
    f.root,
    { kind: 'rebase', ...basis(state), branch: 'topic', branchCommit: f.topic, runHooks: false },
    identity,
  );
  let pid = 0;
  expect(
    (
      await startGitSequence(f.root, start.plan, timers, {
        owner: 'fixture-sequence',
        onSpawn: (value) => {
          pid = value;
        },
      }).done
    ).code,
  ).toBe(1);
  expect(pid).toBeGreaterThan(0);
  writeFileSync(join(f.root, 'a.txt'), 'signed resolution\n');
  f.git('add', 'a.txt');
  await expect(
    planGitSequence(
      f.root,
      { kind: 'continue', ...basis(await readGitSequence(f.root)), runHooks: false },
      signedIdentity,
    ),
  ).rejects.toThrow(/signing policy/i);
  const abort = await planGitSequence(
    f.root,
    { kind: 'abort', ...basis(await readGitSequence(f.root)), confirmed: true },
    identity,
  );
  expect((await startGitSequence(f.root, abort.plan, timers).done).code).toBe(0);
  const signedStart = await planGitSequence(
    f.root,
    {
      kind: 'rebase',
      ...basis(await readGitSequence(f.root)),
      branch: 'topic',
      branchCommit: f.topic,
      runHooks: false,
    },
    signedIdentity,
  );
  expect((await startGitSequence(f.root, signedStart.plan, timers).done).code).toBe(1);
  writeFileSync(join(f.root, 'a.txt'), 'signed resolution\n');
  f.git('add', 'a.txt');
  const resume = await planGitSequence(
    f.root,
    { kind: 'continue', ...basis(await readGitSequence(f.root)), runHooks: false },
    signedIdentity,
  );
  const result = await startGitSequence(f.root, resume.plan, timers).done;
  expect(result).toMatchObject({ code: 0, cleaned: true });
  expect(f.git('cat-file', 'commit', 'HEAD')).toMatch(/^gpgsig /m);
  expect((await readGitSequence(f.root)).sequence).toBeNull();
});
