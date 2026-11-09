import type {
  Clock,
  DecisionCancellation,
  EffortLevel,
  EffortProbabilities,
  InsufficientContextReason,
  RouterResponse,
  RoutingBackend,
  RoutingEngine,
  RoutingFallbackReason,
  RoutingFrameRecord,
  RoutingLease,
  Scheduler,
  SettledBasis,
} from '@corral/contracts';
import { RoutingFallbackReason as FallbackReasons } from '@corral/contracts';
import { judge } from './arbiter.ts';
import { type CallSnapshot, packFrame } from './frame.ts';
import { effortQuestion } from './question.ts';

// One judgment (features/effort-routing.md#대기취소물리-슬롯). The deadline is set once, before
// packing; packing, counting, the engine call and the checks all spend it. The request's logical
// result settles once; the engine's physical end is observed apart from it.

export interface RouteInput {
  routeId: string;
  engine: RoutingEngine;
  backend: RoutingBackend | null;
  snapshot: CallSnapshot;
  /** Two or more supported levels, weakest first. */
  candidates: EffortLevel[];
  clock: Clock;
  timers: Scheduler | undefined;
  /** The request was cancelled or went stale: nothing more is sent. */
  cancellation: DecisionCancellation;
}

export interface SettledFacts {
  basis: SettledBasis;
  physicalOccupiedMs: number;
  lateResult: boolean;
  lateSelected: EffortLevel | null;
}

export interface RouteOutcome {
  kind: 'selected' | 'fallback' | 'cancelled';
  effort: EffortLevel | null;
  reason: RoutingFallbackReason | null;
  insufficient: InsufficientContextReason | null;
  probabilities: EffortProbabilities | null;
  probabilityMeaning: 'choice-distribution' | 'not-provided' | null;
  engineIdentity: string | null;
  frame: RoutingFrameRecord | null;
  device: RoutingLease['device'];
  timing: {
    deadlineMs: number;
    packMs: number | null;
    countMs: number | null;
    engineMs: number | null;
    callerWaitMs: number;
  };
  usage: { inputTokens: number | null; billableUnits: number | null };
  /** The engine call's physical end; null when no call started. */
  settled: Promise<SettledFacts> | null;
}

type Stop = 'timeout' | 'cancelled';

const reasonOf = (error: unknown): RoutingFallbackReason => {
  const reason = (error as { reason?: unknown } | null)?.reason;
  const parsed = FallbackReasons.safeParse(reason);
  return parsed.success ? parsed.data : 'transport-error';
};

