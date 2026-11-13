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
 * was given, or the run's history has it given before the oldest request still waiting was made.
 * A line with no such fact in view stands.
 */
export function useFreshDecisions(session: RunSessionStore, kind: 'approval' | 'answer') {
  const events = useStore(session, (s) => s.events);
  const projection = useStore(session, (s) => s.projection);
  const retired = retiredOf(session);
  const waiting = pendingInteractions(events, projection);
  const asked = new Map<string, number>();
  const given = new Map<string, number>();
  for (const event of events) {
    if (event.type === 'approval.requested') asked.set(event.payload.approvalId, event.runSeq);
    else if (event.type === 'user_input.requested' || event.type === 'extension.ui_requested')
      asked.set(event.payload.requestId, event.runSeq);
    else if (kind === 'approval' && event.type === 'approval.resolved')
      given.set(event.payload.approvalId, event.runSeq);
    else if (kind === 'answer' && event.type === 'user_input.answered')
      given.set(event.payload.requestId, event.runSeq);
  }
  const since = Math.min(
    ...waiting.flatMap((item) => {
      const seq = asked.get(
        item.kind === 'approval' ? item.approval.approvalId : item.event.payload.requestId,
      );
      return seq === undefined ? [] : [seq];
    }),
  );
  return (id: string) => {
    if (retired.has(id)) return false;
    const at = given.get(id);
    return at === undefined || !Number.isFinite(since) || at > since;
  };
}
