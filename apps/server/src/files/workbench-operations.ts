import type { Clock } from '@corral/contracts';
import { ToolRefusal } from '@corral/core';
import type { Db } from '@corral/storage-sqlite';
import { WorkspaceAccessStore } from './workspace-access.ts';

export interface WorkspaceTarget {
  hostId: string;
  projectId: string;
  bindingId: string;
  sessionId: string;
  copyGeneration: number;
}
interface OperationRequest {
  operationId: string;
  target: WorkspaceTarget;
  kind: string;
  requestHash: string;
}
export interface WorkbenchOperation extends OperationRequest {
  state: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'uncertain';
  result: unknown;
  createdAt: string;
  updatedAt: string;
}
interface OperationRow {
  operation_id: string;
  request_hash: string;
  target_json: string;
  kind: string;
  state: WorkbenchOperation['state'];
  result_json: string | null;
  created_at: string;
  updated_at: string;
}

/** The caller resolves trust, target identity and path before admitting an effect. */
export class WorkbenchOperations {
  private readonly access: WorkspaceAccessStore;
  private readonly db: Db;
  private readonly clock: Clock;
  constructor(db: Db, clock: Clock) {
    this.db = db;
    this.clock = clock;
    this.access = new WorkspaceAccessStore(db);
  }

  get(operationId: string): WorkbenchOperation | undefined {
    const row = this.db
      .prepare('SELECT * FROM workbench_operations WHERE operation_id=?')
      .get(operationId) as OperationRow | undefined;
    return (
      row && {
        operationId: row.operation_id,
        requestHash: row.request_hash,
        target: JSON.parse(row.target_json),
        kind: row.kind,
        state: row.state,
        result: row.result_json === null ? null : JSON.parse(row.result_json),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    );
  }

  admit(
    request: OperationRequest,
    path: string,
  ): { admitted: boolean; receipt: WorkbenchOperation } {
    return this.db
      .transaction(() => {
        const prior = this.get(request.operationId);
        if (prior) {
          const target = request.target;
          if (
            prior.requestHash !== request.requestHash ||
            prior.kind !== request.kind ||
            prior.target.hostId !== target.hostId ||
            prior.target.projectId !== target.projectId ||
            prior.target.bindingId !== target.bindingId ||
            prior.target.sessionId !== target.sessionId ||
            prior.target.copyGeneration !== target.copyGeneration
          )
            throw new ToolRefusal('REVISION_CONFLICT', 'operation request changed');
          return { admitted: false, receipt: prior };
        }
        this.access.acquire(
          { kind: 'user', id: request.operationId },
          request.target.sessionId,
          path,
          true,
          request.target.copyGeneration,
        );
        const now = this.clock.nowIso();
        this.db
          .prepare(`INSERT INTO workbench_operations
        (operation_id,request_hash,target_json,kind,state,result_json,created_at,updated_at)
        VALUES(?,?,?,?,'running',NULL,?,?)`)
          .run(
            request.operationId,
            request.requestHash,
            JSON.stringify(request.target),
            request.kind,
            now,
            now,
          );
        return { admitted: true, receipt: this.get(request.operationId) as WorkbenchOperation };
      })
      .immediate();
  }

  finish(
    operationId: string,
    state: Exclude<WorkbenchOperation['state'], 'running'>,
    result: unknown,
  ): WorkbenchOperation {
    return this.db
      .transaction(() => {
        const prior = this.get(operationId);
        if (!prior) throw new ToolRefusal('TARGET_NOT_FOUND', 'operation receipt is unavailable');
        // Recovery is explicit: a late completion cannot make an uncertain effect safe.
        if (prior.state !== 'running') return prior;
        const owner = { kind: 'user' as const, id: operationId };
        if (this.access.get(owner)?.state === 'uncertain') state = 'uncertain';
        this.db
          .prepare(
            'UPDATE workbench_operations SET state=?,result_json=?,updated_at=? WHERE operation_id=?',
          )
          .run(state, JSON.stringify(result), this.clock.nowIso(), operationId);
        this.access.release(owner, state !== 'uncertain');
        return this.get(operationId) as WorkbenchOperation;
      })
      .immediate();
  }

  recover() {
    this.db
      .transaction(() => {
        this.db
          .prepare(
            "UPDATE workbench_operations SET state='uncertain',updated_at=? WHERE state='running'",
          )
          .run(this.clock.nowIso());
        this.access.recover();
      })
      .immediate();
  }

  hasPending(): boolean {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM workbench_operations WHERE state IN ('running','uncertain') LIMIT 1",
        )
        .get(),
    );
  }
}
