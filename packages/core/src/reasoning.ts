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

/**
 * `corral-effort-v1`: the local judgment applied to the model's supported low–xhigh levels. The
 * 3 s deadline is set once; timeout/cancel settles the waiter while the provider keeps its real
 * occupancy until the computation ends.
 */
export async function automaticReasoning(
  input: ReasoningInput | undefined,
  base: ReasoningResolution,
  provider: DecisionProvider | undefined,
  candidates: readonly string[],
  cancellation: DecisionCancellation,
  timers: Scheduler,
  limit: boolean,
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
  try {
    const result = await Promise.race([
      provider.decideRequest(input, signal).then(
        (answer) => ({ kind: 'answer' as const, answer }),
        (error: unknown) => ({ kind: 'error' as const, error }),
      ),
      new Promise<{ kind: 'cancel' } | { kind: 'timeout' }>((resolve) => {
        off = cancellation.onCancel(() => {
          abort();
          resolve({ kind: 'cancel' });
        });
        stopTimer = timers.after(3000, () => {
          abort();
          resolve({ kind: 'timeout' });
        });
        if (cancellation.aborted) {
          abort();
          resolve({ kind: 'cancel' });
        }
      }),
    ]);
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
      policyVersion: 'corral-effort-v1' as const,
      judgeVersion: provider.version,
    };
    if (answer.data.abstain) return { ...fallback('abstained'), ...policy };
    return {
      ...base,
      ...policy,
      resolved: supportedLevel(answer.data.answer, ladder),
      judged: answer.data.answer,
      source: 'local-model',
    };
  } finally {
    off();
    stopTimer();
  }
}
