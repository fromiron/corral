import type { Db } from '@corral/storage-sqlite';
import { type WorkspaceAccess, WorkspaceAccessStore } from './workspace-access.ts';

export interface RunAccess extends Omit<WorkspaceAccess, 'owner_kind' | 'owner_id'> {
  run_id: string;
}

/** Keeps the Run broker contract while sharing admission with human operations. */
export class RunAccessStore {
  private readonly access: WorkspaceAccessStore;
  constructor(db: Db) {
    this.access = new WorkspaceAccessStore(db);
  }

  recover() {
    this.access.recover();
  }

  get(runId: string): RunAccess | undefined {
    const access = this.access.get({ kind: 'run', id: runId });
    return access
      ? {
          run_id: runId,
          session_id: access.session_id,
          worktree_key: access.worktree_key,
          copy_generation: access.copy_generation,
          writer: access.writer,
          state: access.state,
          tree: access.tree,
        }
      : undefined;
  }

  writerAt(key: string): WorkspaceAccess | undefined {
    return this.access.writerAt(key);
  }

  acquire(runId: string, sessionId: string, path: string, writer: boolean, copyGeneration: number) {
    this.access.acquire({ kind: 'run', id: runId }, sessionId, path, writer, copyGeneration);
  }

  pin(runId: string, tree: string) {
    this.access.pin({ kind: 'run', id: runId }, tree);
  }

  release(runId: string, confirmed: boolean) {
    this.access.release({ kind: 'run', id: runId }, confirmed);
  }
}
