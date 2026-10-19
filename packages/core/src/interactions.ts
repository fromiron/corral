import { type EventOf, type RunEvent, TERMINAL_RUN_STATUSES } from '@corral/contracts';
import type { RunProjection } from './projection.ts';

export type InteractionView =
  | { kind: 'approval'; approval: RunProjection['approvals'][string] }
  | { kind: 'extension'; event: EventOf<'extension.ui_requested'> }
  | { kind: 'question'; event: EventOf<'user_input.requested'> };

/** A read model over existing facts. Each domain retains its own response command. */
export function pendingInteractions(
  events: readonly RunEvent[],
  projection: RunProjection | null,
): InteractionView[] {
  if (
    !projection ||
    TERMINAL_RUN_STATUSES.has(projection.status) ||
    projection.status === 'cancelling'
  )
    return [];
  const pending = new Map<string, InteractionView>();
  for (const event of events) {
    if (event.type === 'extension.ui_requested' || event.type === 'user_input.requested') {
      const execution = projection.executions[event.payload.executionId];
      if (
        execution?.status !== 'waiting_approval' ||
        execution.attemptNo !== event.payload.attemptNo
      )
        continue;
      pending.set(
        event.payload.requestId,
        event.type === 'extension.ui_requested'
          ? { kind: 'extension', event }
          : { kind: 'question', event },
      );
    }
    if (
      event.type === 'extension.ui_answered' ||
      event.type === 'extension.ui_expired' ||
      event.type === 'user_input.answered' ||
      event.type === 'user_input.closed'
    )
      pending.delete(event.payload.requestId);
  }
  return [
    ...Object.values(projection.approvals)
      .filter((a) => a.status === 'pending')
      .map((approval) => ({ kind: 'approval' as const, approval })),
    ...pending.values(),
  ];
}
