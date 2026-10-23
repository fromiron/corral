import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '@corral/storage-sqlite';
import { FakeClock } from '@corral/testkit';
import { expect, it } from 'vitest';
import { WorkspaceService } from '../src/files/service.ts';
import { WorkspaceAccessStore } from '../src/files/workspace-access.ts';

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'corral-concurrent-'));
  const db = openDatabase(':memory:');
  const original = join(root, 'original');
  execFileSync('git', ['init', '-q', original]);
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], { cwd: original });
  writeFileSync(join(original, 'a.txt'), 'before\n');
  git('add', '.');
  git('commit', '-qm', 'first');
  const service = new WorkspaceService({
    db,
    clock: new FakeClock(),
    worktreeRoot: join(root, 'copies'),
    forbidden: [],
  });
  const cancel = { aborted: false, onCancel: () => () => {} };
  await service.bind('default', original);
  await service.configure('default', { trusted: true });
  for (const id of ['s1', 's2']) {
    db.prepare(
      "INSERT INTO work_sessions(id,project_id,corral_id,title,objective,pinned,revision,created_at,updated_at,entries_json) VALUES(?,'default',NULL,'t','',0,1,'x','x','[]')",
    ).run(id);
    await service.createWorktree(id, 'default');
  }
  return { root, db, service, cancel };
}

it('[TC-ABS-006-H] [TC-ABS-006-N] parallel reader pins writer input; same tree rejects second writer; other tree proceeds', async () => {
  const { root, db, service, cancel } = await setup();
  try {
    for (const [id, sessionId] of [
      ['writer', 's1'],
      ['reader', 's1'],
      ['other', 's2'],
    ]) {
      db.prepare(
        "INSERT INTO runs(id,corral_id,definition_hash,snapshot_json,status,last_seq,projection_json,started_at,project_id,session_id) VALUES(?,'c','h','{}','running',0,'{}','x','default',?)",
      ).run(id, sessionId);
    }
    expect(service.hasPendingProcesses()).toBe(false);
    const firstRead = service.currentTree('s1');
    const queuedRead = service.currentTree('s1');
    expect(service.hasPendingProcesses()).toBe(true);
    await firstRead;
    expect(service.hasPendingProcesses()).toBe(true);
    await queuedRead;
    expect(service.hasPendingProcesses()).toBe(false);
    service.acquireRun('writer', 's1', true);
    const preparation = service.prepareRun('writer');
    expect(service.hasPendingProcesses()).toBe(true);
    await preparation;
    expect(service.hasPendingProcesses()).toBe(false);
    const copy = service.copyOf('s1');
    if (!copy) throw new Error('working copy missing');
    writeFileSync(join(copy.worktree, 'a.txt'), 'intermediate writer bytes\n');
    service.acquireRun('reader', 's1', false);
    service.acquireRun('other', 's2', true);
    await service.prepareRun('reader');
    expect(() => service.acquireRun('conflict', 's1', true)).toThrow(/writer/);
    const input = {
      name: 'read_file' as const,
      runId: 'reader',
      executionId: 'e',
      toolCallId: 't',
      args: { path: 'a.txt' },
    };
    expect(await service.execute(input, cancel)).toMatchObject({ text: 'before\n' });
    expect((await service.readPreviewSnapshot('reader', 'a.txt'))?.toString()).toBe('before\n');
    expect(await service.readPreviewSnapshot('writer', 'a.txt')).toBeNull();
    expect(await service.currentTreeForRun('reader')).toBe(await service.startBaseline('writer'));
    const ending = service.snapshotRun('reader', 's1', 'end');
    expect(service.hasPendingProcesses()).toBe(true);
    expect(await ending).toBe(await service.startBaseline('reader'));
    expect(service.hasPendingProcesses()).toBe(false);
    await expect(
      service.execute(
        { ...input, name: 'write_file', args: { path: 'a.txt', text: 'bad' } },
        cancel,
      ),
    ).rejects.toThrow(/promoted/);
    service.releaseRun('writer', false);
    expect(service.hasUnsafeWorktreeOwner('s1')).toBe(true);
    await expect(service.execute({ ...input, runId: 'writer' }, cancel)).rejects.toThrow(
      /no longer active/,
    );
    expect(() => service.acquireRun('later', 's1', true)).toThrow();
    service.releaseRun('other', true);
    expect(() => service.acquireRun('next', 's2', true)).not.toThrow();
    // No external worker or command exists in this fixture; explicit recovery may release it.
    service.confirmWorkerRecovery();
    expect(service.hasUnsafeWorktreeOwner('s1')).toBe(false);
    expect(() => service.acquireRun('recovered', 's1', true)).not.toThrow();
  } finally {
    await service.dispose();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('[TC-WBD-001-H] [TC-WBD-001-N] Run readers use a human writer input tree and worker recovery retains human ownership', async () => {
  const { root, db, service, cancel } = await setup();
  try {
    const access = new WorkspaceAccessStore(db);
    const owner = { kind: 'user', id: 'human_save' } as const;
    const copy = service.copyOf('s1');
    const view = service.worktreeView('s1');
    const before = await service.currentTree('s1');
    if (!copy || !view || !before) throw new Error('working copy baseline missing');
    access.acquire(owner, 's1', copy.worktree, true, view.copyGeneration);
    access.pin(owner, before);
    expect(service.hasUnsafeWorktreeOwner('s1')).toBe(true);
    expect(() => service.acquireRun('writer_conflict', 's1', true)).toThrow(/writer/);
    writeFileSync(join(copy.worktree, 'a.txt'), 'human write in progress\n');
    db.prepare(
      "INSERT INTO runs(id,corral_id,definition_hash,snapshot_json,status,last_seq,projection_json,started_at,project_id,session_id) VALUES('human_reader','c','h','{}','running',0,'{}','x','default','s1')",
    ).run();
    service.acquireRun('human_reader', 's1', false);
    await service.prepareRun('human_reader');
    expect(
      await service.execute(
        {
          name: 'read_file',
          runId: 'human_reader',
          executionId: 'e',
          toolCallId: 't',
          args: { path: 'a.txt' },
        },
        cancel,
      ),
    ).toMatchObject({ text: 'before\n' });
    service.releaseRun('human_reader', false);
    access.release(owner, false);
    service.confirmWorkerRecovery();
    expect(access.get({ kind: 'run', id: 'human_reader' })?.state).toBe('released');
    expect(access.get(owner)?.state).toBe('uncertain');
    expect(() => service.acquireRun('blocked_after_recovery', 's1', true)).toThrow(/writer/);
    await expect(service.removeWorktree('s1')).rejects.toThrow(/owner|access/);
  } finally {
    await service.dispose();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
