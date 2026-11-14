import type { DirectiveView, ExecutionView, RunProjection } from '@corral/core';

// What became of a directive, read from its run's record (features/composer-flow.md "보낸 메시지의
// 메타 줄"). A person's instruction and an advisor's advice travel the same path, so they say the
// same words; only the person's message can be carried over when its target ended first.

const WAITING_ON_PERSON = new Set(['approval', 'user']);

/** An execution waiting on the person (an approval or a question); an instruction is read after. */
export function awaitsPerson(execution: Pick<ExecutionView, 'status' | 'waitingOn'>): boolean {
  return (
    execution.status === 'waiting_approval' ||
    WAITING_ON_PERSON.has(execution.waitingOn?.kind ?? '')
  );
}

/**
 * An interrupt is "interrupted" only when the response just before the request that delivered
 * it, in the same execution, was really cut; with nothing to cut it was simply read.
 */
export function cutBefore(projection: RunProjection, directive: DirectiveView): boolean {
  if (directive.delivery !== 'interrupt' || !directive.modelCallId) return false;
  const calls = Object.values(projection.modelCalls).filter(
    (call) => call.executionId === directive.targetExecutionId,
  );
  const at = calls.findIndex((call) => call.modelCallId === directive.modelCallId);
  return at > 0 && calls[at - 1]?.interrupted === true;
}

/** A directive on its way or delivered, in the words of `Sessions.meta`. */
export type DeliveryState =
  | 'waiting'
  | 'afterDecision'
  | 'delivering'
  | 'read'
  | 'interrupted'
  | 'unknown';

/**
 * Where a directive stands, or `ended` when its target ended before reading it (`expired`) or it
 * went nowhere (`not_delivered`): what follows then is the caller's to say.
 */
export function deliveryState(
  projection: RunProjection,
  directive: DirectiveView,
): DeliveryState | 'ended' {
  switch (directive.status) {
    case 'accepted':
      return 'waiting';
    case 'queued': {
      const target = projection.executions[directive.targetExecutionId];
      return target && awaitsPerson(target) ? 'afterDecision' : 'waiting';
    }
    case 'attached_to_request':
      return 'delivering';
    case 'delivered':
      return cutBefore(projection, directive) ? 'interrupted' : 'read';
    case 'delivery_unknown':
      return 'unknown';
    default:
      return 'ended';
  }
}
