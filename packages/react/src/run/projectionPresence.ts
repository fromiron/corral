import { ExecutionStatus, RunStatus } from '@corral/contracts';
import type { RunProjection } from '@corral/core';
import { executionPresence, type Presence, type PresenceRequest, runPresence } from './presence.ts';

/**
 * A Run's presence from its projection: its own state, its executions, and what waits on the
 * person there. Open approvals are the projection's; a person's questions and extension requests
 * are known only from the event log, so a caller that has them passes their kinds in order.
 * A limit's approval asks whether to continue; any other approval asks for an approval.
 */
export function projectionPresence(
  projection: Pick<RunProjection, 'status' | 'executions' | 'approvals'>,
  requests: readonly ('question' | 'approval')[] = [],
): Presence {
  const approvals = Object.values(projection.approvals).filter(
    (approval) => approval.status === 'pending',
  );
  const pending: PresenceRequest[] = [
    ...approvals.map((approval, order) => ({
      kind: approval.limit ? ('continue' as const) : ('approval' as const),
      order,
    })),
    ...requests.map((kind, index) => ({ kind, order: approvals.length + index })),
  ];
  return runPresence(projection, Object.values(projection.executions), pending);
}

/**
 * The presence of a bare status that may be an execution's or a Run's (a turn's rows carry
 * either), or null for anything else. Both enums name their shared values alike, so an
 * execution's reading is taken first.
 */
export function statusPresence(status: string): Presence | null {
  const execution = ExecutionStatus.safeParse(status);
  if (execution.success) return executionPresence({ status: execution.data });
  const run = RunStatus.safeParse(status);
  return run.success ? runPresence({ status: run.data }, [], []) : null;
}
