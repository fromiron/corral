import { realpathSync } from 'node:fs';
import type { CommandError } from '@corral/contracts';
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

type Holder = NonNullable<CommandError['owner']>;

/**
 * Durable copy reservations for Runs and human effects. A server without sharing keeps one writer
 * per copy. A local host shares the copy between human operations and one writing Run.
 * An owner whose end was never confirmed keeps new owners out until it is settled.
 */
export class WorkspaceAccessStore {
  private readonly db: Db;
  private readonly shares: boolean;
  constructor(db: Db, shares = false) {
    this.db = db;
    this.shares = shares;
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

  /** What holds the copy, as a refusal names it (api-contract.md 오류). */
  holder(access: WorkspaceAccess): Holder {
    const named = {
      id: access.owner_id,
      sessionId: access.session_id,
      state: access.state === 'uncertain' ? ('uncertain' as const) : ('active' as const),
    };
    if (access.owner_kind === 'run') return { kind: 'run', ...named };
    const operation = this.db
      .prepare('SELECT kind FROM workbench_operations WHERE operation_id=?')
      .get(access.owner_id) as { kind: string } | undefined;
    if (operation?.kind === 'task' || operation?.kind === 'terminal')
      return { kind: operation.kind, ...named };
    return { kind: 'operation', ...named, operationKind: operation?.kind ?? 'unknown' };
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
        const insert = (tree: string | null) =>
          this.db
            .prepare(`INSERT INTO workspace_access
              (owner_kind,owner_id,session_id,worktree_key,copy_generation,writer,state,tree)
              VALUES(?,?,?,?,?,?,'active',?)`)
            .run(owner.kind, owner.id, sessionId, key, copyGeneration, Number(writer), tree);
        if (this.shares) {
          const owners = this.ownersAt(key);
          const unsettled = owners.find((access) => access.state === 'uncertain');
          if (unsettled) {
            const holder = this.holder(unsettled);
            throw new ToolRefusal(
              writer ? 'RUN_ALREADY_ACTIVE' : 'RESOURCE_CAPACITY',
              `${holder.kind === 'operation' ? holder.operationKind : holder.kind} ${holder.id} has not confirmed it ended; the working copy stays protected until it is settled`,
              holder,
            );
          }
          if (owner.kind === 'run' && writer) {
            const writing = owners.find(
              (access) => access.owner_kind === 'run' && access.writer === 1,
            );
            if (writing)
              throw new ToolRefusal(
                'RUN_ALREADY_ACTIVE',
                `run ${writing.owner_id} is already writing this working copy`,
                this.holder(writing),
              );
          }
          // Each reader takes its own snapshot of the live copy as it starts.
          insert(null);
          return;
        }
        const held = this.writerAt(key);
        const holder = held ? this.holder(held) : undefined;
        if (writer && held && holder) {
          throw new ToolRefusal(
            'RUN_ALREADY_ACTIVE',
            holder.kind === 'terminal' && holder.state === 'uncertain'
              ? 'Terminal writer termination is unconfirmed; the working copy remains protected'
              : `working copy ${holder.kind === 'terminal' ? 'terminal ' : ''}writer ${held.owner_id} has not released ownership`,
            holder,
          );
        }
        if (held?.state === 'uncertain')
          throw new ToolRefusal(
            'RESOURCE_CAPACITY',
            'working copy termination is unconfirmed',
            holder,
          );
        insert(!writer && held?.copy_generation === copyGeneration ? held.tree : null);
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
        // On a shared copy each reader takes its own snapshot instead.
        if (access.writer && !this.shares)
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
