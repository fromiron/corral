import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { openDatabase, SqliteProjectToolStore } from '@corral/storage-sqlite';
import { FakeClock, Gate } from '@corral/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReviewService } from '../src/files/review.ts';
import { safeRelative, WorkspaceService } from '../src/files/service.ts';

// The file broker's rules (CR-012): paths, the read-before-change rule, and what a stop leaves.

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'corral-files-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function setup(
  edit?: ConstructorParameters<typeof WorkspaceService>[0]['edit'],
  io?: ConstructorParameters<typeof WorkspaceService>[0]['io'],
  lsp?: ConstructorParameters<typeof WorkspaceService>[0]['lsp'],
) {
  const original = temp();
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], { cwd: original });
  git('init', '-q');
  writeFileSync(join(original, 'a.txt'), 'one\n');
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  const db = openDatabase(':memory:');
  db.prepare(
    "INSERT INTO work_sessions (id, project_id, corral_id, title, objective, pinned, revision, created_at, updated_at, archived_at, entries_json) VALUES ('session_1', 'default', NULL, 't', '', 0, 1, 'x', 'x', NULL, '[]')",
  ).run();
  db.prepare(
    `INSERT INTO runs (id, corral_id, definition_hash, snapshot_json, status, last_seq,
       projection_json, started_at, project_id, session_id)
     VALUES ('run_1', 'c', 'h', '{}', 'running', 0, '{}', 'x', 'default', 'session_1')`,
  ).run();
  const clock = new FakeClock();
  const service = new WorkspaceService({
    db,
    clock,
    worktreeRoot: join(temp(), 'worktrees'),
    forbidden: [],
    ...(edit ? { edit } : {}),
    ...(io ? { io } : {}),
    ...(lsp ? { lsp } : {}),
  });
  await service.bind('default', original);
  await service.configure('default', { trusted: true });
  await service.createWorktree('session_1', 'default');
  const call = (
    name: 'read_file' | 'write_file' | 'delete_file' | 'move_file' | 'edit' | 'write',
    args: Record<string, unknown>,
    executionId = 'exec_1',
  ) =>
    service.execute(
      { name, args, runId: 'run_1', executionId, toolCallId: `tool_${Math.random()}` },
      { aborted: false, onCancel: () => () => {} },
    );
  return { db, service, call, original, clock };
}

