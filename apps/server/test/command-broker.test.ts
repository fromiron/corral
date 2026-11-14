import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { canonicalJson } from '@corral/contracts';
import { openDatabase } from '@corral/storage-sqlite';
import { FakeClock } from '@corral/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceService } from '../src/files/service.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
});
const live = () => ({ aborted: false, onCancel: (_fn: () => void) => () => {} });
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'corral-command-broker-'));
  const original = join(directory, 'repo');
  execFileSync('git', ['init', '-q', original]);
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], { cwd: original });
  await writeFile(join(original, 'a.txt'), 'original\n');
  git('add', '.');
  git('commit', '-qm', 'fixture');
  const db = openDatabase(':memory:');
  db.prepare(
    "INSERT INTO work_sessions (id, project_id, corral_id, title, objective, pinned, revision, created_at, updated_at, archived_at, entries_json) VALUES ('session_1', 'default', NULL, 't', '', 0, 1, 'x', 'x', NULL, '[]')",
  ).run();
  db.prepare(
    "INSERT INTO runs (id,corral_id,definition_hash,snapshot_json,status,last_seq,projection_json,started_at,project_id,session_id) VALUES ('run_1','c','h','{}','running',0,'{}','x','default','session_1')",
  ).run();
  const options = {
    db,
    clock: new FakeClock(),
    worktreeRoot: join(directory, 'worktrees'),
    forbidden: [],
  };
  const service = new WorkspaceService(options);
  cleanup.push(async () => {
    await service.dispose();
    db.close();
    await rm(directory, { recursive: true, force: true });
  });
  await service.bind('default', original);
  await service.configure('default', { trusted: true });
  await service.createWorktree('session_1', 'default');
  service.acquireRun('run_1', 'session_1', true);
  await service.prepareRun('run_1');
  const worktree = service.copyOf('session_1')?.worktree;
  if (!worktree) throw new Error('Working copy was not created');
  const input = {
    runId: 'run_1',
    executionId: 'exec_1',
    attemptNo: 1,
    effectId: 'effect_1',
    request: {
      command:
        process.platform === 'win32'
          ? "'changed' | Add-Content -LiteralPath 'a.txt'"
          : "printf 'changed\\n' >> a.txt",
    },
  };
  return { service, input, original, options, db, worktree };
}

