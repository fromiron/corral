import { ExecutionStatus, type RunEvent, RunStatus } from '@corral/contracts';
import { type ExecutionView, pendingInteractions, type RunProjection } from '@corral/core';
import {
  executionPresence,
  type LoopOutcome,
  type Presence,
  type PresenceRequest,
  runPresence,
} from './presence.ts';

/**
 * A Run's presence from what the screen already holds (docs/specs/features/presence.md): its
 * own state, its executions as their views, what waits on the person there, and each Loop's last
 * finished round.
 *
 * What waits is known in full only from the event log: with `events`, every open request counts
 * once, named by the kind of the one that came first (by the record's sequence). Without them,
 * only the projection's open approvals are known, in the order they were requested.
 */
export function projectionPresence(
  projection: RunProjection,
  events?: readonly RunEvent[],
): Presence {
  return runPresence(
    projection,
    Object.values(projection.executions),
    events ? openRequests(projection, events) : projectionApprovals(projection),
    loopEnds(projection),
  );
}

/** An execution's presence from its view: an advisor waiting for a message is watching. */
export function executionViewPresence(execution: Pick<ExecutionView, 'status' | 'advisor'>) {
  return executionPresence({ status: execution.status, observer: execution.advisor === true });
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

type ApprovalView = RunProjection['approvals'][string];

/** A limit's approval asks whether to continue; any other approval asks for an approval. */
const approvalNeed = (approval: ApprovalView) =>
  approval.limit ? ('continue' as const) : ('approval' as const);

function projectionApprovals(projection: RunProjection): PresenceRequest[] {
  return Object.values(projection.approvals)
    .filter((approval) => approval.status === 'pending')
    .map((approval, order) => ({ kind: approvalNeed(approval), order }));
}

function openRequests(projection: RunProjection, events: readonly RunEvent[]): PresenceRequest[] {
  const requestedAt = new Map<string, number>();
  for (const event of events)
    if (event.type === 'approval.requested')
      requestedAt.set(event.payload.approvalId, event.runSeq);
  return pendingInteractions(events, projection).map((item, index) =>
    item.kind === 'approval'
      ? {
          kind: approvalNeed(item.approval),
          // An approval whose request is not in the loaded log keeps its place among the others.
          order: requestedAt.get(item.approval.approvalId) ?? index,
        }
      : { kind: 'question' as const, order: item.event.runSeq },
  );
}

/** Each Loop's last finished round's outcome, the Loops in the order they started. */
function loopEnds(projection: Pick<RunProjection, 'loopIterations' | 'iterations'>) {
  const started = Object.keys(projection.iterations);
  return Object.values(projection.loopIterations)
    .filter((rounds) => rounds.length > 0)
    .sort((a, b) => started.indexOf(a[0] as string) - started.indexOf(b[0] as string))
    .map((rounds): LoopOutcome | null => {
      for (let index = rounds.length - 1; index >= 0; index -= 1) {
        const outcome = projection.iterations[rounds[index] as string]?.outcome;
        if (outcome) return outcome;
      }
      return null;
    });
}