describe('file broker (CR-012)', () => {
  it('[TC-CONTINUITY-001-N] [TC-RESUME-001-N] runtime file identity refuses changed, foreign and uncertain trees', async () => {
    const s = await setup();
    const root = s.service.copyOf('session_1')!.worktree;
    try {
      const reference = await s.service.captureRuntimeFiles('run_1', 'runtime_files');
      await s.service.captureRuntimeFiles('run_1', 'runtime_files_second');
      expect(await s.service.verifyRuntimeFiles('run_1', reference)).toBe(true);
      expect(await s.service.verifyRuntimeFiles('run_missing', reference)).toBe(false);
      expect(
        await s.service.verifyRuntimeFiles('run_1', { ...reference, manifestHash: '0'.repeat(64) }),
      ).toBe(false);
      writeFileSync(join(root, 'a.txt'), 'Changed after boundary');
      expect(await s.service.verifyRuntimeFiles('run_1', reference)).toBe(false);
      s.db
        .prepare(
          "INSERT INTO work_sessions (id,project_id,corral_id,title,objective,pinned,revision,created_at,updated_at,archived_at,entries_json) VALUES ('session_branch','default',NULL,'Branch','',0,1,'x','x',NULL,'[]')",
        )
        .run();
      expect(await s.service.branchRuntimeFiles('run_1', reference, 'session_branch')).toBe(
        reference.tree,
      );
      const branchRoot = s.service.copyOf('session_branch')!.worktree;
      expect(readFileSync(join(branchRoot, 'a.txt'), 'utf8')).toBe('one\n');
      expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('Changed after boundary');
      expect(await s.service.branchRuntimeFiles('run_1', reference, 'session_branch')).toBe(
        reference.tree,
      );
      expect(
        (await s.service.changes('session_branch', { kind: 'session' }, () => true)).files,
      ).toEqual([]);
      writeFileSync(join(root, 'a.txt'), 'one\n');
      s.db
        .prepare(
          'INSERT INTO checkpoint_restores (id,session_id,request_hash,result_json) VALUES (?,?,?,?)',
        )
        .run(
          'restore_uncertain',
          'session_1',
          'a'.repeat(64),
          JSON.stringify({ state: 'uncertain' }),
        );
      expect(await s.service.verifyRuntimeFiles('run_1', reference)).toBe(false);
    } finally {
      s.db.close();
    }
  });
  it('[TC-HUNK-001-H] [TC-HUNK-001-N] selected hunks preserve other changes and the index, checkpoint the correct target and reject stale edits', async () => {
    const s = await setup();
    const root = s.service.copyOf('session_1')!.worktree;
    try {
      const lines = Array.from({ length: 24 }, (_, i) => `line ${i + 1}\n`);
      const baseline = lines.join('');
      writeFileSync(join(root, 'a.txt'), baseline);
      writeFileSync(join(s.original, 'a.txt'), baseline);
      writeFileSync(join(s.original, 'unrelated.txt'), 'keep');
      const indexBefore = readFileSync(join(s.original, '.git/index'));
      const before = await s.service.captureCheckpoint('session_1', {
        checkpointId: 'before_hunks',
        label: 'Before hunks',
      });
      lines[1] = 'first change\n';
      lines[21] = 'second change\n';
      writeFileSync(join(root, 'a.txt'), lines.join(''));
      const after = await s.service.captureCheckpoint('session_1', {
        checkpointId: 'after_hunks',
        label: 'After hunks',
      });
      const request = { from: before.tree!, to: after.tree!, path: 'a.txt' };
      const hunks = await s.service.hunks('session_1', request);
      expect(hunks.hunks).toHaveLength(2);
      const planInput = {
        ...request,
        planId: 'hunk_original',
        patchHash: hunks.patchHash,
        hunkIds: [hunks.hunks[0]!.id],
        action: 'apply_original' as const,
      };
      const plan = await s.service.planHunks('session_1', planInput);
      expect(plan.target).toBe('original');
      const restore = {
        operationId: 'apply_hunk',
        checkpointId: plan.checkpointId,
        manifestHash: plan.manifestHash,
        expectedTree: plan.expectedTree,
      };
      writeFileSync(join(s.original, 'a.txt'), 'user edit');
      await expect(s.service.restoreCheckpoint('session_1', restore)).rejects.toThrow(/changed/);
      expect(readFileSync(join(s.original, 'a.txt'), 'utf8')).toBe('user edit');
      writeFileSync(join(s.original, 'a.txt'), baseline);
      const applied = await s.service.restoreCheckpoint('session_1', restore);
      expect(applied.state).toBe('applied');
      expect(await s.service.restoreCheckpoint('session_1', restore)).toEqual(applied);
      expect(readFileSync(join(s.original, 'a.txt'), 'utf8')).toBe(
        baseline.replace('line 2\n', 'first change\n'),
      );
      expect(readFileSync(join(s.original, 'unrelated.txt'), 'utf8')).toBe('keep');
      expect(readFileSync(join(s.original, '.git/index'))).toEqual(indexBefore);
      expect(
        s.service
          .checkpoints('session_1')
          .find((item) => item.checkpointId === applied.beforeCheckpointId),
      ).toMatchObject({ target: 'original', state: 'ready', pinned: true });
      await expect(
        s.service.planHunks('session_1', {
          ...planInput,
          planId: 'bad_hunk',
          patchHash: 'f'.repeat(64),
        }),
      ).rejects.toThrow();
      const reverse = await s.service.planHunks('session_1', {
        ...planInput,
        planId: 'hunk_reverse',
        action: 'revert_working_copy',
        hunkIds: [hunks.hunks[1]!.id],
      });
      expect(
        (
          await s.service.restoreCheckpoint('session_1', {
            operationId: 'revert_hunk',
            checkpointId: reverse.checkpointId,
            manifestHash: reverse.manifestHash,
            expectedTree: reverse.expectedTree,
          })
        ).state,
      ).toBe('applied');
      expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe(
        baseline.replace('line 2\n', 'first change\n'),
      );
      await expect(
        s.service.planHunks('session_1', { ...planInput, hunkIds: [hunks.hunks[1]!.id] }),
      ).rejects.toThrow(/identity/);
      await expect(s.service.hunks('session_other', request)).rejects.toThrow();
      rmSync(join(s.original, 'a.txt'));
      const outside = join(temp(), 'protected');
      writeFileSync(outside, 'protected');
      symlinkSync(outside, join(s.original, 'a.txt'));
      await expect(
        s.service.planHunks('session_1', { ...planInput, planId: 'hunk_symlink' }),
      ).rejects.toThrow();
      expect(readFileSync(outside, 'utf8')).toBe('protected');
    } finally {
      s.db.close();
    }
  });

  it('[TC-CKPT-001-H] [TC-CKPT-001-N] checkpoints preserve a recovery copy and refuse stale, foreign and incomplete restores', async () => {
    const s = await setup();
    const root = s.service.copyOf('session_1')!.worktree;
    try {
      writeFileSync(join(root, 'image.bin'), Buffer.from([0, 1, 2, 255]));
      const checkpoint = await s.service.captureCheckpoint('session_1', {
        checkpointId: 'checkpoint_one',
        label: 'Before edit',
      });
      expect(checkpoint.state).toBe('ready');
      expect(
        await s.service.captureCheckpoint('session_1', {
          checkpointId: 'checkpoint_one',
          label: 'Before edit',
        }),
      ).toEqual(checkpoint);
      writeFileSync(join(root, 'a.txt'), 'user changes\n');
      const expectedTree = await s.service.currentTree('session_1');
      writeFileSync(join(root, 'a.txt'), 'newer user changes\n');
      await expect(
        s.service.restoreCheckpoint('session_1', {
          operationId: 'restore_stale',
          checkpointId: checkpoint.checkpointId,
          manifestHash: checkpoint.manifestHash,
          expectedTree,
        }),
      ).rejects.toThrow(/changed/);
      expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('newer user changes\n');
      const restore = await s.service.restoreCheckpoint('session_1', {
        operationId: 'restore_one',
        checkpointId: checkpoint.checkpointId,
        manifestHash: checkpoint.manifestHash,
        expectedTree: await s.service.currentTree('session_1'),
      });
      expect(restore.state).toBe('applied');
      expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('one\n');
      expect(readFileSync(join(root, 'image.bin'))).toEqual(Buffer.from([0, 1, 2, 255]));
      expect(
        s.service
          .checkpoints('session_1')
          .find((item) => item.checkpointId === restore.beforeCheckpointId),
      ).toMatchObject({ state: 'ready', pinned: true, kind: 'before_restore' });
      expect(readFileSync(join(s.original, 'a.txt'), 'utf8')).toBe('one\n');
      await expect(
        s.service.restoreCheckpoint('different_session', {
          operationId: 'restore_other',
          checkpointId: checkpoint.checkpointId,
          manifestHash: checkpoint.manifestHash,
          expectedTree: checkpoint.tree,
        }),
      ).rejects.toThrow();
      rmSync(join(root, 'a.txt'));
      symlinkSync(join(s.original, 'a.txt'), join(root, 'a.txt'));
      await expect(
        s.service.restoreCheckpoint('session_1', {
          operationId: 'restore_link',
          checkpointId: checkpoint.checkpointId,
          manifestHash: checkpoint.manifestHash,
          expectedTree: await s.service.currentTree('session_1'),
        }),
      ).rejects.toThrow();
      expect(readFileSync(join(s.original, 'a.txt'), 'utf8')).toBe('one\n');
      rmSync(join(root, 'a.txt'));
      writeFileSync(join(root, 'a.txt'), 'one\n');
      for (let i = 0; i < 52; i++) {
        await s.service.captureCheckpoint('session_1', {
          checkpointId: `checkpoint_gc${i}`,
          label: `GC ${i}`,
        });
        if (i > 0) s.service.pinCheckpoint('session_1', `checkpoint_gc${i}`, false);
        s.clock.advance(1);
      }
      s.clock.advance(31 * 86400_000);
      expect((await s.service.pruneCheckpoints('session_1')).expired).toEqual(['checkpoint_gc1']);
      expect(
        s.service.checkpoints('session_1').find((item) => item.checkpointId === 'checkpoint_gc0')
          ?.state,
      ).toBe('ready');
      const pending = { ...restore, operationId: 'restore_crashed', state: 'applying' };
      s.db
        .prepare(
          'INSERT INTO checkpoint_restores (id,session_id,request_hash,result_json) VALUES (?,?,?,?)',
        )
        .run(pending.operationId, 'session_1', 'fixture', JSON.stringify(pending));
      const recovered = new WorkspaceService({
        db: s.db,
        clock: s.clock,
        worktreeRoot: join(temp(), 'recovery'),
        forbidden: [],
      });
      expect(
        recovered
          .checkpointRestores('session_1')
          .find((item) => item.operationId === pending.operationId)?.state,
      ).toBe('uncertain');
      s.db
        .prepare("UPDATE file_checkpoints SET state='incomplete' WHERE id=?")
        .run(checkpoint.checkpointId);
      await expect(
        s.service.restoreCheckpoint('session_1', {
          operationId: 'restore_incomplete',
          checkpointId: checkpoint.checkpointId,
          manifestHash: checkpoint.manifestHash,
          expectedTree: checkpoint.tree,
        }),
      ).rejects.toThrow(/complete/);
    } finally {
      s.db.close();
    }
  });
  it('[TC-CHAT-002-N] reading a finished run never invents its missing end tree from later user changes', async () => {
    const s = await setup();
    try {
      await s.service.snapshotRun('run_1', 'session_1', 'start');
      const snapshots = s.service.runSnapshots('session_1');
      writeFileSync(join(s.service.copyOf('session_1')!.worktree, 'a.txt'), 'later user edit');
      const changes = await s.service.changes(
        'session_1',
        { kind: 'run', runId: 'run_1' },
        () => true,
      );
      expect(changes.to).toBeNull();
      expect(changes.unavailable).toBeTruthy();
      expect(s.service.runSnapshots('session_1')).toEqual(snapshots);
    } finally {
      s.db.close();
    }
  });
  it('[TC-HAR-014-N] concurrent criteria pinning cannot replace the first immutable set', async () => {
    const s = await setup();
    const file = await s.call('read_file', { path: 'a.txt' });
    const results = await Promise.allSettled([
      s.service.pinCriteria('run_1', [{ path: 'a.txt', sha256: String(file.sha256) }]),
      s.service.pinCriteria('run_1', []),
    ]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    await expect(s.call('write_file', { path: 'a.txt', text: 'changed' })).rejects.toThrow(
      /criteria/,
    );
    s.db.close();
  });
  it('[TC-HAR-016-N] MCP launch trust is tied to pinned configuration, working copy code and authentication scope', async () => {
    const s = await setup();
    try {
      const local = {
        id: 'local',
        name: 'Local',
        transport: 'stdio' as const,
        argv: [process.execPath, 'a.txt'],
        exposure: 'direct' as const,
        timeoutMs: 10000,
      };
      const remote = {
        id: 'docs',
        name: 'Docs',
        transport: 'http' as const,
        url: 'https://example.invalid/mcp',
        exposure: 'direct' as const,
        timeoutMs: 10000,
        auth: { kind: 'oauth' as const, credentialRef: 'docs_login', scope: 'read:docs' },
      };
      const config = s.service.configureProjectTools('default', 0, {
        checks: [],
        lspServers: [],
        mcpServers: [local, remote],
      });
      const selection = {
        projectId: 'default',
        revision: config.revision,
        hash: config.hash,
        checkIds: [],
        lspServerIds: [],
        mcpServerIds: ['local', 'docs'],
      };
      await expect(s.service.runtimeMcp('run_1', selection)).rejects.toThrow(/trust/);
      for (const id of ['local', 'docs']) {
        const inspected = await s.service.inspectMcpServer('default', id);
        await s.service.trustMcpServer('default', id, inspected.fingerprint, true);
      }
      const runtime = await s.service.runtimeMcp('run_1', selection);
      expect(runtime.servers.map((row) => row.server.id)).toEqual(['local', 'docs']);
      expect(runtime.cwd).toBe(s.service.copyOf('session_1')!.worktree);
      await expect(
        s.service.runtimeMcp('run_1', { ...selection, projectId: 'other' }),
      ).rejects.toThrow();
      const oldRemote = await s.service.inspectMcpServer('default', 'docs');
      s.service.configureProjectTools('default', 1, {
        checks: [],
        lspServers: [],
        mcpServers: [local, { ...remote, auth: { ...remote.auth, scope: 'write:docs' } }],
      });
      expect((await s.service.inspectMcpServer('default', 'docs')).fingerprint).not.toBe(
        oldRemote.fingerprint,
      );
      expect((await s.service.runtimeMcp('run_1', selection)).servers[1]!.server).toEqual(remote);
      writeFileSync(join(runtime.cwd, 'a.txt'), 'changed server code');
      await expect(s.service.runtimeMcp('run_1', selection)).rejects.toThrow(/trust/);
    } finally {
      s.db.close();
    }
  });
  it('[TC-HAR-016-N] changing legacy check settings retains MCP definitions', async () => {
    const s = await setup();
    try {
      const mcp = {
        id: 'docs',
        name: 'Docs',
        transport: 'http' as const,
        url: 'https://example.invalid/mcp',
        exposure: 'direct' as const,
        timeoutMs: 10000,
        auth: { kind: 'none' as const },
      };
      s.service.configureProjectTools('default', 0, {
        checks: [],
        lspServers: [],
        mcpServers: [mcp],
      });
      await s.service.configure('default', { verifyCommands: [] });
      expect(s.service.projectTools.latest('default')?.mcpServers).toEqual([mcp]);
    } finally {
      s.db.close();
    }
  });
  it('[TC-HAR-014-H] creates comparison copies from the exact requested commit even after the source HEAD moves', async () => {
    const s = await setup();
    try {
      const first = s.service.worktreeView('session_1')!.baseCommit;
      writeFileSync(join(s.original, 'a.txt'), 'new source\n');
      execFileSync(
        'git',
        ['-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qam', 'second'],
        { cwd: s.original },
      );
      s.db
        .prepare(
          "INSERT INTO work_sessions (id, project_id, corral_id, title, objective, pinned, revision, created_at, updated_at, archived_at, entries_json) VALUES ('session_2', 'default', NULL, 't', '', 0, 1, 'x', 'x', NULL, '[]')",
        )
        .run();
      const second = await s.service.createWorktree('session_2', 'default', first);
      expect(second.baseCommit).toBe(first);
      expect(readFileSync(join(s.service.copyOf('session_2')!.worktree, 'a.txt'), 'utf8')).toBe(
        'one\n',
      );
      expect(readFileSync(join(s.original, 'a.txt'), 'utf8')).toBe('new source\n');
    } finally {
      s.db.close();
    }
  });
  it('[TC-HAR-014-N] pins recipe criteria without lending read evidence and rejects changes or a new baseline', async () => {
    const s = await setup();
    try {
      const source = { sha256: createHash('sha256').update('one\n').digest('hex') };
      await s.service.pinCriteria('run_1', [{ path: 'a.txt', sha256: source.sha256 }]);
      expect(await s.service.validateCriteria('run_1')).toBe(true);
      await expect(s.call('write_file', { path: 'a.txt', text: 'weaker' })).rejects.toThrow(
        /criteria/,
      );
      await s.call('read_file', { path: 'a.txt' });
      for (const [name, args] of [
        ['write_file', { path: 'a.txt', text: 'weaker' }],
        ['delete_file', { path: 'a.txt' }],
        ['move_file', { from: 'a.txt', to: 'b.txt' }],
      ] as const)
        await expect(s.call(name, args)).rejects.toThrow(/criteria/);
      await expect(
        s.service.pinCriteria('run_1', [{ path: 'a.txt', sha256: 'a'.repeat(64) }]),
      ).rejects.toThrow(/criteria/);
      const root = s.service.copyOf('session_1')?.worktree;
      if (!root) throw new Error('no copy');
      writeFileSync(join(root, 'a.txt'), 'native mutation');
      expect(await s.service.validateCriteria('run_1')).toBe(false);
    } finally {
      s.db.close();
    }
  });
  async function lspSetup(
    mode = 'normal',
    lsp?: ConstructorParameters<typeof WorkspaceService>[0]['lsp'],
    io?: ConstructorParameters<typeof WorkspaceService>[0]['io'],
  ) {
    const s = await setup(undefined, io, lsp);
    const root = s.service.copyOf('session_1')?.worktree;
    if (!root) throw new Error('missing copy');
    const fixture = readFileSync(
      new URL('./fixtures/lsp-server.mjs', import.meta.url),
      'utf8',
    ).replace(
      "'vscode-languageserver-protocol/node'",
      JSON.stringify(import.meta.resolve('vscode-languageserver-protocol/node')),
    );
    writeFileSync(join(root, 'server.mjs'), fixture);
    writeFileSync(join(root, 'b.txt'), 'target\n');
    const config = s.service.configureProjectTools('default', 0, {
      checks: [],
      lspServers: [
        {
          id: 'fixture',
          name: 'Fixture LSP',
          argv: [process.execPath, 'server.mjs', mode],
          timeoutMs: 1000,
          languageIds: ['plaintext'],
          fileExtensions: ['.txt'],
        },
      ],
    });
    const input = {
      runId: 'run_1',
      executionId: 'exec_1',
      attemptNo: 1,
      effectId: 'effect_lsp',
      selection: {
        projectId: 'default',
        revision: config.revision,
        hash: config.hash,
        checkIds: [],
        lspServerIds: ['fixture'],
      },
      query: {
        serverId: 'fixture',
        path: 'a.txt',
        operation: 'definition' as const,
        position: { line: 0, character: 0 },
      },
    };
    return { ...s, root, input, cancellation: { aborted: false, onCancel: () => () => {} } };
  }
  async function proposalSetup(io?: ConstructorParameters<typeof WorkspaceService>[0]['io']) {
    const s = await lspSetup(
      'normal',
      {
        query: async (input) => ({
          kind: 'edits',
          actions: [
            {
              title: 'Update names',
              edit: {
                documentChanges: [
                  {
                    textDocument: { uri: input.document.uri, version: 1 },
                    edits: [
                      {
                        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
                        newText: 'updated',
                      },
                    ],
                  },
                  {
                    textDocument: {
                      uri: new URL('./b.txt', input.document.uri).href,
                      version: null,
                    },
                    edits: [
                      {
                        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
                        newText: 'changed',
                      },
                    ],
                  },
                ],
              },
            },
          ],
          durationMs: 1,
          truncated: false,
        }),
      },
      io,
    );
    const input = {
      ...s.input,
      query: { ...s.input.query, operation: 'rename' as const, newName: 'updated' },
    };
    const plan = await s.service.planLsp(input, s.cancellation);
    const result = await s.service.runLsp(input, plan, plan.fingerprint, s.cancellation);
    if (result.result.kind !== 'proposals' || !result.result.proposals[0])
      throw new Error('proposal missing');
    const proposal = s.service.lspProposal('session_1', result.result.proposals[0].proposalId);
    return { ...s, input, proposal };
  }
  it.each(['ignored-target', 'ignored-source', 'filtered-target'])(
    '[TC-HAR-018-N] refuses LSP changes whose original bytes are outside the fixed tree (%s)',
    async (kind) => {
      const s = await lspSetup('normal', {
        query: async (input) => {
          if (kind === 'ignored-target') writeFileSync(join(s.root, 'b.txt'), 'external\n');
          return {
            kind: 'edits',
            actions: [
              {
                title: 'Old rename',
                edit: {
                  changes: {
                    [new URL('./b.txt', input.document.uri).href]: [
                      {
                        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
                        newText: 'changed',
                      },
                    ],
                  },
                },
              },
            ],
            durationMs: 1,
            truncated: false,
          };
        },
      });
      if (kind === 'filtered-target') {
        writeFileSync(join(s.root, '.gitattributes'), 'b.txt text eol=lf\n');
        writeFileSync(join(s.root, 'b.txt'), 'target\r\n');
      } else writeFileSync(join(s.root, '.gitignore'), 'b.txt\n');
      const input = {
        ...s.input,
        query: {
          ...s.input.query,
          path: kind === 'ignored-source' ? 'b.txt' : 'a.txt',
          operation: 'rename' as const,
          newName: 'changed',
        },
      };
      const plan = await s.service.planLsp(input, s.cancellation);
      try {
        await expect(
          s.service.runLsp(input, plan, plan.fingerprint, s.cancellation),
        ).rejects.toThrow(/snapshot|fixed tree/);
        expect(s.service.lspProposals('session_1')).toEqual([]);
        expect(readFileSync(join(s.root, 'b.txt'), 'utf8')).toBe(
          kind === 'ignored-target'
            ? 'external\n'
            : kind === 'filtered-target'
              ? 'target\r\n'
              : 'target\n',
        );
      } finally {
        s.db.close();
      }
    },
  );
  it('[TC-HAR-018-H] surfaces pending language-server proposals in the session inbox until reviewed', async () => {
    const s = await proposalSetup();
    const review = new ReviewService({ db: s.db, clock: new FakeClock(), files: s.service });
    const sessions = [{ sessionId: 'session_1', title: 'Proposal session', entries: [] }];
    expect(review.inbox(sessions, [])).toContainEqual({
      kind: 'lsp_proposal',
      sessionId: 'session_1',
      sessionTitle: 'Proposal session',
      runId: null,
      detail: '1',
    });
    s.service.dismissLspProposal('session_1', s.proposal.proposalId, s.proposal.hash);
    expect(review.inbox(sessions, []).some((item) => item.kind === 'lsp_proposal')).toBe(false);
    s.db.close();
  });
  it('[TC-HAR-018-H] persists a pinned proposal, waits for explicit idle-session apply and never writes twice', async () => {
    const s = await proposalSetup();
    expect(s.proposal.state).toBe('pending');
    expect(s.service.lspProposals('session_1')).toHaveLength(1);
    expect(readFileSync(join(s.root, 'a.txt'), 'utf8')).toBe('one\n');
    expect(readFileSync(join(s.root, 'b.txt'), 'utf8')).toBe('target\n');
    await expect(
      s.service.applyLspProposal('session_1', s.proposal.proposalId, s.proposal.hash),
    ).rejects.toThrow(/run|Run/);
    s.db.prepare("UPDATE runs SET status='succeeded' WHERE id='run_1'").run();
    await expect(
      s.service.applyLspProposal('session_1', s.proposal.proposalId, '0'.repeat(64)),
    ).rejects.toThrow(/hash|changed/);
    expect(
      (await s.service.applyLspProposal('session_1', s.proposal.proposalId, s.proposal.hash)).state,
    ).toBe('applied');
    expect(readFileSync(join(s.root, 'a.txt'), 'utf8')).toBe('updated\n');
    expect(readFileSync(join(s.root, 'b.txt'), 'utf8')).toBe('changed\n');
    expect(
      (await s.service.applyLspProposal('session_1', s.proposal.proposalId, s.proposal.hash)).state,
    ).toBe('applied');
    expect(s.db.prepare('SELECT * FROM file_operations').all()).toHaveLength(2);
    expect(() => s.service.lspProposal('different_session', s.proposal.proposalId)).toThrow();
    s.db.close();
  });
  it('[TC-HAR-018-N] preflights every file before the first write and rejects a stale proposal', async () => {
    const s = await proposalSetup();
    s.db.prepare("UPDATE runs SET status='succeeded' WHERE id='run_1'").run();
    writeFileSync(join(s.root, 'b.txt'), 'external change\n');
    const result = await s.service.applyLspProposal(
      'session_1',
      s.proposal.proposalId,
      s.proposal.hash,
    );
    expect(result.state).toBe('stale');
    expect(readFileSync(join(s.root, 'a.txt'), 'utf8')).toBe('one\n');
    expect(s.db.prepare('SELECT * FROM file_operations').all()).toHaveLength(0);
    s.db.close();
  });
  it('[TC-HAR-018-N] rechecks working-copy identity after waiting for its lease', async () => {
    const s = await proposalSetup();
    s.db.prepare("UPDATE runs SET status='succeeded' WHERE id='run_1'").run();
    const entered = new Gate(),
      release = new Gate();
    const target = s.service as unknown as {
      lease<T>(path: string, work: () => Promise<T>): Promise<T>;
    };
    const lease = target.lease.bind(target);
    const spy = vi.spyOn(target, 'lease').mockImplementationOnce(async (path, work) => {
      entered.open();
      await release.wait();
      return lease(path, work);
    });
    const applying = s.service.applyLspProposal(
      'session_1',
      s.proposal.proposalId,
      s.proposal.hash,
    );
    await entered.wait();
    s.db
      .prepare(
        "UPDATE session_worktrees SET created_at='2026-10-18T01:00:00Z' WHERE session_id='session_1'",
      )
      .run();
    release.open();
    try {
      expect((await applying).state).toBe('stale');
      expect(readFileSync(join(s.root, 'a.txt'), 'utf8')).toBe('one\n');
      expect(s.db.prepare('SELECT * FROM file_operations').all()).toHaveLength(0);
    } finally {
      spy.mockRestore();
      s.db.close();
    }
  });
  it('[TC-HAR-018-N] dismissing during asynchronous preflight cannot apply or overwrite the dismissal', async () => {
    for (const stale of [false, true]) {
      const s = await proposalSetup();
      s.db.prepare("UPDATE runs SET status='succeeded' WHERE id='run_1'").run();
      const entered = new Gate(),
        release = new Gate();
      const target = s.service as unknown as { snapshotTree(path: string): Promise<string> };
      const snapshot = target.snapshotTree.bind(target);
      const spy = vi.spyOn(target, 'snapshotTree').mockImplementationOnce(async (path) => {
        entered.open();
        await release.wait();
        return stale ? '0'.repeat(40) : snapshot(path);
      });
      const applying = s.service.applyLspProposal(
        'session_1',
        s.proposal.proposalId,
        s.proposal.hash,
      );
      await entered.wait();
      expect(
        s.service.dismissLspProposal('session_1', s.proposal.proposalId, s.proposal.hash).state,
      ).toBe('dismissed');
      release.open();
      try {
        expect((await applying).state).toBe('dismissed');
        expect(readFileSync(join(s.root, 'a.txt'), 'utf8')).toBe('one\n');
        expect(s.db.prepare('SELECT * FROM file_operations').all()).toHaveLength(0);
      } finally {
        spy.mockRestore();
        s.db.close();
      }
    }
  });
  it('[TC-HAR-018-N] preserves partial writes and recovers uncertain files without replaying them', async () => {
    const s = await proposalSetup({
      rename: async (from, to) => {
        if (String(to).endsWith('/b.txt')) throw new Error('injected IO failure');
        await rename(from, to);
      },
    });
    s.db.prepare("UPDATE runs SET status='succeeded' WHERE id='run_1'").run();
    const result = await s.service.applyLspProposal(
      'session_1',
      s.proposal.proposalId,
      s.proposal.hash,
    );
    expect(result.state).toBe('partial');
    expect(result.outcomes).toEqual([
      { path: 'a.txt', state: 'applied' },
      { path: 'b.txt', state: 'failed' },
    ]);
    expect(readFileSync(join(s.root, 'a.txt'), 'utf8')).toBe('updated\n');
    expect(readFileSync(join(s.root, 'b.txt'), 'utf8')).toBe('target\n');
    s.db.prepare("UPDATE lsp_proposals SET state='applying' WHERE id=?").run(s.proposal.proposalId);
    s.db.prepare("UPDATE file_operations SET state='planned' WHERE path='b.txt'").run();
    const recovered = new WorkspaceService({
      db: s.db,
      clock: new FakeClock(),
      worktreeRoot: dirname(s.root),
      forbidden: [],
    });
    const restored = recovered.lspProposal('session_1', s.proposal.proposalId);
    expect(restored.state).toBe('partial');
    expect(restored.outcomes).toEqual([
      { path: 'a.txt', state: 'applied' },
      { path: 'b.txt', state: 'uncertain' },
    ]);
    await recovered.applyLspProposal('session_1', s.proposal.proposalId, s.proposal.hash);
    expect(s.db.prepare('SELECT * FROM file_operations').all()).toHaveLength(2);
    s.db.close();
  });
  it('[TC-HAR-018-N] a cancelled server reply cannot create a late proposal', async () => {
    let aborted = false;
    const s = await lspSetup('normal', {
      query: async (input) => {
        aborted = true;
        return {
          kind: 'edits',
          actions: [
            {
              title: 'Late',
              edit: {
                changes: {
                  [input.document.uri]: [
                    {
                      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
                      newText: 'late',
                    },
                  ],
                },
              },
            },
          ],
          durationMs: 1,
          truncated: false,
        };
      },
    });
    const input = {
      ...s.input,
      query: { ...s.input.query, operation: 'rename' as const, newName: 'late' },
    };
    const cancellation = {
      get aborted() {
        return aborted;
      },
      onCancel: () => () => {},
    };
    const plan = await s.service.planLsp(input, cancellation);
    await expect(s.service.runLsp(input, plan, plan.fingerprint, cancellation)).rejects.toThrow(
      /cancelled/,
    );
    expect(s.service.lspProposals('session_1')).toEqual([]);
    expect(readFileSync(join(s.root, 'a.txt'), 'utf8')).toBe('one\n');
    s.db.close();
  });
  it('[TC-HAR-010-H] LSP results are relative, pinned and do not create agent write evidence for returned locations', async () => {
    const s = await lspSetup('other_file');
    const plan = await s.service.planLsp(s.input, s.cancellation);
    await expect(s.service.runLsp(s.input, plan, null, s.cancellation)).rejects.toThrow(
      /approval|trust/,
    );
    const result = await s.service.runLsp(s.input, plan, plan.fingerprint, s.cancellation);
    expect(result).toMatchObject({
      serverId: 'fixture',
      configRevision: 1,
      source: { path: 'a.txt', version: 1 },
      result: {
        kind: 'locations',
        locations: [
          {
            path: 'b.txt',
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          },
        ],
      },
    });
    expect(JSON.stringify(result)).not.toContain(s.root);
    await expect(s.call('write_file', { path: 'b.txt', text: 'must read first' })).rejects.toThrow(
      /read.*before/,
    );
    await expect(s.call('write_file', { path: 'a.txt', text: 'must read first' })).rejects.toThrow(
      /read.*before/,
    );
    await expect(
      s.service.planLsp(
        { ...s.input, query: { ...s.input.query, serverId: 'unbound' } },
        s.cancellation,
      ),
    ).rejects.toThrow(/selected|registered/);
  });
  it('[TC-HAR-018-N] LSP cannot return a file URI outside the managed worktree', async () => {
    const s = await lspSetup('out_of_scope');
    const plan = await s.service.planLsp(s.input, s.cancellation);
    await expect(s.service.runLsp(s.input, plan, plan.fingerprint, s.cancellation)).rejects.toThrow(
      /scope|outside/,
    );
  });
  it('[TC-HAR-010-N] a file change during an LSP query invalidates the result', async () => {
    const entered = new Gate(),
      release = new Gate();
    const s = await lspSetup('normal', {
      query: async (input) => {
        entered.open();
        await release.wait();
        return {
          kind: 'locations' as const,
          locations: [
            {
              uri: input.document.uri,
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            },
          ],
          durationMs: 1,
          truncated: false,
        };
      },
    });
    const plan = await s.service.planLsp(s.input, s.cancellation);
    const pending = s.service.runLsp(s.input, plan, plan.fingerprint, s.cancellation);
    const rejected = expect(pending).rejects.toThrow(/changed|stale/);
    await entered.wait();
    writeFileSync(join(s.root, 'a.txt'), 'changed');
    release.open();
    await rejected;
  });
  it('[TC-HAR-010-N] an edit cannot resurrect a deleted original or replace its frozen hash with a later read', async () => {
    for (const kind of ['deleted', 'reread']) {
      const entered = new Gate(),
        release = new Gate();
      const { service, call } = await setup(async () => {
        entered.open();
        await release.wait();
        return { text: 'edited', result: { content: [], details: { diff: '', patch: '' } } };
      });
      const root = service.copyOf('session_1')?.worktree;
      if (!root) throw new Error('no copy');
      await call('read_file', { path: 'a.txt' });
      const pending = call('edit', {
        path: 'a.txt',
        edits: [{ oldText: 'one', newText: 'edited' }],
      });
      const rejected = expect(pending).rejects.toThrow(/changed|missing|precondition/);
      await entered.wait();
      if (kind === 'deleted') rmSync(join(root, 'a.txt'));
      else {
        writeFileSync(join(root, 'a.txt'), 'external');
        await call('read_file', { path: 'a.txt' });
      }
      release.open();
      await rejected;
      if (kind === 'deleted') expect(existsSync(join(root, 'a.txt'))).toBe(false);
      else expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('external');
    }
  });
  it('[TC-HAR-010-H] broker edit preserves BOM and CRLF bytes through the public Pi transformer', async () => {
    const { service, call } = await setup();
    const root = service.copyOf('session_1')?.worktree;
    if (!root) throw new Error('no copy');
    writeFileSync(join(root, 'a.txt'), '\ufeffone\r\ntwo\r\n');
    await call('read_file', { path: 'a.txt' });
    await call('edit', { path: 'a.txt', edits: [{ oldText: 'one', newText: 'ONE' }] });
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('\ufeffONE\r\ntwo\r\n');
  });
  it('[TC-HAR-011-N] cancellation or destination creation after staging cannot be overwritten and temporary files are removed', async () => {
    for (const reason of ['cancel', 'created']) {
      let aborted = false,
        root = '';
      const { service, call } = await setup(undefined, {
        writeFile: async (...args: Parameters<typeof writeFile>) => {
          await writeFile(...args);
          if (reason === 'cancel') aborted = true;
          else writeFileSync(join(root, 'new.txt'), 'external');
        },
      });
      root = service.copyOf('session_1')?.worktree ?? '';
      await call('read_file', { path: 'a.txt' });
      const path = reason === 'cancel' ? 'a.txt' : 'new.txt';
      await expect(
        service.execute(
          {
            name: 'write_file',
            args: { path, text: 'agent' },
            runId: 'run_1',
            executionId: 'exec_1',
            toolCallId: 'write_guard',
          },
          {
            get aborted() {
              return aborted;
            },
            onCancel: () => () => {},
          },
        ),
      ).rejects.toThrow();
      expect(readFileSync(join(root, path), 'utf8')).toBe(
        reason === 'cancel' ? 'one\n' : 'external',
      );
      expect(
        (await service.listFiles({ kind: 'session', id: 'session_1' })).files.some((file) =>
          file.path.includes('.corral-'),
        ),
      ).toBe(false);
    }
  });
  it('[TC-HAR-011-N] a successful file replacement with failed bookkeeping stays uncertain, not failed', async () => {
    const { service, call, db } = await setup();
    await call('read_file', { path: 'a.txt' });
    db.exec(
      "CREATE TRIGGER reject_applied BEFORE UPDATE ON file_operations WHEN NEW.state = 'applied' BEGIN SELECT RAISE(ABORT, 'test recording failed'); END;",
    );
    await expect(
      call('write_file', { path: 'a.txt', text: 'physically changed' }),
    ).rejects.toThrow();
    expect((db.prepare('SELECT state FROM file_operations').get() as { state: string }).state).toBe(
      'uncertain',
    );
    expect(readFileSync(join(service.copyOf('session_1')?.worktree ?? '', 'a.txt'), 'utf8')).toBe(
      'physically changed',
    );
  });
  it('[TC-HAR-012-N] automatic checks enforce pinned selection, exact fingerprint approval, owner and stale-tree rejection', async () => {
    const { service, call } = await setup();
    await service.configure('default', {
      verifyCommands: [
        {
          id: 'ok',
          name: 'OK',
          argv: [process.execPath, '-e', 'process.exit(0)'],
          timeoutMs: 10000,
        },
      ],
    });
    const config = service.projectTools.latest('default');
    if (!config) throw new Error('missing config');
    const selection = {
      projectId: 'default',
      revision: config.revision,
      hash: config.hash,
      checkIds: ['ok'],
      lspServerIds: [],
    };
    const context = {
      runId: 'run_1',
      executionId: 'exec_1',
      attemptNo: 1,
      effectId: 'effect_check',
      selection,
      commandId: 'ok',
    };
    const cancellation = { aborted: false, onCancel: () => () => {} };
    const plan = await service.planCheck(context, cancellation);
    expect(plan.trusted).toBe(false);
    await expect(service.runCheck(context, plan, null, cancellation)).rejects.toThrow(
      /approval|trust/,
    );
    await expect(
      service.planCheck({ ...context, commandId: 'unknown' }, cancellation),
    ).rejects.toThrow(/selected|registered/);
    await expect(service.runCheck(context, plan, 'f'.repeat(64), cancellation)).rejects.toThrow(
      /approval|fingerprint/,
    );
    const report = await service.runCheck(context, plan, plan.fingerprint, cancellation);
    expect(report).toMatchObject({
      owner: {
        kind: 'execution',
        runId: 'run_1',
        executionId: 'exec_1',
        attemptNo: 1,
        effectId: 'effect_check',
      },
      state: 'completed',
      verdict: 'pass',
      stale: false,
    });
    await expect(service.runCheck(context, plan, plan.fingerprint, cancellation)).rejects.toThrow(
      /already|duplicate/,
    );
    service.projectTools.setTrust(
      { projectId: 'default', kind: 'check', id: 'ok', fingerprint: plan.fingerprint },
      true,
    );
    const trusted = await service.planCheck(context, cancellation);
    expect(trusted.trusted).toBe(true);
    service.projectTools.setTrust(
      { projectId: 'default', kind: 'check', id: 'ok', fingerprint: plan.fingerprint },
      false,
    );
    await expect(service.runCheck(context, trusted, null, cancellation)).rejects.toThrow(
      /trust|approval/,
    );
    await call('read_file', { path: 'a.txt' });
    await call('write_file', { path: 'a.txt', text: 'new tree' });
    await expect(service.runCheck(context, plan, plan.fingerprint, cancellation)).rejects.toThrow(
      /tree|changed/,
    );
  });
  it('[TC-HAR-013-H] manual checks use owned frozen copies and retain separate state and verdict', async () => {
    const { service, call, db } = await setup();
    await service.configure('default', {
      verifyCommands: [
        {
          id: 'copy',
          name: 'Copy check',
          argv: [
            process.execPath,
            '-e',
            "require('fs').writeFileSync('a.txt','changed only by check'); console.log('checked');",
          ],
          timeoutMs: 10000,
        },
      ],
    });
    const id = await service.verify('session_1', 'default', 'copy');
    const report = await service.waitVerification(id);
    expect(report).toMatchObject({
      owner: { kind: 'manual', sessionId: 'session_1' },
      state: 'completed',
      verdict: 'inconclusive',
      targetUnchanged: false,
      cleanupConfirmed: true,
    });
    expect(await call('read_file', { path: 'a.txt' })).toMatchObject({ text: 'one\n' });
    const before = service.verifications('session_1', await service.currentTree('session_1'))[0];
    expect(before).toMatchObject({ state: 'error', stale: false, report });
    await call('write_file', { path: 'a.txt', text: 'changed after check' });
    expect(
      service.verifications('session_1', await service.currentTree('session_1'))[0],
    ).toMatchObject({ stale: true });
    expect(db.prepare('SELECT report_json FROM verifications WHERE id = ?').get(id)).toBeTruthy();
  });
  it('[TC-HAR-012-N] manual cancellation is session scoped and shutdown drains owned checks', async () => {
    const { service } = await setup();
    await service.configure('default', {
      verifyCommands: [
        {
          id: 'wait',
          name: 'Wait',
          argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'],
          timeoutMs: 10000,
        },
      ],
    });
    const id = await service.verify('session_1', 'default', 'wait');
    expect(() => service.cancelVerification('other_session', id)).toThrow();
    service.cancelVerification('session_1', id);
    expect(await service.waitVerification(id)).toMatchObject({
      state: 'cancelled',
      verdict: 'not_evaluated',
    });
    const next = await service.verify('session_1', 'default', 'wait');
    await service.dispose();
    expect(await service.waitVerification(next)).toMatchObject({
      state: 'cancelled',
      verdict: 'not_evaluated',
    });
  });
  it('[TC-HAR-012-H] existing workspace settings write immutable check revisions and read their authority', async () => {
    const { service, db } = await setup();
    const check = { id: 'types', name: 'Types', argv: ['node', 'check.mjs'], timeoutMs: 10000 };
    await service.configure('default', { verifyCommands: [check] });
    const store = new SqliteProjectToolStore(db, new FakeClock());
    const first = store.latest('default');
    expect(first).toMatchObject({ checks: [check] });
    await service.configure('default', { verifyCommands: [] });
    expect(store.latest('default')?.revision).toBe((first?.revision ?? 0) + 1);
    expect(store.get('default', first?.revision ?? 0)?.checks).toEqual([check]);
    db.prepare('UPDATE workspace_bindings SET verify_json = ?').run(JSON.stringify([check]));
    expect((await service.view('default'))?.verifyCommands).toEqual([]);
    await expect(
      service.configure('default', { verifyCommands: [{ ...check, argv: [] }] }),
    ).rejects.toThrow();
    expect(store.latest('default')?.checks).toEqual([]);
  });
  it('[TC-HAR-010-N] cancellation or an external change during edit calculation leaves the file untouched', async () => {
    for (const cause of ['cancel', 'changed']) {
      const entered = new Gate();
      const release = new Gate();
      let aborted = false;
      const { service, call, db } = await setup(async () => {
        entered.open();
        await release.wait();
        return {
          text: 'two\n',
          result: {
            content: [{ type: 'text', text: 'Changed.' }],
            details: { diff: 'diff', patch: 'patch', firstChangedLine: 1 },
          },
        };
      });
      await call('read_file', { path: 'a.txt' });
      const root = (
        service as unknown as { worktree(id: string): { worktree_path: string } }
      ).worktree('session_1').worktree_path;
      const pending = service.execute(
        {
          name: 'edit',
          args: { path: 'a.txt', edits: [{ oldText: 'one', newText: 'two' }] },
          runId: 'run_1',
          executionId: 'exec_1',
          toolCallId: 'tool_edit',
        },
        {
          get aborted() {
            return aborted;
          },
          onCancel: () => () => {},
        },
      );
      const rejected = expect(pending).rejects.toThrow(
        cause === 'cancel' ? /cancelled/ : /changed since/,
      );
      await entered.wait();
      if (cause === 'cancel') aborted = true;
      else writeFileSync(join(root, 'a.txt'), 'external\n');
      release.open();
      await rejected;
      expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe(
        cause === 'cancel' ? 'one\n' : 'external\n',
      );
      expect(db.prepare('SELECT COUNT(*) AS n FROM file_operations').get()).toEqual({ n: 0 });
    }
  });
  it('[TC-HAR-010-H] Pi edit and write use the same read evidence and recorded atomic write path', async () => {
    const { call, db } = await setup();
    await call('read_file', { path: 'a.txt' });
    const edit = await call('edit', { path: 'a.txt', edits: [{ oldText: 'one', newText: 'two' }] });
    expect(edit).toMatchObject({
      path: 'a.txt',
      piResult: {
        content: [{ type: 'text', text: 'Successfully replaced 1 block(s) in a.txt.' }],
        details: { firstChangedLine: 1 },
      },
    });
    expect(await call('read_file', { path: 'a.txt' })).toMatchObject({ text: 'two\n' });
    await call('write', { path: 'new.txt', content: 'A new file.' });
    expect(await call('read_file', { path: 'new.txt' })).toMatchObject({ text: 'A new file.' });
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM file_operations WHERE state = 'applied'").get(),
    ).toEqual({ n: 2 });
  });
  it('[TC-HAR-010-N] all edit blocks must validate before any bytes are changed', async () => {
    const { call, db } = await setup();
    await call('read_file', { path: 'a.txt' });
    await expect(
      call('edit', {
        path: 'a.txt',
        edits: [
          { oldText: 'one', newText: 'two' },
          { oldText: 'missing', newText: 'three' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'SCHEMA_INVALID', message: expect.stringContaining('a.txt') });
    expect(await call('read_file', { path: 'a.txt' })).toMatchObject({ text: 'one\n' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM file_operations').get()).toEqual({ n: 0 });
  });
  it('[TC-HAR-011-N] a different execution or restarted attempt cannot borrow another execution’s read', async () => {
    const { call } = await setup();
    await call('read_file', { path: 'a.txt' }, 'exec_a');
    await expect(
      call('write_file', { path: 'a.txt', text: 'unread overwrite' }, 'exec_b'),
    ).rejects.toThrow(/read a.txt/);
    await expect(call('delete_file', { path: 'a.txt' }, 'exec_a_retry')).rejects.toThrow(
      /read a.txt/,
    );
  });
  it('[TC-HAR-011-H] [TC-HAR-011-N] B writing after A reads does not refresh A’s evidence', async () => {
    const { call } = await setup();
    await call('read_file', { path: 'a.txt' }, 'exec_a');
    await call('read_file', { path: 'a.txt' }, 'exec_b');
    await call('write_file', { path: 'a.txt', text: 'B changed this\n' }, 'exec_b');
    await expect(
      call('write_file', { path: 'a.txt', text: 'A stale change\n' }, 'exec_a'),
    ).rejects.toThrow(/changed since/);
    await call('read_file', { path: 'a.txt' }, 'exec_a');
    await expect(
      call('write_file', { path: 'a.txt', text: 'A reviewed change\n' }, 'exec_a'),
    ).resolves.toMatchObject({ created: false });
  });
  it('[DW-05] browsing stays inside its project or session and does not grant an agent a read', async () => {
    const { service, call, original } = await setup();
    const scope = { kind: 'project' as const, id: 'default' };
    mkdirSync(join(original, 'nested'));
    writeFileSync(join(original, 'nested', 'plain.txt'), 'hello');
    writeFileSync(join(original, 'binary.dat'), Buffer.from([0, 1, 2]));
    writeFileSync(join(original, 'large.txt'), 'x'.repeat(1024 * 1024 + 1));
    symlinkSync('/etc', join(original, 'outside'));
    const listed = await service.listFiles(scope);
    expect(listed.files.map((f) => f.path)).toEqual(
      expect.arrayContaining(['a.txt', 'nested/plain.txt']),
    );
    expect(
      listed.files.some((f) => f.path.startsWith('.git/') || f.path.startsWith('outside/')),
    ).toBe(false);
    await expect(service.readFile(scope, 'nested/plain.txt')).resolves.toMatchObject({
      content: { kind: 'text', text: 'hello' },
    });
    await expect(service.readFile(scope, 'binary.dat')).resolves.toMatchObject({
      content: { kind: 'binary' },
    });
    await expect(service.readFile(scope, 'large.txt')).resolves.toMatchObject({
      content: { kind: 'too_large' },
    });
    for (const bad of ['../a.txt', '/etc/passwd', '.git/config', 'outside/passwd']) {
      await expect(service.readFile(scope, bad)).rejects.toThrow();
    }
    await expect(service.listFiles(scope, 'outside')).rejects.toThrow();
    await expect(
      service.readFile({ kind: 'session', id: 'session_1' }, 'a.txt'),
    ).resolves.toMatchObject({ content: { kind: 'text', text: 'one\n' } });
    await expect(call('write_file', { path: 'a.txt', text: 'two' })).rejects.toThrow(/read a.txt/);
    await expect(service.readFile({ kind: 'project', id: 'missing' }, 'a.txt')).rejects.toThrow();
    rmSync(original, { recursive: true });
    await expect(service.listFiles(scope)).rejects.toThrow();
  });

  it('refuses paths that leave the copy, reach .git or .corral, or are absolute', () => {
    for (const bad of [
      '../x',
      'a/../../x',
      '/etc/passwd',
      '.git/config',
      'sub/.GIT/x',
      '.corral/corral.db',
      'a\\b',
    ]) {
      expect(() => safeRelative(bad)).toThrow();
    }
    expect(safeRelative('./src//a.ts')).toBe('src/a.ts');
  });

  it('[WB-WSP-004] changes an existing file only as this run read it', async () => {
    const { service, call } = await setup();
    await expect(call('write_file', { path: 'a.txt', text: 'two\n' })).rejects.toThrow(
      /read a.txt/,
    );
    await call('read_file', { path: 'a.txt' });
    const root = (
      service as unknown as { worktree(id: string): { worktree_path: string } }
    ).worktree('session_1').worktree_path;
    writeFileSync(join(root, 'a.txt'), 'edited by someone else\n');
    await expect(call('write_file', { path: 'a.txt', text: 'two\n' })).rejects.toThrow(
      /changed since/,
    );
    await call('read_file', { path: 'a.txt' });
    await expect(call('write_file', { path: 'a.txt', text: 'two\n' })).resolves.toMatchObject({
      created: false,
    });
    await expect(call('write_file', { path: 'new/b.txt', text: 'b' })).resolves.toMatchObject({
      created: true,
    });
    symlinkSync('/etc', join(root, 'link'));
    await expect(call('write_file', { path: 'link/x', text: 'x' })).rejects.toThrow(
      /symbolic link/,
    );
  });

  it('[WB-WSP-005] a write planned before a stop is uncertain afterwards, never redone', async () => {
    const { db } = await setup();
    db.prepare(
      `INSERT INTO file_operations VALUES ('op_1', 'session_1', 'run_1', 'exec_1', 'tool_1', 'write',
         'a.txt', NULL, NULL, 'h', 'planned', NULL, 'x', 'x')`,
    ).run();
    new WorkspaceService({ db, clock: new FakeClock(), worktreeRoot: temp(), forbidden: [] });
    expect(db.prepare("SELECT state FROM file_operations WHERE id = 'op_1'").get()).toEqual({
      state: 'uncertain',
    });
  });
});

describe('path search for `@` references (CR-016)', () => {
  it('[TC-REF-010-H] finds files and folders by fuzzy name, file names first, without reading them', async () => {
    const { service, original } = await setup();
    const scope = { kind: 'project' as const, id: 'default' };
    mkdirSync(join(original, 'src', 'pages'), { recursive: true });
    writeFileSync(join(original, 'src', 'pages', 'SessionPage.tsx'), 'x');
    writeFileSync(join(original, 'src', 'session.ts'), 'x');
    mkdirSync(join(original, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(original, 'node_modules', 'dep', 'session.js'), 'x');
    writeFileSync(join(original, '.gitignore'), 'node_modules\n');
    symlinkSync('/etc', join(original, 'outside'));
    const found = await service.searchPaths(scope, 'sesspage', 10);
    expect(found.items[0]).toEqual({ path: 'src/pages/SessionPage.tsx', kind: 'file' });
    const folders = await service.searchPaths(scope, 'pages', 10);
    expect(folders.items).toContainEqual({ path: 'src/pages', kind: 'folder' });
    const all = await service.searchPaths(scope, 'session', 50);
    expect(all.items.some((i) => i.path.startsWith('node_modules'))).toBe(false);
    expect(all.items.some((i) => i.path.startsWith('outside') || i.path.startsWith('.git'))).toBe(
      false,
    );
    expect((await service.searchPaths(scope, 'session', 1)).items).toHaveLength(1);
    expect((await service.searchPaths(scope, 'zzzz', 10)).items).toEqual([]);
  });

  it('[TC-REF-011-F] searches only registered scopes', async () => {
    const { service } = await setup();
    await expect(service.searchPaths({ kind: 'project', id: 'missing' }, 'a', 5)).rejects.toThrow();
    await expect(
      service.searchPaths({ kind: 'session', id: 'session_1' }, 'a', 5),
    ).resolves.toMatchObject({ items: [{ path: 'a.txt', kind: 'file' }] });
  });
});

describe('review, applying and reverting (CR-013)', () => {
  it('[WB-REV-004/005] applies the approved tree, skips or refuses conflicts, and reverts only what is unchanged', async () => {
    const { db, service, call, original } = await setup();
    const { ReviewService } = await import('../src/files/review.ts');
    const review = new ReviewService({ db, clock: new FakeClock(), files: service });
    await call('read_file', { path: 'a.txt' });
    await call('write_file', { path: 'a.txt', text: 'two\n' });
    await call('write_file', { path: 'b.txt', text: 'bee\n' });
    await call('write_file', { path: 'c.txt', text: 'sea\n' });
    const copy = service.copyOf('session_1');
    if (!copy) throw new Error('no copy');
    const to = (await service.latestTree('session_1')) as string;

    // A comment fixed to these trees, sent as a batch.
    const comment = review.addComment('session_1', {
      from: copy.baseTree,
      to,
      path: 'a.txt',
      side: 'after',
      startLine: 1,
      endLine: 1,
      quote: 'two',
      body: 'Say three instead.',
    });
    expect(review.batchText('session_1', [comment.commentId])).toContain('a.txt lines 1–1');
    review.recordBatch('session_1', {
      commentIds: [comment.commentId],
      intent: 'next',
      runId: 'run_2',
      executionId: null,
      text: 'x',
      sent: true,
      detail: null,
    });
    expect(review.comments('session_1')[0]?.state).toBe('submitted');

    // c.txt already exists in the folder with other content: a conflict, never overwritten.
    writeFileSync(join(original, 'c.txt'), 'mine\n');
    const decisionId = review.decide('session_1', {
      from: copy.baseTree,
      to,
      decision: 'approved',
      note: '',
    });
    const plan = await review.plan('session_1', decisionId);
    expect(Object.fromEntries(plan.map((p) => [p.path, p.outcome]))).toEqual({
      'a.txt': 'apply',
      'b.txt': 'apply',
      'c.txt': 'conflict',
    });
    const applied = await review.integrate('session_1', decisionId);
    expect(applied.state).toBe('partial');
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(join(original, 'a.txt'), 'utf8')).toBe('two\n');
    expect(readFileSync(join(original, 'b.txt'), 'utf8')).toBe('bee\n');
    expect(readFileSync(join(original, 'c.txt'), 'utf8')).toBe('mine\n');

    // A person edits b.txt afterwards: reverting leaves it, and undoes a.txt.
    writeFileSync(join(original, 'b.txt'), 'edited\n');
    const reverted = await review.revert('session_1', applied.integrationId);
    expect(Object.fromEntries(reverted.files.map((f) => [f.path, f.outcome]))).toEqual({
      'a.txt': 'reverted',
      'b.txt': 'revert_conflict',
      'c.txt': 'conflict',
    });
    expect(readFileSync(join(original, 'a.txt'), 'utf8')).toBe('one\n');
    expect(readFileSync(join(original, 'b.txt'), 'utf8')).toBe('edited\n');

    // Decisions go stale when the copy changes; unreviewed writes show in the inbox.
    await call('write_file', { path: 'd.txt', text: 'dee\n' });
    expect((await review.decisions('session_1'))[0]?.stale).toBe(true);
    const inbox = review.inbox(
      [{ sessionId: 'session_1', title: 't', entries: [{ state: 'queued', text: 'next' }] }],
      [{ runId: 'run_1', status: 'awaiting_user', sessionId: 'session_1' }],
    );
    expect(inbox.map((i) => i.kind).sort()).toEqual([
      'decision',
      'integration',
      'queued',
      'unreviewed',
    ]);
    db.prepare(
      "UPDATE runs SET projection_json = json_object('statusReason','review_recipe:attempt_limit') WHERE id = 'run_1'",
    ).run();
    expect(
      review.inbox(
        [{ sessionId: 'session_1', title: 't', entries: [] }],
        [{ runId: 'run_1', status: 'failed', sessionId: 'session_1' }],
      ),
    ).toContainEqual({
      kind: 'recipe_stopped',
      sessionId: 'session_1',
      sessionTitle: 't',
      runId: 'run_1',
      detail: 'attempt_limit',
    });
    expect(
      review
        .inbox(
          [{ sessionId: 'session_1', title: 't', entries: [] }],
          [
            { runId: 'newer', status: 'succeeded', sessionId: 'session_1' },
            { runId: 'run_1', status: 'failed', sessionId: 'session_1' },
          ],
        )
        .some((item) => item.kind === 'recipe_stopped'),
    ).toBe(false);
  });
});

describe('missing folders (02-UX-Spec §8)', () => {
  it('says when the linked folder or the working copy is gone, instead of failing', async () => {
    const { service, original } = await setup();
    const copy = service.copyOf('session_1');
    if (!copy) throw new Error('no copy');
    rmSync(copy.worktree, { recursive: true, force: true });
    expect(service.worktreeView('session_1')?.missing).toBe(true);
    rmSync(original, { recursive: true, force: true });
    expect((await service.view('default'))?.missing).toBe(true);
  });
});

describe('the linked folder as Git sees it (02-UX-Spec §4)', () => {
  it('lists tracked changes against HEAD and untracked files, and reads the disk side', async () => {
    const { service, original } = await setup();
    writeFileSync(join(original, 'a.txt'), 'one\nmore\n');
    writeFileSync(join(original, 'new.txt'), 'fresh\n');
    const changes = await service.folderChanges('default');
    expect(changes.files.map((f) => [f.path, f.status])).toEqual([
      ['a.txt', 'modified'],
      ['new.txt', 'added'],
    ]);
    const versions = await service.folderFileVersions('default', 'a.txt');
    expect(versions.before).toEqual({ kind: 'text', text: 'one\n' });
    expect(versions.after).toEqual({ kind: 'text', text: 'one\nmore\n' });
  });
});