describe('primary working copy command broker', () => {
  it('returns an owned service lease, permits the same run to edit, and confirms cleanup on run stop', async () => {
    const s = await setup();
    const input = {
      ...s.input,
      request: {
        mode: 'service' as const,
        command: process.platform === 'win32' ? 'Start-Sleep -Seconds 60' : 'sleep 60',
        timeoutMs: 20000,
      },
    };
    const plan = await s.service.planCommand(input, live());
    const report = await s.service.runCommand(input, plan, plan.fingerprint, live());
    expect(report).toMatchObject({ state: 'running', cleanupConfirmed: false });
    await s.service.execute(
      {
        name: 'read_file',
        args: { path: 'a.txt' },
        runId: 'run_1',
        executionId: 'exec_1',
        toolCallId: 'read',
      },
      live(),
    );
    await s.service.execute(
      {
        name: 'write_file',
        args: { path: 'a.txt', text: 'edited while service runs\n' },
        runId: 'run_1',
        executionId: 'exec_1',
        toolCallId: 'write',
      },
      live(),
    );
    expect(s.service.commandReport('session_1', plan.operationId).state).toBe('running');
    await s.service.stopRunServices('run_1');
    expect(s.service.commandReport('session_1', plan.operationId)).toMatchObject({
      state: 'cancelled',
      cleanupConfirmed: true,
    });
    await s.service.stopRunServices('run_1');
    const next = { ...input, effectId: 'effect_race' };
    const nextPlan = await s.service.planCommand(next, live());
    const launch = s.service.runCommand(next, nextPlan, nextPlan.fingerprint, live());
    const stopped = s.service.stopRunServices('run_1');
    await expect(launch).rejects.toMatchObject({ code: 'TARGET_TERMINAL' });
    await stopped;
    expect(s.service.listCommands('session_1')).toHaveLength(1);
  }, 30000);
  it('pins approval then records the real changed tree, persists the report, and deduplicates before and after restart', async () => {
    const s = await setup();
    const plan = await s.service.planCommand(s.input, live());
    await expect(s.service.runCommand(s.input, plan, null, live())).rejects.toMatchObject({
      code: 'CAPABILITY_DENIED',
    });
    const pending = s.service.runCommand(s.input, plan, plan.fingerprint, live());
    const duplicate = s.service.runCommand(s.input, plan, plan.fingerprint, live());
    await expect(
      s.service.runCommand(
        { ...s.input, request: { command: 'different' } },
        plan,
        plan.fingerprint,
        live(),
      ),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    const report = await pending;
    expect(await duplicate).toEqual(report);
    expect(report).toMatchObject({ state: 'completed', exitCode: 0, cleanupConfirmed: true });
    expect(await readFile(join(s.worktree, 'a.txt'), 'utf8')).toMatch(/original\r?\nchanged\r?\n$/);
    expect(await readFile(join(s.original, 'a.txt'), 'utf8')).toBe('original\n');
    expect(s.service.listCommands('session_1')[0]).toMatchObject({
      id: plan.operationId,
      state: 'completed',
      before_tree: plan.tree,
    });
    expect(s.service.listCommands('session_1')[0]?.after_tree).not.toBe(plan.tree);
    expect((await s.service.changes('session_1', { kind: 'session' }, () => true)).files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'a.txt', provenance: 'external_observed' }),
      ]),
    );
    const restarted = new WorkspaceService(s.options);
    expect(await restarted.runCommand(s.input, plan, plan.fingerprint, live())).toEqual(report);
    await restarted.dispose();
  }, 30000);

  it('refuses stale approvals, untrusted repositories, reader promotion, and cancellation before launch', async () => {
    const s = await setup();
    const plan = await s.service.planCommand(s.input, live());
    await writeFile(join(s.worktree, 'a.txt'), 'external change\n');
    await expect(
      s.service.runCommand(s.input, plan, plan.fingerprint, live()),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    const fresh = await s.service.planCommand(s.input, live());
    await expect(
      s.service.runCommand(s.input, fresh, fresh.fingerprint, { ...live(), aborted: true }),
    ).rejects.toMatchObject({ code: 'TARGET_TERMINAL' });
    expect(s.service.listCommands('session_1')).toEqual([]);
    await s.service.configure('default', { trusted: false });
    await expect(s.service.planCommand(s.input, live())).rejects.toMatchObject({
      code: 'CAPABILITY_DENIED',
    });
  }, 20000);

  it('a launch fingerprint names the launch without its call or the working tree, while each call keeps its own exact plan check', async () => {
    const s = await setup();
    const first = await s.service.planCommand(s.input, live());
    // The run edits a file, then makes the same call again.
    await writeFile(join(s.worktree, 'a.txt'), 'edited by the run\n');
    const second = { ...s.input, effectId: 'effect_2' };
    const again = await s.service.planCommand(second, live());
    expect(again.operationId).not.toBe(first.operationId);
    expect(again.tree).not.toBe(first.tree);
    expect(again.fingerprint).not.toBe(first.fingerprint);
    expect(again.launchFingerprint).toBe(first.launchFingerprint);
    // Exactly the launch: executable and its content, argv, shell, cwd, environment, timeout,
    // mode, the working-copy identity, the source command and the call's final arguments.
    const hash = (value: unknown) =>
      createHash('sha256').update(canonicalJson(value)).digest('hex');
    const executableHash = createHash('sha256')
      .update(await readFile(again.executable))
      .digest('hex');
    expect(again.launchFingerprint).toBe(
      hash({
        hostId: again.hostId,
        sessionId: again.sessionId,
        workspaceBindingId: again.workspaceBindingId,
        worktreeId: again.worktreeId,
        rootIdentity: again.rootIdentity,
        shellId: again.shellId,
        command: again.command,
        executable: again.executable,
        executableHash,
        argv: again.argv,
        cwd: again.cwd,
        environmentHash: again.environmentHash,
        timeoutMs: again.timeoutMs,
        mode: again.mode,
        request: second.request,
      }),
    );
    await mkdir(join(s.worktree, 'src'));
    for (const request of [
      { ...s.input.request, command: `${s.input.request.command} ` },
      { ...s.input.request, cwd: 'src' },
      { ...s.input.request, timeoutMs: 30000 },
      { ...s.input.request, mode: 'service' as const },
    ])
      expect(
        (await s.service.planCommand({ ...second, request }, live())).launchFingerprint,
      ).not.toBe(first.launchFingerprint);
    // The broker still launches a call only on its own exact plan and fingerprint.
    await expect(
      s.service.runCommand(second, again, first.fingerprint, live()),
    ).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
    await expect(
      s.service.runCommand(second, first, first.fingerprint, live()),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(s.service.listCommands('session_1')).toEqual([]);
    expect(await s.service.runCommand(second, again, again.fingerprint, live())).toMatchObject({
      state: 'completed',
      exitCode: 0,
    });
  }, 20000);

  it('stops a real running command via session-scoped operation and keeps interrupted effects uncertain without replay', async () => {
    const s = await setup();
    const request = {
      command: process.platform === 'win32' ? 'Start-Sleep -Seconds 60' : 'sleep 60',
    };
    const input = { ...s.input, request };
    const plan = await s.service.planCommand(input, live());
    const pending = s.service.runCommand(input, plan, plan.fingerprint, live());
    while (!s.service.listCommands('session_1').length) await delay(30);
    await expect(s.service.stopCommand('other-session', plan.operationId)).rejects.toMatchObject({
      code: 'TARGET_NOT_FOUND',
    });
    const result = await s.service.stopCommand('session_1', plan.operationId);
    expect(result).toMatchObject({ state: 'cancelled', cleanupConfirmed: true });
    expect(await pending).toEqual(result);
    s.db
      .prepare("UPDATE command_operations SET state='running',report_json=NULL WHERE id=?")
      .run(plan.operationId);
    const restarted = new WorkspaceService(s.options);
    const interrupted = await restarted.runCommand(input, plan, plan.fingerprint, live());
    expect(interrupted).toMatchObject({ state: 'uncertain', cleanupConfirmed: false });
    expect(restarted.listCommands('session_1')).toHaveLength(1);
    await restarted.dispose();
  }, 25000);
});
