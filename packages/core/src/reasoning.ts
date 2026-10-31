import type { ModelProfileSnapshot, ReasoningPolicy, ReasoningResolution } from '@corral/contracts';
import {
  DecisionAnswer,
  type DecisionCancellation,
  type DecisionProvider,
  EFFORT_LEVELS,
  type EffortLevel,
  type ReasoningInput,
  type Scheduler,
} from '@corral/contracts';
import { lowEffortNeedsReview } from './reasoning-risk.ts';

export function reasoningError(
  policy: ReasoningPolicy | undefined,
  model: ModelProfileSnapshot,
  apply: boolean,
): string | null {
  if (!policy) return null;
  if (policy.mode === 'auto' && !apply)
    return 'automatic reasoning requires workspace apply to be enabled';
  if (model.auth === 'mock') return null;
  const capability = model.reasoning;
  if (policy.mode === 'provider_default')
    return capability?.providerDefault
      ? null
      : 'provider default reasoning is not verified for this transport';
  if (policy.mode === 'fixed')
    return capability?.levels.includes(policy.level)
      ? null
      : `reasoning ${policy.level} is not supported by this model`;
  return capability?.levels.includes('medium')
    ? null
    : 'automatic reasoning requires a supported medium level';
}

export function fixedReasoning(
  policy: ReasoningPolicy | undefined,
  preparationId: string,
): ReasoningResolution | undefined {
  if (!policy || policy.mode === 'auto') return undefined;
  return {
    requested: policy,
    resolved: policy.mode === 'fixed' ? policy.level : null,
    source: policy.mode,
    preparationId,
  };
}

/** The judged level if the model supports it, else the nearest higher one, else the nearest lower. */
function supportedLevel(level: EffortLevel, ladder: readonly EffortLevel[]): EffortLevel {
  const rank = EFFORT_LEVELS.indexOf(level);
  return ladder.find((l) => EFFORT_LEVELS.indexOf(l) >= rank) ?? ladder[ladder.length - 1]!;
}

const DEADLINE_MS = 3000;
/** Less time than this left after the local judge is not worth an outside call. */
const EXTERNAL_MIN_MS = 500;

/** The external judge for one request, set only when the run may ask it (live, opted in, key). */
export interface ExternalConsult {
  /** Monotonic milliseconds, the clock the shared deadline is measured on. */
  now(): number;
  ask(
    input: ReasoningInput,
    cancellation: DecisionCancellation,
  ): Promise<{ answer: string; model: string }>;
}

const failureReason = (error: unknown): NonNullable<ReasoningResolution['fallback']> => {
  const cause = error instanceof Error ? error.cause : undefined;
  return cause === 'timeout' || cause === 'invalid_response' || cause === 'unavailable'
    ? cause
    : 'provider_error';
};

/**
 * `corral-effort-v2`: supported low–xhigh levels, with review of uncertain high-risk low calls. The
 * 3 s deadline is set once and shared with the external judge asked when the local one abstains;
 * timeout/cancel settles the waiter while the provider keeps its real occupancy until the
 * computation ends.
 */
export async function automaticReasoning(
  input: ReasoningInput | undefined,
  base: ReasoningResolution,
  provider: DecisionProvider | undefined,
  candidates: readonly string[],
  cancellation: DecisionCancellation,
  timers: Scheduler,
  limit: boolean,
  external?: ExternalConsult,
): Promise<ReasoningResolution> {
  const fallback = (reason: NonNullable<ReasoningResolution['fallback']>): ReasoningResolution => ({
    ...base,
    resolved: 'medium',
    source: 'fallback',
    fallback: reason,
  });
  if (input?.kind === 'compaction') return { ...base, resolved: 'medium', source: 'compaction' };
  if (limit) return fallback('limit');
  if (!input) return fallback('missing_input');
  if (
    !provider?.decideRequest ||
    provider.id !== 'local-model' ||
    provider.privacy !== 'local' ||
    provider.available() !== true
  )
    return fallback('unavailable');
  const listeners = new Set<() => void>();
  let aborted = cancellation.aborted;
  const abort = () => {
    aborted = true;
    for (const fn of listeners) fn();
  };
  const signal: DecisionCancellation = {
    get aborted() {
      return aborted;
    },
    onCancel(fn) {
      listeners.add(fn);
      if (aborted) fn();
      return () => listeners.delete(fn);
    },
  };
  let off = () => {},
    stopTimer = () => {};
  const startedAt = external?.now();
  const stopped = new Promise<{ kind: 'cancel' } | { kind: 'timeout' }>((resolve) => {
    off = cancellation.onCancel(() => {
      abort();
      resolve({ kind: 'cancel' });
    });
    stopTimer = timers.after(DEADLINE_MS, () => {
      abort();
      resolve({ kind: 'timeout' });
    });
    if (cancellation.aborted) {
      abort();
      resolve({ kind: 'cancel' });
    }
  });
  const settled = <T>(work: Promise<T>) =>
    Promise.race([
      work.then(
        (answer) => ({ kind: 'answer' as const, answer }),
        (error: unknown) => ({ kind: 'error' as const, error }),
      ),
      stopped,
    ]);
  try {
    const result = await settled(provider.decideRequest(input, signal));
    if (cancellation.aborted || result.kind === 'cancel') throw new Error('reasoning cancelled');
    if (result.kind === 'timeout') return fallback('timeout');
    if (result.kind === 'error')
      return fallback(
        result.error instanceof Error && result.error.cause === 'timeout'
          ? 'timeout'
          : 'provider_error',
      );
    const answer = DecisionAnswer.safeParse(result.answer);
    if (
      !answer.success ||
      !answer.data.probabilities ||
      answer.data.evidenceLevel !== 'model_probability'
    )
      return fallback('invalid_response');
    const ladder = EFFORT_LEVELS.filter((level) => candidates.includes(level));
    if (!ladder.includes('medium')) return fallback('unavailable');
    const policy = {
      ladder,
      policyVersion: 'corral-effort-v2' as const,
      judgeVersion: provider.version,
    };
    if (
      !answer.data.abstain &&
      !lowEffortNeedsReview(answer.data.answer, answer.data.probabilities)
    )
      return {
        ...base,
        ...policy,
        resolved: supportedLevel(answer.data.answer, ladder),
        judged: answer.data.answer,
        source: 'local-model',
      };
    if (
      !external ||
      startedAt === undefined ||
      DEADLINE_MS - (external.now() - startedAt) < EXTERNAL_MIN_MS
    )
      return { ...fallback('abstained'), ...policy };
    // One outside call inside what is left of the same deadline; no retry, no averaging.
    const asked = await settled(external.ask(input, signal));
    if (cancellation.aborted || asked.kind === 'cancel') throw new Error('reasoning cancelled');
    const escalated = { ...policy, escalated: true as const };
    if (asked.kind === 'timeout') return { ...fallback('timeout'), ...escalated };
    if (asked.kind === 'error') return { ...fallback(failureReason(asked.error)), ...escalated };
    const level = EFFORT_LEVELS.find((l) => l === asked.answer.answer);
    const model = asked.answer.model;
    if (!level || typeof model !== 'string' || !model || model.length > 200)
      return { ...fallback('invalid_response'), ...escalated };
    return {
      ...base,
      ...escalated,
      judgeVersion: model,
      resolved: supportedLevel(level, ladder),
      judged: level,
      source: 'external-model',
    };
  } finally {
    off();
    stopTimer();
  }
}
