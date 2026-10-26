import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GitHunkWrite, GitSequenceState } from '@corral/contracts';
import { openDatabase } from '@corral/storage-sqlite';
import { FakeClock } from '@corral/testkit';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkspaceService } from '../src/files/service.ts';
import { WorkbenchOperations } from '../src/files/workbench-operations.ts';

vi.setConfig({ testTimeout: 40_000 });
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllEnvs();
});
const base = `${Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n')}\n`;
const first = base.replace('line 2\n', 'first change\n');
const both = first.replace('line 27\n', 'second change\n');
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const basis = (state: GitSequenceState, operationId: string) => ({
  operationId,
  target: state.target,
  expect: { head: state.head, indexHash: state.indexHash },
  sequenceIdentity: state.sequence?.identity ?? null,
  workingTreeHash: state.workingTreeHash,
});

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'corral-git-advanced-workspace-'));
  const home = join(root, 'home');
  mkdirSync(home);
  vi.stubEnv('HOME', home);
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
  const git = (cwd: string, ...args: string[]) =>
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
      { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] },
    ).toString();
  const original = join(root, 'original');
  git(root, 'init', '-q', '-b', 'main', original);
  writeFileSync(join(original, 'a.txt'), 'base\n');
  writeFileSync(join(original, 'hunks.txt'), base);
  git(original, 'add', '.');
  git(original, 'commit', '-qm', 'base');
  git(original, 'switch', '-qc', 'topic');
  writeFileSync(join(original, 'a.txt'), 'topic\n');
  git(original, 'commit', '-qam', 'topic');
  git(original, 'switch', '-q', 'main');
  writeFileSync(join(original, 'a.txt'), 'main\n');
  git(original, 'commit', '-qam', 'main');
  git(original, 'config', 'user.name', 'Person');
  git(original, 'config', 'user.email', 'person@example.test');
  const db = openDatabase(':memory:');
  db.prepare(
    "INSERT INTO work_sessions(id,project_id,corral_id,title,objective,pinned,revision,created_at,updated_at,entries_json) VALUES('s1','default',NULL,'t','',0,1,'x','x','[]')",
  ).run();
  const service = new WorkspaceService({
    db,
    clock: new FakeClock(),
    worktreeRoot: join(root, 'copies'),
    forbidden: [],
    hostId: 'host',
    allowSharedDevelopment: true,
  });
  cleanups.push(async () => {
    await service.dispose();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  await service.bind('default', original);
  await service.configure('default', { trusted: true });
  const view = await service.createWorktree('s1', 'default');
  const target = {
    hostId: 'host',
    projectId: 'default',
    bindingId: view.bindingId,
    sessionId: 's1',
    copyGeneration: view.copyGeneration,
  };
  const copy = service.copyOf('s1')?.worktree;
  if (!copy) throw new Error('fixture copy missing');
  git(copy, 'switch', '-qc', 'work');
  const status = () => service.gitStatus({ kind: 'session', id: 's1' });
  const selection = async (operationId: string): Promise<GitHunkWrite> => {
    const state = await status();
    const view = await service.gitHunks('s1', {
      target: { ...target, kind: 'session' },
      path: 'hunks.txt',
      side: 'unstaged',
      head: state.head.oid,
      indexHash: state.indexHash,
    });
    if (view.kind !== 'hunks' || !view.hunks[0]) throw new Error('expected hunks');
    expect(view.hunks).toHaveLength(2);
    return {
      operationId,
      target,
      kind: 'stage_hunks',
      path: 'hunks.txt',
      expect: { head: state.head.oid, indexHash: state.indexHash },
      identity: view.identity,
      hunkIds: [view.hunks[0].id],
    };
  };
  return { service, db, copy, original, target, git, status, selection };
}

it('admits selected hunks under shared development, deduplicates them and refuses exclusive or foreign writers', async () => {
  const s = await setup();
  writeFileSync(join(s.copy, 'hunks.txt'), both);
  const command = await s.selection('stage_selected');
  await s.service.startDevelopment('s1', { operationId: 'development', target: s.target });
  const staged = await s.service.changeGitHunks('s1', command);
  expect(staged).toMatchObject({
    kind: 'git.stage_hunks',
    state: 'succeeded',
    result: { kind: 'applied' },
  });
  expect(await s.service.changeGitHunks('s1', command)).toEqual(staged);
  expect(s.git(s.copy, 'show', ':hunks.txt')).toBe(first);
  expect(readFileSync(join(s.copy, 'hunks.txt'), 'utf8')).toBe(both);
  await expect(
    s.service.changeGitHunks('s1', {
      ...command,
      operationId: 'foreign',
      target: { ...s.target, hostId: 'foreign' },
    }),
  ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  const sequence = await s.service.gitSequence('s1');
  const topic = sequence.localBranches.find((branch) => branch.name === 'topic');
  if (!topic) throw new Error('fixture topic missing');
  for (const kind of ['merge', 'rebase'] as const) {
    await expect(
      s.service.changeGitSequence('s1', {
        kind,
        ...basis(sequence, kind),
        branch: topic.name,
        branchCommit: topic.oid,
        runHooks: false,
      }),
    ).rejects.toMatchObject({ code: 'RUN_ALREADY_ACTIVE' });
  }
  expect((await s.service.gitSequence('s1')).sequence).toBeNull();
  await s.service.finishDevelopment('s1', 'development', s.target);
  expect(s.git(s.original, 'status', '--porcelain')).toBe('');
});

it('records a real merge conflict, exposes three sides and continues after an ordinary save and stage', async () => {
  const s = await setup();
  const initial = await s.service.gitSequence('s1');
  const topic = initial.localBranches.find((branch) => branch.name === 'topic');
  if (!topic) throw new Error('fixture topic missing');
  const command = {
    kind: 'merge' as const,
    ...basis(initial, 'merge_topic'),
    branch: topic.name,
    branchCommit: topic.oid,
    runHooks: false,
  };
  const merged = await s.service.changeGitSequence('s1', command);
  expect(merged).toMatchObject({
    kind: 'git.merge',
    state: 'succeeded',
    result: { kind: 'conflicted', cleanupConfirmed: true },
  });
  expect(await s.service.changeGitSequence('s1', command)).toEqual(merged);
  const state = await s.service.gitSequence('s1');
  expect(state).toMatchObject({
    conflicts: ['a.txt'],
    ownerOperationId: 'merge_topic',
    sequence: { kind: 'merge' },
  });
  const conflict = await s.service.gitConflict('s1', {
    target: s.target,
    path: 'a.txt',
    head: state.head,
    indexHash: state.indexHash,
    sequenceIdentity: state.sequence?.identity ?? null,
  });
  expect(conflict).toMatchObject({
    base: { kind: 'text', text: 'base\n' },
    ours: { kind: 'text', text: 'main\n' },
    theirs: { kind: 'text', text: 'topic\n' },
  });
  expect(
    await s.service.changeGitSequence('s1', {
      kind: 'continue',
      ...basis(state, 'unresolved_continue'),
      runHooks: false,
    }),
  ).toMatchObject({ state: 'failed', result: { error: { code: 'CAPABILITY_DENIED' } } });
  const current = readFileSync(join(s.copy, 'a.txt'), 'utf8');
  expect(
    await s.service.changeDocument('s1', {
      kind: 'save',
      operationId: 'save_resolution',
      target: s.target,
      path: 'a.txt',
      baseHash: hash(current),
      text: 'resolved\n',
      editVersion: 1,
    }),
  ).toMatchObject({ state: 'succeeded' });
  const status = await s.status();
  expect(
    await s.service.changeGit('s1', {
      kind: 'stage',
      operationId: 'stage_resolution',
      target: s.target,
      expect: { head: status.head.oid, indexHash: status.indexHash },
      paths: ['a.txt'],
    }),
  ).toMatchObject({ state: 'succeeded' });
  const continued = await s.service.changeGitSequence('s1', {
    kind: 'continue',
    ...basis(await s.service.gitSequence('s1'), 'continue_merge'),
    runHooks: false,
  });
  expect(continued, continued.result.error?.message).toMatchObject({
    state: 'succeeded',
    result: { kind: 'applied' },
  });
  expect((await s.service.gitSequence('s1')).sequence).toBeNull();
  expect(s.git(s.copy, 'show', 'HEAD:a.txt')).toBe('resolved\n');
  expect(s.git(s.copy, 'rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ')).toHaveLength(
    3,
  );
  expect(s.git(s.copy, 'log', '-1', '--format=%an <%ae>').trim()).toBe(
    'Person <person@example.test>',
  );
  expect(readFileSync(join(s.original, 'a.txt'), 'utf8')).toBe('main\n');
});

it('keeps a lost hunk receipt uncertain without replay, reconciles its index and refuses an external sequence', async () => {
  const s = await setup();
  writeFileSync(join(s.copy, 'hunks.txt'), both);
  const command = await s.selection('lost_hunk_receipt');
  s.db.exec(
    "CREATE TRIGGER fail_hunk_receipt BEFORE UPDATE ON workbench_operations WHEN NEW.operation_id='lost_hunk_receipt' AND NEW.state='succeeded' BEGIN SELECT RAISE(ABORT, 'fixture receipt unavailable'); END",
  );
  expect(await s.service.changeGitHunks('s1', command)).toMatchObject({ state: 'uncertain' });
  s.db.exec('DROP TRIGGER fail_hunk_receipt');
  expect(s.git(s.copy, 'show', ':hunks.txt')).toBe(first);
  expect(s.service.gitAdvancedOperation('s1', command.operationId)).toMatchObject({
    state: 'uncertain',
  });
  expect(
    s.db.prepare('SELECT state FROM workspace_access WHERE owner_id=?').get(command.operationId),
  ).toEqual({ state: 'uncertain' });
  expect(await s.service.changeGitHunks('s1', command)).toMatchObject({ state: 'uncertain' });
  expect(s.git(s.copy, 'show', ':hunks.txt')).toBe(first);
  expect(
    await s.service.reconcileGitAdvanced('s1', {
      target: s.target,
      operationId: command.operationId,
    }),
  ).toMatchObject({ state: 'succeeded', result: { kind: 'applied' } });
  expect(
    s.db.prepare('SELECT state FROM workspace_access WHERE owner_id=?').get(command.operationId),
  ).toEqual({ state: 'released' });
  writeFileSync(join(s.copy, 'hunks.txt'), first);
  s.git(s.copy, 'commit', '-qm', 'selected hunk');
  expect(() => s.git(s.copy, 'merge', '--no-edit', 'topic')).toThrow();
  writeFileSync(join(s.copy, 'a.txt'), 'external resolution\n');
  s.git(s.copy, 'add', 'a.txt');
  const external = await s.service.gitSequence('s1');
  expect(external).toMatchObject({ ownerOperationId: null, sequence: { kind: 'merge' } });
  expect(
    await s.service.changeGitSequence('s1', {
      kind: 'continue',
      ...basis(external, 'external_continue'),
      runHooks: false,
    }),
  ).toMatchObject({ state: 'failed', result: { error: { code: 'CAPABILITY_DENIED' } } });
  expect((await s.service.gitSequence('s1')).sequence?.identity).toBe(external.sequence?.identity);
  expect(readFileSync(join(s.copy, 'a.txt'), 'utf8')).toBe('external resolution\n');
  const operations = new WorkbenchOperations(s.db, new FakeClock());
  const abortId = 'uncertain_abort';
  const pending = {
    kind: 'pending',
    intent: {
      command: { kind: 'abort', ...basis(external, abortId), confirmed: true },
      sequenceBefore: external.sequence,
    },
    cleanupConfirmed: true,
  };
  operations.admit(
    { operationId: abortId, target: s.target, kind: 'git.abort', requestHash: 'fixture' },
    s.copy,
    pending,
  );
  operations.finish(abortId, 'uncertain', pending);
  s.git(s.copy, 'merge', '--quit');
  expect((await s.service.gitSequence('s1')).sequence).toBeNull();
  expect(
    await s.service.reconcileGitAdvanced('s1', { target: s.target, operationId: abortId }),
  ).toMatchObject({ state: 'uncertain' });
  expect(s.git(s.copy, 'show', ':a.txt')).toBe('external resolution\n');
});
