import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '@corral/storage-sqlite';
import { FakeClock, Gate } from '@corral/testkit';
import { expect, it, vi } from 'vitest';
import { WorkspaceService } from '../src/files/service.ts';
import { WorkspaceAccessStore } from '../src/files/workspace-access.ts';

// Match the existing real-Git file suite; this is a runaway limit, not a latency assertion.
vi.setConfig({ testTimeout: 30_000 });

it.each(['before', 'after'] as const)(
  '[TC-WBD-001-N] reader queued %s writer pin records the writer input after the mutation lease ends',
  async (timing) => {
    const root = mkdtempSync(join(tmpdir(), 'corral-reader-reservation-'));
    const original = join(root, 'original');
    execFileSync('git', ['init', '-q', original]);
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], {
        cwd: original,
      });
    writeFileSync(join(original, 'example.txt'), 'before\n');
    git('add', '.');
    git('commit', '-qm', 'initial');
    const db = openDatabase(':memory:');
    const service = new WorkspaceService({
      db,
      clock: new FakeClock(),
      worktreeRoot: join(root, 'copies'),
      forbidden: [],
    });
    const entered = new Gate();
    const finish = new Gate();
    try {
      await service.bind('default', original);
      await service.configure('default', { trusted: true });
      db.exec(`INSERT INTO work_sessions
        (id,project_id,corral_id,title,objective,pinned,revision,created_at,updated_at,entries_json)
        VALUES('session_one','default',NULL,'Example','',0,1,'x','x','[]');
        INSERT INTO runs
        (id,corral_id,definition_hash,snapshot_json,status,last_seq,projection_json,started_at,project_id,session_id)
        VALUES('reader','c','h','{}','running',0,'{}','x','default','session_one');`);
      await service.createWorktree('session_one', 'default');
      const copy = service.copyOf('session_one');
      const before = await service.currentTree('session_one');
      if (!copy || !before) throw new Error('working copy baseline missing');
      const access = new WorkspaceAccessStore(db);
      const writer = { kind: 'user', id: 'save' } as const;
      access.acquire(writer, 'session_one', copy.worktree, true, 1);
      // A user mutation owns this lease until its receipt releases the writer.
      const mutation = (
        service as unknown as { lease(path: string, work: () => Promise<void>): Promise<void> }
      ).lease(copy.worktree, async () => {
        if (timing === 'after') access.pin(writer, before);
        entered.open();
        await finish.wait();
        if (timing === 'before') access.pin(writer, before);
        writeFileSync(join(copy.worktree, 'example.txt'), 'after\n');
        access.release(writer, true);
      });
      await entered.wait();
      service.acquireRun('reader', 'session_one', false);
      const prepared = service.prepareRun('reader');
      finish.open();
      await Promise.all([mutation, prepared]);

      expect(await service.startBaseline('reader')).toBe(before);
      expect(
        db.prepare("SELECT tree FROM run_snapshots WHERE run_id='reader' AND phase='start'").get(),
      ).toEqual({ tree: before });
      expect(service.runStartFiles('reader')?.tree).toBe(before);
      expect((await service.readPreviewSnapshot('reader', 'example.txt'))?.toString()).toBe(
        'before\n',
      );
    } finally {
      finish.open();
      await service.dispose();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
