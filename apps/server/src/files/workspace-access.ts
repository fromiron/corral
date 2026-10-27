import { realpathSync } from 'node:fs';
import { ToolRefusal } from '@corral/core';
import type { Db } from '@corral/storage-sqlite';

export type WorkspaceOwner = { kind: 'run' | 'user'; id: string };
export interface WorkspaceAccess {
  owner_kind: WorkspaceOwner['kind'];
  owner_id: string;
  session_id: string;
  worktree_key: string;
  copy_generation: number;
  writer: number;
  state: 'active' | 'released' | 'uncertain';
  tree: string | null;
}

/** One durable writer reservation covers both Run and human effects. */
export class WorkspaceAccessStore {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  recover() {
    this.db.prepare("UPDATE workspace_access SET state='uncertain' WHERE state='active'").run();
  }

  get(owner: WorkspaceOwner): WorkspaceAccess | undefined {
    return this.db
      .prepare('SELECT * FROM workspace_access WHERE owner_kind=? AND owner_id=?')
      .get(owner.kind, owner.id) as WorkspaceAccess | undefined;
  }

  writerAt(key: string): WorkspaceAccess | undefined {
    return this.db
      .prepare(
        "SELECT * FROM workspace_access WHERE worktree_key=? AND writer=1 AND state IN ('active','uncertain')",
      )
      .get(key) as WorkspaceAccess | undefined;
  }

  ownersAt(key: string): WorkspaceAccess[] {
    return this.db
      .prepare(
        "SELECT * FROM workspace_access WHERE worktree_key=? AND state IN ('active','uncertain') ORDER BY owner_kind,owner_id",
      )
      .all(key) as WorkspaceAccess[];
  }

  acquire(
    owner: WorkspaceOwner,
    sessionId: string,
    path: string,
    writer: boolean,
    copyGeneration: number,
  ) {
    const real = realpathSync.native(path);
    const key = process.platform === 'win32' ? real.toLowerCase() : real;
    this.db
      .transaction(() => {
        const prior = this.get(owner);
        if (prior) {
          if (
            prior.session_id !== sessionId ||
            prior.worktree_key !== key ||
            prior.copy_generation !== copyGeneration ||
            prior.writer !== Number(writer) ||
            prior.state !== 'active'
          )
            throw new ToolRefusal('REVISION_CONFLICT', 'working copy access changed');
          return;
        }
        const held = this.writerAt(key);
        if (writer && held) {
          const operation =
            held.owner_kind === 'user'
              ? (this.db
                  .prepare('SELECT kind FROM workbench_operations WHERE operation_id=?')
                  .get(held.owner_id) as { kind: string } | undefined)
              : undefined;
          throw new ToolRefusal(
            'RUN_ALREADY_ACTIVE',
            operation?.kind === 'development'
              ? 'finish shared development before starting this exclusive writer'
              : `working copy ${operation?.kind === 'terminal' ? 'terminal ' : ''}writer ${held.owner_id} has not released ownership`,
          );
        }
        if (held?.state === 'uncertain')
          throw new ToolRefusal('RESOURCE_CAPACITY', 'working copy termination is unconfirmed');
        this.db
          .prepare(`INSERT INTO workspace_access
            (owner_kind,owner_id,session_id,worktree_key,copy_generation,writer,state,tree)
            VALUES(?,?,?,?,?,?,'active',?)`)
          .run(
            owner.kind,
            owner.id,
            sessionId,
            key,
            copyGeneration,
            Number(writer),
            !writer && held?.copy_generation === copyGeneration ? held.tree : null,
          );
      })
      .immediate();
  }

  pin(owner: WorkspaceOwner, tree: string) {
    this.db
      .transaction(() => {
        const access = this.get(owner);
        if (access?.state !== 'active')
          throw new ToolRefusal('TARGET_TERMINAL', 'working copy access is no longer active');
        if (access.tree && access.tree !== tree)
          throw new ToolRefusal('REVISION_CONFLICT', 'working copy input tree is already pinned');
        this.db
          .prepare('UPDATE workspace_access SET tree=? WHERE owner_kind=? AND owner_id=?')
          .run(tree, owner.kind, owner.id);
        // Readers waiting for the mutation lease must not lose this tree when its writer finishes.
        if (access.writer)
          this.db
            .prepare(`UPDATE workspace_access SET tree=?
              WHERE worktree_key=? AND copy_generation=? AND writer=0 AND state='active' AND tree IS NULL`)
            .run(tree, access.worktree_key, access.copy_generation);
      })
      .immediate();
  }

  release(owner: WorkspaceOwner, confirmed: boolean) {
    // Once uncertain, only explicit runtime recovery may return the working copy.
    this.db
      .prepare(
        "UPDATE workspace_access SET state=? WHERE owner_kind=? AND owner_id=? AND state='active'",
      )
      .run(confirmed ? 'released' : 'uncertain', owner.kind, owner.id);
  }
}
