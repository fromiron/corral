import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GitWriteCommand, WorkspaceTarget } from '@corral/contracts';
import { openDatabase } from '@corral/storage-sqlite';
import { FakeClock } from '@corral/testkit';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkspaceService } from '../src/files/service.ts';
import { WorkbenchOperations } from '../src/files/workbench-operations.ts';

// Real Git subprocesses share CI workers; this is a runaway limit, not a latency assertion.
vi.setConfig({ testTimeout: 30_000 });

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** A trusted project cloned from a local bare remote, with one managed copy. */
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'corral-git-remote-'));
  const home = join(root, 'home');
  execFileSync('mkdir', ['-p', home]);
  vi.stubEnv('HOME', home);
  const env = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1' };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=f@e.test', ...args], {
      cwd,
      env,
    })
      .toString()
      .trim();
  const remote = join(root, 'remote.git');
  const seed = join(root, 'seed');
  git(root, 'init', '-q', '--bare', '-b', 'main', remote);
  git(root, 'init', '-q', '-b', 'main', seed);
  writeFileSync(join(seed, 'a.txt'), 'one\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-qm', 'first');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-q', 'origin', 'main');
  const original = join(root, 'original');
  git(root, 'clone', '-q', remote, original);
  git(original, 'config', 'user.name', 'Person');
  git(original, 'config', 'user.email', 'person@example.test');
  const db = openDatabase(':memory:');
  db.prepare(
    "INSERT INTO work_sessions(id,project_id,corral_id,title,objective,pinned,revision,created_at,updated_at,entries_json) VALUES('s1','default',NULL,'t','',0,1,'x','x','[]')",
  ).run();
  const make = () =>
    new WorkspaceService({
      db,
      clock: new FakeClock(),
      worktreeRoot: join(root, 'copies'),
      forbidden: [],
      hostId: 'host-test',
    });
  let service = make();
  cleanups.push(async () => {
    await service.dispose();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  await service.bind('default', original);
  await service.configure('default', { trusted: true });
  const view = await service.createWorktree('s1', 'default');
  const target: WorkspaceTarget = {
    hostId: 'host-test',
    projectId: 'default',
    bindingId: view.bindingId,
    sessionId: 's1',
    copyGeneration: view.copyGeneration,
  };
  const copy = service.copyOf('s1')?.worktree;
  if (!copy) throw new Error('fixture copy missing');
  const status = () => service.gitStatus({ kind: 'session', id: 's1' });
  const expectOf = async () => {
    const current = await status();
    return { head: current.head.oid, indexHash: current.indexHash };
  };
  let counter = 0;
  const run = async (body: Record<string, unknown>) =>
    service.changeGit('s1', {
      operationId: `op_${++counter}`,
      target,
      expect: await expectOf(),
      ...body,
    } as GitWriteCommand);
  /** A commit made in the copy itself, through the P13 path. */
  const commitFile = async (name: string, text: string) => {
    writeFileSync(join(copy, name), text);
    await run({ kind: 'stage', paths: [name] });
    return run({ kind: 'commit', message: `edit ${name}`, staged: [name], runHooks: false });
  };
  /** Someone else pushes to the remote. */
  const pushElsewhere = (name: string) => {
    const other = join(root, `other-${name}`);
    git(root, 'clone', '-q', remote, other);
    writeFileSync(join(other, name), 'elsewhere\n');
    git(other, 'add', '.');
    git(other, 'commit', '-qm', `elsewhere ${name}`);
    git(other, 'push', '-q', 'origin', 'HEAD:main');
  };
  return {
    get service() {
      return service;
    },
    restart: async () => {
      await service.dispose();
      service = make();
    },
    root,
    remote,
    original,
    copy,
    target,
    status,
    expectOf,
    run,
    commitFile,
    pushElsewhere,
    git,
  };
}

it('[TC-WBD-010-H] attaches the detached copy to a new branch, switches, fetches, fast-forwards and pushes', async () => {
  const s = await setup();
  const detached = await s.status();
  expect(detached.head.detached).toBe(true);
  expect(detached.remotes).toEqual(['origin']);
  expect(await s.run({ kind: 'branch', name: 'feature/one' })).toMatchObject({
    kind: 'git.branch',
    state: 'succeeded',
  });
  const attached = await s.status();
  expect(attached.head).toMatchObject({
    branch: 'feature/one',
    detached: false,
    oid: detached.head.oid,
  });
  expect(attached.branches).toEqual(expect.arrayContaining(['feature/one', 'main']));
  // The original keeps its own branch and index.
  expect(s.git(s.original, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');

  await s.commitFile('b.txt', 'bee\n');
  expect(
    await s.run({ kind: 'push', remote: 'origin', branch: 'feature/one', runHooks: false }),
  ).toMatchObject({ kind: 'git.push', state: 'succeeded' });
  expect(s.git(s.remote, 'rev-parse', 'refs/heads/feature/one')).toBe(
    s.git(s.copy, 'rev-parse', 'HEAD'),
  );

  s.pushElsewhere('c.txt');
  expect(await s.run({ kind: 'fetch', remote: 'origin' })).toMatchObject({ state: 'succeeded' });
  // Back to a fresh branch at origin/main, then fast-forward it.
  s.git(s.original, 'branch', 'track', 'refs/remotes/origin/main~1');
  expect(await s.run({ kind: 'switch', branch: 'track' })).toMatchObject({ state: 'succeeded' });
  expect((await s.status()).head.branch).toBe('track');
  expect(await s.run({ kind: 'pull', remote: 'origin', branch: 'main' })).toMatchObject({
    kind: 'git.pull',
    state: 'succeeded',
  });
  expect(s.git(s.copy, 'rev-parse', 'HEAD')).toBe(s.git(s.remote, 'rev-parse', 'refs/heads/main'));
});

it('[TC-WBD-010-N] refuses non-fast-forward, bad names, a branch checked out elsewhere, an unknown remote and a dirty switch', async () => {
  const s = await setup();
  expect(await s.run({ kind: 'branch', name: 'bad..name' })).toMatchObject({
    state: 'failed',
    result: { code: 'SCHEMA_INVALID' },
  });
  // main is checked out in the original.
  expect(await s.run({ kind: 'switch', branch: 'main' })).toMatchObject({
    state: 'failed',
    result: { reason: 'branch_in_use' },
  });
  await s.run({ kind: 'branch', name: 'work' });
  await s.commitFile('b.txt', 'mine\n');
  s.pushElsewhere('c.txt');
  expect(await s.run({ kind: 'fetch', remote: 'origin' })).toMatchObject({ state: 'succeeded' });
  const head = s.git(s.copy, 'rev-parse', 'HEAD');
  expect(await s.run({ kind: 'pull', remote: 'origin', branch: 'main' })).toMatchObject({
    state: 'failed',
    result: { reason: 'non_fast_forward' },
  });
  expect(s.git(s.copy, 'rev-parse', 'HEAD')).toBe(head);
  // The remote branch moved past this copy; pushing is refused, never forced.
  expect(
    await s.run({ kind: 'push', remote: 'origin', branch: 'work', runHooks: false }),
  ).toMatchObject({ state: 'succeeded' });
  const pushed = s.git(s.copy, 'rev-parse', 'HEAD');
  s.git(s.copy, 'update-ref', 'refs/heads/work', 'HEAD~1');
  s.git(s.copy, 'reset', '-q', '--hard');
  await s.commitFile('e.txt', 'diverged\n');
  expect(
    await s.run({ kind: 'push', remote: 'origin', branch: 'work', runHooks: false }),
  ).toMatchObject({ state: 'failed', result: { reason: 'non_fast_forward' } });
  expect(s.git(s.remote, 'rev-parse', 'refs/heads/work')).toBe(pushed);
  expect(await s.run({ kind: 'fetch', remote: 'nowhere' })).toMatchObject({
    state: 'failed',
    result: { reason: 'remote_unavailable' },
  });
  // A remote that refuses the push.
  const hook = join(s.remote, 'hooks', 'pre-receive');
  writeFileSync(hook, '#!/bin/sh\necho "no pushes today" >&2\nexit 1\n');
  chmodSync(hook, 0o755);
  await s.run({ kind: 'branch', name: 'fresh' });
  expect(
    await s.run({ kind: 'push', remote: 'origin', branch: 'fresh', runHooks: false }),
  ).toMatchObject({ state: 'failed' });
  // Tracked changes block a switch.
  s.git(s.original, 'branch', 'other', 'refs/remotes/origin/main');
  writeFileSync(join(s.copy, 'a.txt'), 'edited\n');
  expect(await s.run({ kind: 'switch', branch: 'other' })).toMatchObject({
    state: 'failed',
    result: { reason: 'dirty_tree' },
  });
  expect((await s.status()).head.branch).toBe('fresh');
});

it('[TC-WBD-010-F] a push whose receipt was not recorded is read back from the remote after a restart', async () => {
  const s = await setup();
  await s.run({ kind: 'branch', name: 'once' });
  await s.commitFile('b.txt', 'bee\n');
  const command: GitWriteCommand = {
    kind: 'push',
    operationId: 'lost_push',
    target: s.target,
    expect: await s.expectOf(),
    remote: 'origin',
    branch: 'once',
    runHooks: false,
  };
  vi.spyOn(WorkbenchOperations.prototype, 'finish').mockImplementation(() => {
    throw new Error('disk full');
  });
  await expect(s.service.changeGit('s1', command)).rejects.toMatchObject({
    code: 'STORAGE_UNAVAILABLE',
  });
  vi.restoreAllMocks();
  await s.restart();
  expect(await s.service.changeGit('s1', command)).toMatchObject({ state: 'succeeded' });
  expect(s.git(s.remote, 'rev-parse', 'refs/heads/once')).toBe(s.git(s.copy, 'rev-parse', 'HEAD'));
});

it('[TC-WBD-010-F] an active terminal writer blocks a switch', async () => {
  const s = await setup();
  await s.run({ kind: 'branch', name: 'busy' });
  s.git(s.original, 'branch', 'free', 'refs/remotes/origin/main');
  const ops = new WorkbenchOperations(
    // The same database the service uses.
    (s.service as unknown as { db: ConstructorParameters<typeof WorkbenchOperations>[0] }).db,
    new FakeClock(),
  );
  ops.admit(
    { operationId: 'terminal_x', target: s.target, kind: 'terminal', requestHash: 'h' },
    s.copy,
  );
  await expect(s.run({ kind: 'switch', branch: 'free' })).rejects.toMatchObject({
    code: 'RUN_ALREADY_ACTIVE',
  });
  expect((await s.status()).head.branch).toBe('busy');
});
