import { realpathSync } from 'node:fs';
import {
  type Clock,
  canonicalJson,
  type WorkbenchOperation,
  type WorkspaceTarget,
} from '@corral/contracts';

export type { WorkbenchOperation, WorkspaceTarget } from '@corral/contracts';

import { ToolRefusal } from '@corral/core';
import type { Db } from '@corral/storage-sqlite';
import { WorkspaceAccessStore } from './workspace-access.ts';

interface OperationRequest {
  operationId: string;
  target: WorkspaceTarget;
  kind: string;
  requestHash: string;
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

const sharedKinds = new Set([
  'document.save',
  'document.batch',
  'document.rename',
  'document.delete',
  'task',
  'debug',
  'git.stage',
  'git.stage_hunks',
  'git.unstage_hunks',
  'git.unstage',
  'git.commit',
  'git.fetch',
  'git.push',
]);
const pathKey = (path: string) => {
  const real = realpathSync.native(path);
  return process.platform === 'win32' ? real.toLowerCase() : real;
};

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

  development(path: string): WorkbenchOperation | undefined {
    const writer = this.access.writerAt(pathKey(path));
    const operation = writer?.owner_kind === 'user' ? this.get(writer.owner_id) : undefined;
    return operation?.kind === 'development' ? operation : undefined;
  }

  canShare(target: WorkspaceTarget, path: string): boolean {
    const owner = this.development(path);
    return (
      owner?.state === 'running' &&
      canonicalJson(owner.target) === canonicalJson(target) &&
      this.access.get({ kind: 'user', id: owner.operationId })?.state === 'active'
    );
  }

  finishDevelopment(operationId: string, target: WorkspaceTarget, path: string) {
    return this.db
      .transaction(() => {
        const receipt = this.get(operationId);
        if (!receipt || receipt.kind !== 'development')
          throw new ToolRefusal('TARGET_NOT_FOUND', 'the development owner is unavailable');
        if (canonicalJson(receipt.target) !== canonicalJson(target))
          throw new ToolRefusal('REVISION_CONFLICT', 'the development target changed');
        if (receipt.state !== 'running' && receipt.state !== 'uncertain') return;
        if (
          this.access
            .ownersAt(pathKey(path))
            .some(
              (owner) =>
                owner.owner_kind === 'user' &&
                owner.owner_id !== operationId &&
                (owner.state === 'uncertain' || this.get(owner.owner_id)?.kind !== 'language'),
            )
        )
          throw new ToolRefusal(
            'RUN_ALREADY_ACTIVE',
            'stop and reconcile the shared development tasks and pending effects first',
          );
        this.reconcile(operationId, ['development'], 'succeeded', null);
      })
      .immediate();
  }

  list(kind: string, sessionId?: string): WorkbenchOperation[] {
    const rows = (
      sessionId === undefined
        ? this.db
            .prepare(
              'SELECT operation_id FROM workbench_operations WHERE kind=? ORDER BY created_at,operation_id',
            )
            .all(kind)
        : this.db
            .prepare(
              "SELECT operation_id FROM workbench_operations WHERE kind=? AND json_extract(target_json,'$.sessionId')=? ORDER BY created_at,operation_id",
            )
            .all(kind, sessionId)
    ) as { operation_id: string }[];
    return rows.map((row) => this.get(row.operation_id) as WorkbenchOperation);
  }

  updateRunning(operationId: string, result: unknown): boolean {
    return (
      this.db
        .prepare(
          "UPDATE workbench_operations SET result_json=?,updated_at=? WHERE operation_id=? AND state='running'",
        )
        .run(JSON.stringify(result), this.clock.nowIso(), operationId).changes === 1
    );
  }

  /** Command receipts may complete after their debugger has released its process owner. */
  updateDebugResult(operationId: string, result: unknown): boolean {
    return (
      this.db
        .prepare(
          "UPDATE workbench_operations SET result_json=?,updated_at=? WHERE operation_id=? AND kind='debug'",
        )
        .run(JSON.stringify(result), this.clock.nowIso(), operationId).changes === 1
    );
  }

  /** Called only after explicit OS identity reconciliation proves the PTY session is gone. */
  reconcileTerminal(operationId: string, result: unknown): WorkbenchOperation {
    return this.reconcile(operationId, ['terminal'], 'cancelled', result);
  }

  /**
   * Settles a running or uncertain receipt once its effect was read back from the host (a gone
   * process group, or Git HEAD/index), and returns the working copy.
   */
  reconcile(
    operationId: string,
    kinds: readonly string[],
    state: Exclude<WorkbenchOperation['state'], 'running' | 'uncertain'>,
    result: unknown,
  ): WorkbenchOperation {
    return this.db
      .transaction(() => {
        const prior = this.get(operationId);
        if (!prior || !kinds.includes(prior.kind))
          throw new ToolRefusal('TARGET_NOT_FOUND', 'operation receipt is unavailable');
        if (prior.state !== 'uncertain' && prior.state !== 'running') return prior;
        this.db
          .prepare(
            'UPDATE workbench_operations SET state=?,result_json=?,updated_at=? WHERE operation_id=?',
          )
          .run(state, JSON.stringify(result), this.clock.nowIso(), operationId);
        this.db
          .prepare(
            "UPDATE workspace_access SET state='released' WHERE owner_kind='user' AND owner_id=? AND state IN ('active','uncertain')",
          )
          .run(operationId);
        return this.get(operationId) as WorkbenchOperation;
      })
      .immediate();
  }

  admit(
    request: OperationRequest,
    path: string,
    initialResult: unknown = null,
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
        const shared = sharedKinds.has(request.kind) && this.canShare(request.target, path);
        if (
          shared &&
          this.access.ownersAt(pathKey(path)).some((owner) => owner.state === 'uncertain')
        )
          throw new ToolRefusal(
            'RESOURCE_CAPACITY',
            'shared development has an unconfirmed effect',
          );
        this.access.acquire(
          { kind: 'user', id: request.operationId },
          request.target.sessionId,
          path,
          !shared && request.kind !== 'language',
          request.target.copyGeneration,
        );
        const now = this.clock.nowIso();
        this.db
          .prepare(`INSERT INTO workbench_operations
        (operation_id,request_hash,target_json,kind,state,result_json,created_at,updated_at)
        VALUES(?,?,?,?,'running',?,?,?)`)
          .run(
            request.operationId,
            request.requestHash,
            JSON.stringify(request.target),
            request.kind,
            initialResult === null ? null : JSON.stringify(initialResult),
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