export async function route(input: RouteInput): Promise<RouteOutcome> {
  const { clock } = input;
  const startedAt = clock.monotonicMs();
  const deadlineMs = input.engine.callerTimeoutMs;
  let stop: Stop | null = null;
  const listeners = new Set<() => void>();
  const signal: DecisionCancellation = {
    get aborted() {
      return stop !== null;
    },
    onCancel(fn) {
      listeners.add(fn);
      if (stop) fn();
      return () => listeners.delete(fn);
    },
  };
  let wake: (why: Stop) => void = () => {};
  const stopped = new Promise<Stop>((resolve) => {
    wake = resolve;
  });
  const halt = (why: Stop) => {
    if (stop) return;
    stop = why;
    wake(why);
    for (const fn of [...listeners]) fn();
  };
  const cancelTimer = input.timers?.after(deadlineMs, () => halt('timeout'));
  const offCancel = input.cancellation.onCancel(() => halt('cancelled'));
  if (input.cancellation.aborted) halt('cancelled');

  let lease: RoutingLease | null = null;
  let frame: RoutingFrameRecord | null = null;
  let packMs: number | null = null;
  let countMs = 0;
  let counting = false;
  let engineMs: number | null = null;
  let settled: Promise<SettledFacts> | null = null;
  const finish = (
    kind: RouteOutcome['kind'],
    fields: Partial<
      Pick<
        RouteOutcome,
        'effort' | 'reason' | 'insufficient' | 'probabilities' | 'probabilityMeaning' | 'usage'
      >
    > = {},
  ): RouteOutcome => {
    cancelTimer?.();
    offCancel();
    return {
      kind,
      effort: fields.effort ?? null,
      reason: kind === 'fallback' ? (fields.reason ?? null) : null,
      insufficient: fields.insufficient ?? null,
      probabilities: fields.probabilities ?? null,
      probabilityMeaning: fields.probabilityMeaning ?? null,
      engineIdentity: lease?.identity ?? null,
      frame,
      device: lease?.device ?? null,
      timing: {
        deadlineMs,
        packMs,
        countMs: lease && packMs !== null ? countMs : null,
        engineMs,
        callerWaitMs: Math.max(0, clock.monotonicMs() - startedAt),
      },
      usage: fields.usage ?? { inputTokens: null, billableUnits: null },
      settled,
    };
  };
  const stopped_ = (why: Stop) =>
    why === 'cancelled' ? finish('cancelled') : finish('fallback', { reason: 'timeout' });

  if (stop) return stopped_(stop);
  if (!input.backend) return finish('fallback', { reason: 'unavailable' });
  const admission = input.backend.admit();
  if (!admission.ok) return finish('fallback', { reason: admission.reason });
  lease = admission.lease;
  const admittedAt = clock.monotonicMs();
  const held = lease;
  const question = effortQuestion(input.candidates);
  const timed = async <T>(work: () => Promise<T>): Promise<T> => {
    if (counting) return work();
    counting = true;
    const from = clock.monotonicMs();
    try {
      return await work();
    } finally {
      countMs += clock.monotonicMs() - from;
      counting = false;
    }
  };
  const packing = packFrame(
    input.snapshot,
    {
      kind: held.frame,
      countState: (text, s) => timed(() => held.countState(text, s)),
      countInput: (state, q, s) => timed(() => held.countInput(state, q, s)),
    },
    question,
    signal,
  );
  // Without an engine call the lease returns once packing has cleaned up.
  const abandon = (outcome: RouteOutcome) => {
    void packing.then(
      () => held.release(),
      () => held.release(),
    );
    return outcome;
  };
  const packed = await Promise.race([
    packing.then(
      (value) => ({ value }) as const,
      (error: unknown) => ({ error }) as const,
    ),
    stopped.then((why) => ({ stop: why }) as const),
  ]);
  packMs = Math.max(0, clock.monotonicMs() - startedAt);
  if ('stop' in packed) return abandon(stopped_(packed.stop));
  if (stop) return abandon(stopped_(stop));
  // A failed count is the tokenizer's failure; packing itself does not throw otherwise.
  if ('error' in packed) return abandon(finish('fallback', { reason: 'tokenizer-error' }));
  const result = packed.value;
  if (result.kind === 'insufficient')
    return abandon(
      finish('fallback', { reason: 'insufficient-context', insufficient: result.reason }),
    );
  frame = result.frame.record;
  const remainingMs = deadlineMs - (clock.monotonicMs() - startedAt);
  if (remainingMs <= 0) return abandon(finish('fallback', { reason: 'timeout' }));

  const engineKind = input.backend.kind;
  const flightStart = clock.monotonicMs();
  const flight = held.start({
    routeId: input.routeId,
    state: result.frame.state,
    question,
    candidates: input.candidates,
    remainingMs,
    inputUnits: frame.inputUnits,
    signal,
  });
  let decided = false;
  let late: RouterResponse | null = null;
  const expected = frame.inputUnits;
  void flight.result.then(
    (response) => {
      if (decided) late = response;
    },
    () => {},
  );
  // An engine settles its result no later than its physical end.
  settled = flight.settled.then(async (end) => {
    await flight.result.then(
      () => {},
      () => {},
    );
    const verdict = late ? judge(late, input.candidates, engineKind, expected) : null;
    const lateSelected = verdict?.ok ? verdict.effort : null;
    return {
      basis: end.basis,
      physicalOccupiedMs: Math.max(0, end.finishedAtMs - admittedAt),
      lateResult: late !== null,
      lateSelected,
    };
  });
  const answered = await Promise.race([
    flight.result.then(
      (response) => ({ response }) as const,
      (error: unknown) => ({ error }) as const,
    ),
    stopped.then((why) => ({ stop: why }) as const),
  ]);
  decided = true;
  if ('stop' in answered) return stopped_(answered.stop);
  engineMs = Math.max(0, clock.monotonicMs() - flightStart);
  if (stop) return stopped_(stop);
  if ('error' in answered) return finish('fallback', { reason: reasonOf(answered.error) });
  const usage = {
    inputTokens: answered.response.inputTokens,
    billableUnits: answered.response.billableUnits,
  };
  const verdict = judge(answered.response, input.candidates, engineKind, expected);
  if (!verdict.ok) return finish('fallback', { reason: verdict.reason, usage });
  return finish('selected', {
    effort: verdict.effort,
    probabilities: verdict.probabilities,
    probabilityMeaning: verdict.meaning,
    usage,
  });
}
