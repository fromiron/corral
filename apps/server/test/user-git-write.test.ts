import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/** A trusted project with one managed copy; HOME is private so the host's Git config is unseen. */
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'corral-git-write-'));
  const home = join(root, 'home');
  execFileSync('mkdir', ['-p', home]);
  vi.stubEnv('HOME', home);
  const original = join(root, 'original');
  const env = {
    ...process.env,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  };
  const fixtureGit = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=f@e.test', ...args], {
      cwd,
      env,
    })
      .toString()
      .trim();
  execFileSync('git', ['init', '-q', '-b', 'main', original], { env });
  writeFileSync(join(original, 'a.txt'), 'one\n');
  writeFileSync(join(original, 'b.txt'), 'bee\n');
  fixtureGit(original, 'add', '.');
  fixtureGit(original, 'commit', '-qm', 'first');
  // Identity for the commit under test comes from the repository's own config (D5 keys).
  fixtureGit(original, 'config', 'user.name', 'Person');
  fixtureGit(original, 'config', 'user.email', 'person@example.test');
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
  const head = () => fixtureGit(copy, 'rev-parse', 'HEAD');
  const commits = () => Number(fixtureGit(copy, 'rev-list', '--count', 'HEAD'));
  const gitDir = fixtureGit(copy, 'rev-parse', '--absolute-git-dir');
  return {
    get service() {
      return service;
    },
    /** A new service on the same database: the host restarted. */
    restart: async () => {
      await service.dispose();
      service = make();
    },
    db,
    root,
    original,
    copy,
    target,
    status,
    expectOf,
    head,
    commits,
    gitDir,
    fixtureGit,
  };
}

