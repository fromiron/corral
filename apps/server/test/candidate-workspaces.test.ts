import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CandidateComparisonView } from '@corral/contracts';
import { openDatabase } from '@corral/storage-sqlite';
import { FakeClock } from '@corral/testkit';
import { expect, it, vi } from 'vitest';
import { WorkspaceService } from '../src/files/service.ts';

vi.setConfig({ testTimeout: 30000 });
const cancellation = { aborted: false, onCancel: () => () => {} };

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'corral-candidates-'));
  const original = join(root, 'original');
  execFileSync('git', ['init', '-q', original]);
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@e', ...args], { cwd: original });
  git('config', 'core.autocrlf', 'false');
  writeFileSync(join(original, 'a.txt'), 'one\n');
  git('add', '.');
  git('commit', '-qm', 'baseline');
  const db = openDatabase(':memory:');
  db.prepare(
    "INSERT INTO work_sessions(id,project_id,corral_id,title,objective,pinned,revision,created_at,updated_at,archived_at,entries_json) VALUES('session_1','default',NULL,'t','',0,1,'x','x',NULL,'[]')",
  ).run();
  const projection = {
    executions: {
      exec_a: { candidateId: 'candidate_1', nodeId: 'write_1', status: 'active', attemptNo: 1 },
      exec_b: { candidateId: 'candidate_2', nodeId: 'write_2', status: 'active', attemptNo: 1 },
      exec_plan: { nodeId: 'plan', status: 'active', attemptNo: 1 },
    },
    budget: { reservations: {} },
    candidateComparison: undefined as CandidateComparisonView | undefined,
  };
  db.prepare(
    "INSERT INTO runs(id,corral_id,definition_hash,snapshot_json,status,last_seq,projection_json,started_at,project_id,session_id) VALUES('run_1','c','h',?,'running',0,?,'x','default','session_1')",
  ).run(
    JSON.stringify({ autoRoute: { ultra: { comparison: { modelProfiles: ['a', 'b'] } } } }),
    JSON.stringify(projection),
  );
  const service = new WorkspaceService({
    db,
    clock: new FakeClock(),
    worktreeRoot: join(root, 'copies'),
    forbidden: [],
  });
  await service.bind('default', original);
  await service.configure('default', {
    trusted: true,
    verifyCommands: [
      {
        id: 'ok',
        name: 'Check candidate',
        argv: ['/usr/bin/grep', '-q', 'two', 'a.txt'],
        timeoutMs: 5000,
      },
    ],
  });
  await service.createWorktree('session_1', 'default');
  service.acquireRun('run_1', 'session_1', true);
  await service.prepareRun('run_1');
  const call = (
    executionId: string,
    name: 'read_file' | 'write_file',
    args: Record<string, unknown>,
  ) =>
    service.execute(
      {
        runId: 'run_1',
        executionId,
        name,
        args,
        toolCallId: `tool_${Math.random()}`,
        attemptNo: 1,
      },
      cancellation,
    );
  return {
    root,
    original,
    db,
    service,
    projection,
    call,
    async close() {
      await service.dispose();
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function acceptCandidate(
  s: Awaited<ReturnType<typeof setup>>,
  baselineTree: string,
  expectedTree: string,
) {
  const config = s.service.projectTools.latest('default')!;
  const context = {
    runId: 'run_1',
    executionId: 'exec_a',
    attemptNo: 1,
    effectId: 'checked_candidate',
    commandId: 'ok',
    expectedTree,
    isolation: 'linux-bwrap' as const,
    selection: {
      projectId: 'default',
      revision: config.revision,
      hash: config.hash,
      checkIds: ['ok'],
      lspServerIds: [],
    },
  };
  const plan = await s.service.planCheck(context, cancellation);
  const { stale, ...check } = await s.service.runCheck(
    context,
    plan,
    plan.fingerprint,
    cancellation,
  );
  expect(stale).toBe(false);
  s.projection.candidateComparison = {
    runId: 'run_1',
    baselineTree,
    status: 'promoting',
    selectedCandidateId: null,
    candidates: ['candidate_1', 'candidate_2'].map((candidateId) => ({
      candidateId,
      modelProfile: 'fixture',
      state: 'acceptable',
      tree: expectedTree,
      artifactVersionId: 'artifact_1',
      checks: [check],
      reason: null,
      executionIds: ['exec_a'],
      usage: { outputTokens: 0, modelCalls: 0, unknownOutputTokens: 0 },
    })),
  };
}

it('[TC-ULTRA-002-H] [TC-ULTRA-002-N] candidate executions keep independent durable copies and the planner reads only the baseline', async () => {
  const s = await setup();
  try {
    const { baselineTree } = await s.service.prepareCandidates('run_1', [
      'candidate_1',
      'candidate_2',
    ]);
    s.service.bindCandidateExecution('run_1', 'candidate_1', 'exec_a');
    s.service.bindCandidateExecution('run_1', 'candidate_2', 'exec_b');
    await s.call('exec_a', 'read_file', { path: 'a.txt' });
    await s.call('exec_a', 'write_file', { path: 'a.txt', text: 'two\n' });
    expect(await s.call('exec_b', 'read_file', { path: 'a.txt' })).toMatchObject({ text: 'one\n' });
    expect(await s.call('exec_plan', 'read_file', { path: 'a.txt' })).toMatchObject({
      text: 'one\n',
    });
    await expect(s.call('exec_plan', 'write_file', { path: 'a.txt', text: 'bad' })).rejects.toThrow(
      /snapshot|candidate|writer/,
    );
    await expect(
      s.call('unmapped', 'write_file', { path: 'new.txt', text: 'bad' }),
    ).rejects.toThrow(/candidate/);
    expect(() => s.service.bindCandidateExecution('run_1', 'candidate_2', 'exec_a')).toThrow(
      /candidate|identity/,
    );
    expect(await s.service.currentTree('session_1')).toBe(baselineTree);
    expect(readFileSync(join(s.original, 'a.txt'), 'utf8')).toBe('one\n');
    expect(await s.service.prepareCandidates('run_1', ['candidate_1', 'candidate_2'])).toEqual({
      baselineTree,
    });
    const candidateTree = await s.service.currentCandidateTree('run_1', 'candidate_1');
    const config = s.service.projectTools.latest('default')!;
    const context = {
      runId: 'run_1',
      executionId: 'exec_a',
      attemptNo: 1,
      effectId: 'check_a',
      commandId: 'ok',
      expectedTree: candidateTree!,
      isolation: 'linux-bwrap' as const,
      selection: {
        projectId: 'default',
        revision: config.revision,
        hash: config.hash,
        checkIds: ['ok'],
        lspServerIds: [],
      },
    };
    await expect(
      s.service.planCheck({ ...context, isolation: undefined }, cancellation),
    ).rejects.toThrow(/isolation/);
    const plan = await s.service.planCheck(context, cancellation);
    expect(plan.tree).toBe(candidateTree);
    const checked = await s.service.runCheck(context, plan, plan.fingerprint, cancellation);
    expect(checked).toMatchObject({
      verdict: 'pass',
      stale: false,
      cleanupConfirmed: true,
      isolation: 'linux-bwrap',
    });
    expect(
      await s.service.candidateFileVersions('run_1', 'candidate_1', candidateTree!, 'a.txt'),
    ).toMatchObject({
      before: { kind: 'text', text: 'one\n' },
      after: { kind: 'text', text: 'two\n' },
    });
  } finally {
    await s.close();
  }
});

it('[TC-ULTRA-002-N] [TC-ULTRA-002-F] promotion checks settled ownership and both trees, creates recovery evidence and cannot replay another selection', async () => {
  const s = await setup();
  try {
    const { baselineTree } = await s.service.prepareCandidates('run_1', [
      'candidate_1',
      'candidate_2',
    ]);
    s.service.bindCandidateExecution('run_1', 'candidate_1', 'exec_a');
    await s.call('exec_a', 'read_file', { path: 'a.txt' });
    await s.call('exec_a', 'write_file', { path: 'a.txt', text: 'two\n' });
    const expectedTree = (await s.service.currentCandidateTree('run_1', 'candidate_1'))!;
    s.service.bindCandidateExecution('run_1', 'candidate_2', 'exec_b');
    await s.call('exec_b', 'read_file', { path: 'a.txt' });
    await s.call('exec_b', 'write_file', { path: 'a.txt', text: 'last, unselected candidate\n' });
    const request = {
      runId: 'run_1',
      candidateId: 'candidate_1',
      expectedTree,
      baselineTree,
      commandId: 'choose_one',
    };
    await expect(s.service.promoteCandidate(request)).rejects.toThrow(/worker|execution|settled/);
    await acceptCandidate(s, baselineTree, expectedTree);
    for (const execution of Object.values(s.projection.executions)) execution.status = 'succeeded';
    s.db
      .prepare('UPDATE runs SET projection_json=? WHERE id=?')
      .run(JSON.stringify(s.projection), 'run_1');
    s.db
      .prepare(
        "INSERT INTO effect_intents(effect_id,run_id,kind,scope,epoch,status,outcome) VALUES('unknown','run_1','model_request','exec_a',1,'settled','unknown')",
      )
      .run();
    await expect(s.service.promoteCandidate(request)).rejects.toThrow(/settled/);
    s.db.prepare("UPDATE effect_intents SET outcome='succeeded' WHERE effect_id='unknown'").run();
    const main = s.service.copyOf('session_1')!.worktree;
    writeFileSync(join(main, 'a.txt'), 'person edit\n');
    await expect(s.service.promoteCandidate(request)).rejects.toThrow(/tree|changed/);
    expect(readFileSync(join(main, 'a.txt'), 'utf8')).toBe('person edit\n');
    writeFileSync(join(main, 'a.txt'), 'one\n');
    await expect(
      s.service.promoteCandidate({ ...request, expectedTree: baselineTree }),
    ).rejects.toThrow(/tree|changed/);
    const result = await s.service.promoteCandidate(request);
    expect(readFileSync(join(main, 'a.txt'), 'utf8')).toBe('two\n');
    expect(await s.service.promoteCandidate(request)).toEqual(result);
    s.projection.candidateComparison!.status = 'selected';
    s.projection.candidateComparison!.selectedCandidateId = 'candidate_1';
    s.db
      .prepare('UPDATE runs SET projection_json=? WHERE id=?')
      .run(JSON.stringify(s.projection), 'run_1');
    expect(
      (await s.service.changes('session_1', { kind: 'session' }, () => false)).files,
    ).toMatchObject([{ path: 'a.txt', provenance: 'managed_agent' }]);
    await expect(
      s.call('exec_a', 'write_file', { path: 'a.txt', text: 'late write' }),
    ).rejects.toThrow(/active|cancelled/);
    expect(
      s.service
        .checkpoints('session_1')
        .some((item) => item.kind === 'before_restore' && item.tree === baselineTree),
    ).toBe(true);
    await expect(
      s.service.promoteCandidate({ ...request, candidateId: 'candidate_2' }),
    ).rejects.toThrow(/selection|identity|different/);
    expect(readFileSync(join(s.original, 'a.txt'), 'utf8')).toBe('one\n');
    s.service.releaseRun('run_1', true);
    await s.service.removeWorktree('session_1');
    expect(s.db.prepare("SELECT 1 FROM candidate_worktrees WHERE state!='removed'").all()).toEqual(
      [],
    );
  } finally {
    await s.close();
  }
});

it('[TC-ULTRA-002-N] candidate promotion refuses checked configuration changes and a cancelled Run', async () => {
  const s = await setup();
  try {
    const { baselineTree } = await s.service.prepareCandidates('run_1', [
      'candidate_1',
      'candidate_2',
    ]);
    s.service.bindCandidateExecution('run_1', 'candidate_1', 'exec_a');
    await s.call('exec_a', 'read_file', { path: 'a.txt' });
    await s.call('exec_a', 'write_file', { path: 'a.txt', text: 'two\n' });
    const expectedTree = (await s.service.currentCandidateTree('run_1', 'candidate_1'))!;
    await acceptCandidate(s, baselineTree, expectedTree);
    for (const execution of Object.values(s.projection.executions)) execution.status = 'succeeded';
    s.db
      .prepare("UPDATE runs SET status='cancelling',projection_json=? WHERE id='run_1'")
      .run(JSON.stringify(s.projection));
    const request = {
      runId: 'run_1',
      candidateId: 'candidate_1',
      expectedTree,
      baselineTree,
      commandId: 'choose_one',
    };
    await expect(s.service.promoteCandidate(request)).rejects.toThrow(/promotion/);
    s.db.prepare("UPDATE runs SET status='running' WHERE id='run_1'").run();
    await s.service.configure('default', {
      verifyCommands: [
        { id: 'ok', name: 'Changed check', argv: ['/usr/bin/true'], timeoutMs: 5000 },
      ],
    });
    await expect(s.service.promoteCandidate(request)).rejects.toThrow(/configuration/);
    expect(await s.service.currentTree('session_1')).toBe(baselineTree);
    expect(s.db.prepare('SELECT 1 FROM candidate_promotions').all()).toEqual([]);
  } finally {
    await s.close();
  }
});
