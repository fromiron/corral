import { pendingInteractions } from '@corral/core';
import { useStore } from 'zustand';
import type { RunSessionState, RunSessionStore } from '../run/session.ts';

/** Per run: decisions and answers given before the run last waited on nothing. */
const retiredByRun = new WeakMap<RunSessionStore, Set<string>>();

/**
 * Follows a run from the first place that folds its lines, whether or not any such place is on
 * screen when the run goes on: a response area leaves at the very moment nothing waits.
 */
function retiredOf(session: RunSessionStore) {
  const known = retiredByRun.get(session);
  if (known) return known;
  const retired = new Set<string>();
  retiredByRun.set(session, retired);
  const retire = ({ events, projection }: RunSessionState) => {
    if (!projection || pendingInteractions(events, projection).length) return;
    for (const approval of Object.values(projection.approvals))
      if (approval.status !== 'pending') retired.add(approval.approvalId);
    for (const event of events)
      if (event.type === 'user_input.answered') retired.add(event.payload.requestId);
  };
  retire(session.getState());
  session.subscribe(retire);
  return retired;
}

/**
 * Which decisions (`approval`) or answers (`answer`) still stand as a folded line: those given
 * while the run has been waiting without a break. A line stays in its card's place until the run
 * goes on (nothing waits any more); once gone it never comes back, so a run that waits again shows
 * only its new cards.
 *
 * Two facts say a line belongs to an earlier wait: the run was seen waiting on nothing after it
 * was given, or the run's history has a moment after it was given when no request was open.
 * A line with no such fact in view stands.
 */
export function useFreshDecisions(session: RunSessionStore, kind: 'approval' | 'answer') {
  const events = useStore(session, (s) => s.events);
  const projection = useStore(session, (s) => s.projection);
  const retired = retiredOf(session);
  // A request waiting now whose asking is not in the history has been open all along.
  const asked = new Set(
    events.flatMap((event) =>
      event.type === 'approval.requested'
        ? [event.payload.approvalId]
        : event.type === 'user_input.requested' || event.type === 'extension.ui_requested'
          ? [event.payload.requestId]
          : [],
    ),
  );
  const open = new Set(
    pendingInteractions(events, projection)
      .map((item) =>
        item.kind === 'approval' ? item.approval.approvalId : item.event.payload.requestId,
      )
      .filter((id) => !asked.has(id)),
  );
  const given = new Map<string, number>();
  // The last point in the history where no request was open.
  let idleAt = Number.NEGATIVE_INFINITY;
  for (const event of [...events].sort((a, b) => a.runSeq - b.runSeq)) {
    switch (event.type) {
      case 'approval.requested':
        open.add(event.payload.approvalId);
        break;
      case 'user_input.requested':
      case 'extension.ui_requested':
        open.add(event.payload.requestId);
        break;
      case 'approval.resolved':
        if (kind === 'approval') given.set(event.payload.approvalId, event.runSeq);
        if (open.delete(event.payload.approvalId) && !open.size) idleAt = event.runSeq;
        break;
      case 'user_input.answered':
      case 'user_input.closed':
      case 'extension.ui_answered':
      case 'extension.ui_expired':
        if (kind === 'answer' && event.type === 'user_input.answered')
          given.set(event.payload.requestId, event.runSeq);
        if (open.delete(event.payload.requestId) && !open.size) idleAt = event.runSeq;
        break;
    }
  }
  return (id: string) => {
    if (retired.has(id)) return false;
    const at = given.get(id);
    return at === undefined || at > idleAt;
  };
}