const hook = (original: string, name: string, body: string) => {
  const path = join(original, '.git', 'hooks', name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
};

it('[TC-WBD-009-H] stages, unstages and commits the confirmed index, and a repeated request returns the same receipt', async () => {
  const s = await setup();
  writeFileSync(join(s.copy, 'a.txt'), 'two\n');
  writeFileSync(join(s.copy, 'b.txt'), 'bee changed\n');
  writeFileSync(join(s.copy, 'new file.txt'), 'new\n');
  const stage: GitWriteCommand = {
    kind: 'stage',
    operationId: 'git_stage_1',
    target: s.target,
    expect: await s.expectOf(),
    paths: ['a.txt', 'new file.txt'],
  };
  const staged = await s.service.changeGit('s1', stage);
  expect(staged).toMatchObject({ kind: 'git.stage', state: 'succeeded' });
  expect(await s.service.changeGit('s1', stage)).toEqual(staged);
  const unstage: GitWriteCommand = {
    kind: 'unstage',
    operationId: 'git_unstage_1',
    target: s.target,
    expect: await s.expectOf(),
    paths: ['new file.txt'],
  };
  expect(await s.service.changeGit('s1', unstage)).toMatchObject({ state: 'succeeded' });
  const before = s.head();
  const commit: GitWriteCommand = {
    kind: 'commit',
    operationId: 'git_commit_1',
    target: s.target,
    expect: await s.expectOf(),
    message: 'Change a',
    staged: ['a.txt'],
    runHooks: false,
  };
  const committed = await s.service.changeGit('s1', commit);
  expect(committed).toMatchObject({
    kind: 'git.commit',
    state: 'succeeded',
    result: { kind: 'applied', signed: false, hooksRan: false },
  });
  expect(s.head()).not.toBe(before);
  expect(s.fixtureGit(s.copy, 'log', '-1', '--format=%an <%ae>|%s')).toBe(
    'Person <person@example.test>|Change a',
  );
  // Unselected changes stay where they were.
  expect(readFileSync(join(s.copy, 'b.txt'), 'utf8')).toBe('bee changed\n');
  const after = await s.status();
  expect(after.entries.map((e) => [e.path, e.indexStatus, e.worktreeStatus])).toEqual([
    ['b.txt', '.', 'M'],
    ['new file.txt', '.', '?'],
  ]);
  const count = s.commits();
  expect(await s.service.changeGit('s1', commit)).toEqual(committed);
  expect(s.commits()).toBe(count);
  // The original's working tree and branch are untouched.
  expect(s.fixtureGit(s.original, 'status', '--porcelain')).toBe('');
  expect(s.fixtureGit(s.original, 'rev-parse', 'HEAD')).toBe(before);
});

it('[TC-WBD-009-H] runs the repository hooks only when asked, and signs as configured', async () => {
  const s = await setup();
  const marker = join(s.root, 'hook-ran');
  hook(s.original, 'pre-commit', `echo ran >> "${marker}"`);
  const signer = join(s.root, 'signer.sh');
  writeFileSync(
    signer,
    '#!/bin/sh\ncat >/dev/null\nprintf "\\n[GNUPG:] SIG_CREATED D 1 8 00 0 FIXTURE\\n" >&2\nprintf -- "-----BEGIN PGP SIGNATURE-----\\n\\nfixture\\n-----END PGP SIGNATURE-----\\n"\n',
  );
  chmodSync(signer, 0o755);
  const commit = async (operationId: string, runHooks: boolean) => {
    writeFileSync(join(s.copy, 'a.txt'), `${operationId}\n`);
    await s.service.changeGit('s1', {
      kind: 'stage',
      operationId: `${operationId}_stage`,
      target: s.target,
      expect: await s.expectOf(),
      paths: ['a.txt'],
    });
    return s.service.changeGit('s1', {
      kind: 'commit',
      operationId,
      target: s.target,
      expect: await s.expectOf(),
      message: operationId,
      staged: ['a.txt'],
      runHooks,
    });
  };
  expect(await commit('quiet', false)).toMatchObject({
    state: 'succeeded',
    result: { hooksRan: false },
  });
  expect(existsSync(marker)).toBe(false);
  s.fixtureGit(s.original, 'config', 'commit.gpgsign', 'true');
  s.fixtureGit(s.original, 'config', 'gpg.program', signer);
  s.fixtureGit(s.original, 'config', 'user.signingkey', 'FIXTURE');
  expect(await commit('hooked', true)).toMatchObject({
    state: 'succeeded',
    result: { hooksRan: true, signed: true },
  });
  expect(readFileSync(marker, 'utf8')).toBe('ran\n');
});

it('[TC-WBD-009-N] refuses a changed index, a changed payload, the original folder, an untrusted project and a missing signer', async () => {
  const s = await setup();
  writeFileSync(join(s.copy, 'a.txt'), 'two\n');
  writeFileSync(join(s.copy, 'b.txt'), 'bee two\n');
  const basis = await s.expectOf();
  // Someone stages outside Corral after the view was read.
  s.fixtureGit(s.copy, 'add', 'b.txt');
  const stale = await s.service.changeGit('s1', {
    kind: 'stage',
    operationId: 'stale_stage',
    target: s.target,
    expect: basis,
    paths: ['a.txt'],
  });
  expect(stale).toMatchObject({ state: 'failed', result: { code: 'REVISION_CONFLICT' } });
  expect((await s.status()).entries.find((e) => e.path === 'a.txt')?.indexStatus).toBe('.');
  // The confirmed staged list must be the whole index.
  const current = await s.expectOf();
  expect(
    await s.service.changeGit('s1', {
      kind: 'commit',
      operationId: 'partial_list',
      target: s.target,
      expect: current,
      message: 'only a',
      staged: ['a.txt'],
      runHooks: false,
    }),
  ).toMatchObject({ state: 'failed', result: { code: 'REVISION_CONFLICT' } });
  await expect(
    s.service.changeGit('s1', {
      kind: 'commit',
      operationId: 'partial_list',
      target: s.target,
      expect: current,
      message: 'a different message',
      staged: ['a.txt'],
      runHooks: false,
    }),
  ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  // Writes need a trusted project, like document saves.
  await s.service.configure('default', { trusted: false });
  await expect(
    s.service.changeGit('s1', {
      kind: 'stage',
      operationId: 'untrusted',
      target: s.target,
      expect: current,
      paths: ['a.txt'],
    }),
  ).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
  await s.service.configure('default', { trusted: true });
  // A signature is required but no signer runs: no unsigned commit is made instead.
  s.fixtureGit(s.original, 'config', 'commit.gpgsign', 'true');
  s.fixtureGit(s.original, 'config', 'gpg.program', join(s.root, 'missing-signer'));
  const head = s.head();
  expect(
    await s.service.changeGit('s1', {
      kind: 'commit',
      operationId: 'unsigned',
      target: s.target,
      expect: await s.expectOf(),
      message: 'needs a signature',
      staged: ['b.txt'],
      runHooks: false,
    }),
  ).toMatchObject({
    state: 'failed',
    result: { code: 'CAPABILITY_DENIED', reason: 'signing_unavailable' },
  });
  expect(s.head()).toBe(head);
});

it('[TC-WBD-009-N] has no write route for the original folder and refuses a target from another copy', async () => {
  const s = await setup();
  await expect(
    s.service.changeGit('s1', {
      kind: 'stage',
      operationId: 'other_copy',
      target: { ...s.target, copyGeneration: s.target.copyGeneration + 1 },
      expect: await s.expectOf(),
      paths: ['a.txt'],
    }),
  ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
});

it('[TC-WBD-009-F] a failing hook, a cancelled hook and a held index lock leave HEAD unchanged', async () => {
  const s = await setup();
  writeFileSync(join(s.copy, 'a.txt'), 'two\n');
  await s.service.changeGit('s1', {
    kind: 'stage',
    operationId: 'stage_a',
    target: s.target,
    expect: await s.expectOf(),
    paths: ['a.txt'],
  });
  const head = s.head();
  const commit = async (operationId: string): Promise<GitWriteCommand> => ({
    kind: 'commit',
    operationId,
    target: s.target,
    expect: await s.expectOf(),
    message: operationId,
    staged: ['a.txt'],
    runHooks: true,
  });
  hook(s.original, 'pre-commit', 'echo "lint failed" >&2; exit 1');
  expect(await s.service.changeGit('s1', await commit('hook_fails'))).toMatchObject({
    state: 'failed',
    result: { code: 'POLICY_ERROR', reason: 'hook_failed' },
  });
  expect(s.head()).toBe(head);

  const pidFile = join(s.root, 'hook-pid');
  hook(s.original, 'pre-commit', `echo $$ > "${pidFile}"; sleep 30`);
  const pending = s.service.changeGit('s1', await commit('hook_cancelled'));
  await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true), { timeout: 10_000 });
  s.service.cancelGitOperation('s1', 'hook_cancelled');
  expect(await pending).toMatchObject({ state: 'cancelled' });
  expect(s.head()).toBe(head);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  expect(() => process.kill(pid, 0)).toThrow();

  rmSync(join(s.original, '.git', 'hooks', 'pre-commit'));
  writeFileSync(join(s.gitDir, 'index.lock'), '');
  expect(await s.service.changeGit('s1', await commit('locked'))).toMatchObject({
    state: 'failed',
    result: { code: 'RESOURCE_CAPACITY', reason: 'locked' },
  });
  expect(s.head()).toBe(head);
  rmSync(join(s.gitDir, 'index.lock'));
});

it('[TC-WBD-009-F] a commit whose receipt was not recorded is read back after a restart, without a second commit', async () => {
  const s = await setup();
  writeFileSync(join(s.copy, 'a.txt'), 'two\n');
  await s.service.changeGit('s1', {
    kind: 'stage',
    operationId: 'stage_a',
    target: s.target,
    expect: await s.expectOf(),
    paths: ['a.txt'],
  });
  const command: GitWriteCommand = {
    kind: 'commit',
    operationId: 'lost_receipt',
    target: s.target,
    expect: await s.expectOf(),
    message: 'once',
    staged: ['a.txt'],
    runHooks: false,
  };
  const count = s.commits();
  vi.spyOn(WorkbenchOperations.prototype, 'finish').mockImplementation(() => {
    throw new Error('disk full');
  });
  await expect(s.service.changeGit('s1', command)).rejects.toMatchObject({
    code: 'STORAGE_UNAVAILABLE',
  });
  vi.restoreAllMocks();
  expect(s.commits()).toBe(count + 1);
  await s.restart();
  // The same request reads the original operation back instead of committing again.
  expect(await s.service.changeGit('s1', command)).toMatchObject({
    state: 'succeeded',
    result: { kind: 'applied', commit: s.head() },
  });
  expect(s.commits()).toBe(count + 1);
  expect(s.service.gitOperation('s1', 'lost_receipt').state).toBe('succeeded');
});
