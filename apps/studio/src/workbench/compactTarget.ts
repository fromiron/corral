import { TERMINAL_EXECUTION_STATUSES, TERMINAL_RUN_STATUSES } from '@corral/contracts';
import type { RunProjection } from '@corral/core';

export type CompactReason =
  | 'compactNoExecution'
  | 'compactNotLive'
  | 'compactCancelling'
  | 'compactAmbiguous';

export type CompactDecision =
  | {
      ok: true;
      executionId: string;
      attemptNo: number;
      expectedControlRevision: number;
      pending: boolean;
    }
  | { ok: false; reason: CompactReason };

/** The one live execution a manual compact may name, or why none can be named. */
export function compactTarget(
  projection: RunProjection | null,
  executionId: string | null,
): CompactDecision {
  if (!projection) return { ok: false, reason: 'compactNoExecution' };
  if (projection.mode !== 'live') return { ok: false, reason: 'compactNotLive' };
  if (projection.status === 'cancelling') return { ok: false, reason: 'compactCancelling' };
  if (TERMINAL_RUN_STATUSES.has(projection.status)) {
    return { ok: false, reason: 'compactNoExecution' };
  }
  const open = projection.executionOrder
    .map((id) => projection.executions[id])
    .filter(
      (execution) =>
        execution &&
        execution.status !== 'cancelling' &&
        !TERMINAL_EXECUTION_STATUSES.has(execution.status),
    );
  const named = executionId ? projection.executions[executionId] : undefined;
  const execution = executionId
    ? open.find((item) => item?.executionId === named?.executionId)
    : open.length === 1
      ? open[0]
      : undefined;
  if (!execution) {
    return {
      ok: false,
      reason: !executionId && open.length > 1 ? 'compactAmbiguous' : 'compactNoExecution',
    };
  }
  const pending = Object.values(projection.compactions ?? {}).some(
    (item) =>
      item.executionId === execution.executionId &&
      item.attemptNo === execution.attemptNo &&
      (item.phase === 'queued' || item.phase === 'started'),
  );
  return {
    ok: true,
    executionId: execution.executionId,
    attemptNo: execution.attemptNo,
    expectedControlRevision: projection.controlRevision,
    pending,
  };
}
