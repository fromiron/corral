import type { AdvisorPlan } from '../compiler/index.ts';

// When advisors review (docs/specs/features/advisor.md, 계약). Pure: the Coordinator feeds it what
// it committed and runs the actions it returns. One advisor reviews one watched execution at a
// time; records that arrive while a review runs or waits are merged into that execution's next
// review, never stacked.

export type AdvisorPhase = 'idle' | 'reviewing' | 'failed' | 'finished';

export interface AdvisorSlot {
  readonly nodeId: string;
  readonly interval: number;
  /** The node ids it watches. */
  readonly watches: readonly string[];
  readonly phase: AdvisorPhase;
  /** The watched execution under review. */
  readonly current: string | null;
  /** Watched executions waiting for a review, in the order they were scheduled, each once. */
  readonly queue: readonly string[];
  /** Counted model calls of each watched execution since its last scheduled review. */
  readonly counts: Readonly<Record<string, number>>;
}

export interface AdvisorSchedule {
  readonly advisors: Readonly<Record<string, AdvisorSlot>>;
  /** The flow has reached its Output: once a queue is empty, its advisor finishes. */
  readonly flowEnded: boolean;
}

export type AdvisorAction =
  | { kind: 'review'; advisorNodeId: string; executionId: string }
  | { kind: 'finish'; advisorNodeId: string };

export interface AdvisorStep {
  state: AdvisorSchedule;
  actions: AdvisorAction[];
}

export function advisorSchedule(plans: Readonly<Record<string, AdvisorPlan>>): AdvisorSchedule {
  const advisors: Record<string, AdvisorSlot> = {};
  for (const plan of Object.values(plans))
    advisors[plan.nodeId] = {
      nodeId: plan.nodeId,
      interval: plan.review.interval,
      watches: plan.watches,
      phase: 'idle',
      current: null,
      queue: [],
      counts: {},
    };
  return { advisors, flowEnded: false };
}

const open = (slot: AdvisorSlot) => slot.phase === 'idle' || slot.phase === 'reviewing';

/** Starts the next review of an idle advisor, or finishes it once the flow has ended. */
function pump(slot: AdvisorSlot, flowEnded: boolean, actions: AdvisorAction[]): AdvisorSlot {
  if (slot.phase !== 'idle') return slot;
  const [next, ...rest] = slot.queue;
  if (next !== undefined) {
    actions.push({ kind: 'review', advisorNodeId: slot.nodeId, executionId: next });
    return { ...slot, phase: 'reviewing', current: next, queue: rest };
  }
  if (!flowEnded) return slot;
  actions.push({ kind: 'finish', advisorNodeId: slot.nodeId });
  return { ...slot, phase: 'finished' };
}

const enqueue = (slot: AdvisorSlot, executionId: string): AdvisorSlot =>
  slot.queue.includes(executionId) ? slot : { ...slot, queue: [...slot.queue, executionId] };

function each(
  state: AdvisorSchedule,
  change: (slot: AdvisorSlot) => AdvisorSlot,
  only?: (slot: AdvisorSlot) => boolean,
): AdvisorStep {
  const actions: AdvisorAction[] = [];
  const advisors: Record<string, AdvisorSlot> = {};
  for (const [id, slot] of Object.entries(state.advisors))
    advisors[id] =
      (only ? only(slot) : true) && open(slot)
        ? pump(change(slot), state.flowEnded, actions)
        : slot;
  return { state: { ...state, advisors }, actions };
}

/**
 * A watched execution finished a model call. One that counts toward the interval and reaches it
 * schedules that execution's review; a review already queued for it takes the new records too.
 */
export function onModelFinished(
  state: AdvisorSchedule,
  call: { nodeId: string; executionId: string; counts: boolean },
): AdvisorStep {
  if (!call.counts) return { state, actions: [] };
  return each(
    state,
    (slot) => {
      const count = (slot.counts[call.executionId] ?? 0) + 1;
      if (count < slot.interval)
        return { ...slot, counts: { ...slot.counts, [call.executionId]: count } };
      return enqueue(
        { ...slot, counts: { ...slot.counts, [call.executionId]: 0 } },
        call.executionId,
      );
    },
    (slot) => slot.watches.includes(call.nodeId),
  );
}

/** A watched execution ended: one last review reads what is still unread. */
export function onExecutionEnded(
  state: AdvisorSchedule,
  ended: { nodeId: string; executionId: string },
): AdvisorStep {
  return each(
    state,
    (slot) => {
      const { [ended.executionId]: _gone, ...counts } = slot.counts;
      return enqueue({ ...slot, counts }, ended.executionId);
    },
    (slot) => slot.watches.includes(ended.nodeId),
  );
}

/** The advisor's review ended, or was skipped because it had nothing to read. */
export function onReviewEnded(state: AdvisorSchedule, advisorNodeId: string): AdvisorStep {
  return each(
    state,
    (slot) => (slot.phase === 'reviewing' ? { ...slot, phase: 'idle', current: null } : slot),
    (slot) => slot.nodeId === advisorNodeId,
  );
}

/** The advisor failed or was stopped: it does not review again in this Run. */
export function onAdvisorStopped(state: AdvisorSchedule, advisorNodeId: string): AdvisorStep {
  const slot = state.advisors[advisorNodeId];
  if (!slot || !open(slot)) return { state, actions: [] };
  return {
    state: {
      ...state,
      advisors: {
        ...state.advisors,
        [advisorNodeId]: { ...slot, phase: 'failed', current: null, queue: [] },
      },
    },
    actions: [],
  };
}

/** The flow reached its Output: advisors finish once their queues are empty. */
export function onFlowEnded(state: AdvisorSchedule): AdvisorStep {
  if (state.flowEnded) return { state, actions: [] };
  return each({ ...state, flowEnded: true }, (slot) => slot);
}

/** Every advisor has finished or stopped: nothing holds the Run's end any more. */
export function advisorsSettled(state: AdvisorSchedule): boolean {
  return Object.values(state.advisors).every((slot) => !open(slot));
}
