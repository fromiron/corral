import { realpathSync } from 'node:fs';
import { ToolRefusal } from '@corral/core';
import type { Db } from '@corral/storage-sqlite';

export interface RunAccess {
  run_id: string;
  session_id: string;
  worktree_key: string;
  writer: number;
  state: 'active' | 'released' | 'uncertain';
  tree: string | null;
}

/** Durable reservations precede the run record; no worker can start before it owns a slot. */
export class RunAccessStore {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  recover() {
    this.db.prepare("UPDATE run_access SET state='uncertain' WHERE state='active'").run();
  }

  get(runId: string): RunAccess | undefined {
    return this.db.prepare('SELECT * FROM run_access WHERE run_id=?').get(runId) as
      | RunAccess
      | undefined;
  }

  writerAt(key: string): RunAccess | undefined {
    return this.db
      .prepare(
        "SELECT * FROM run_access WHERE worktree_key=? AND writer=1 AND state IN ('active','uncertain')",
      )
      .get(key) as RunAccess | undefined;
  }

  acquire(runId: string, sessionId: string, path: string, writer: boolean) {
    const real = realpathSync.native(path);
    const key = process.platform === 'win32' ? real.toLowerCase() : real;
    this.db
      .transaction(() => {
        const prior = this.get(runId);
        if (prior) {
          if (
            prior.session_id !== sessionId ||
            prior.worktree_key !== key ||
            prior.writer !== Number(writer) ||
            prior.state !== 'active'
          )
            throw new ToolRefusal('REVISION_CONFLICT', 'run file access changed');
          return;
        }
        const owner = this.writerAt(key);
        if (writer && owner)
          throw new ToolRefusal(
            'RUN_ALREADY_ACTIVE',
            `working copy writer ${owner.run_id} has not released ownership`,
          );
        if (owner?.state === 'uncertain')
          throw new ToolRefusal('RESOURCE_CAPACITY', 'working copy termination is unconfirmed');
        this.db
          .prepare(
            'INSERT INTO run_access(run_id,session_id,worktree_key,writer,state,tree) VALUES(?,?,?,?,?,NULL)',
          )
          .run(runId, sessionId, key, Number(writer), 'active');
      })
      .immediate();
  }

  pin(runId: string, tree: string) {
    const access = this.get(runId);
    if (access?.state !== 'active')
      throw new ToolRefusal('TARGET_TERMINAL', 'run file access is no longer active');
    if (access.tree && access.tree !== tree)
      throw new ToolRefusal('REVISION_CONFLICT', 'run input tree is already pinned');
    this.db.prepare('UPDATE run_access SET tree=? WHERE run_id=?').run(tree, runId);
  }

  release(runId: string, confirmed: boolean) {
    // Once uncertain, only explicit runtime recovery may return the working copy.
    this.db
      .prepare("UPDATE run_access SET state=? WHERE run_id=? AND state='active'")
      .run(confirmed ? 'released' : 'uncertain', runId);
  }
}
