import {
  type ModelProfileSnapshot,
  ReasoningLevel,
  type ReasoningPolicy,
  type ReasoningResolution,
} from '@corral/contracts';

/** A level's place in the order from off to max. */
export const levelRank = (level: ReasoningLevel) => ReasoningLevel.options.indexOf(level);

/**
 * The highest level at or below `level` that a model can be asked for, never off; null when it
 * can use none of them.
 */
export function fittedLevel(
  level: ReasoningLevel,
  model: ModelProfileSnapshot,
): ReasoningLevel | null {
  for (let rank = levelRank(level); rank > 0; rank--) {
    const candidate = ReasoningLevel.options[rank] as ReasoningLevel;
    if (!reasoningError({ mode: 'fixed', level: candidate }, model)) return candidate;
  }
  return null;
}

export function reasoningError(
  policy: ReasoningPolicy | undefined,
  model: ModelProfileSnapshot,
): string | null {
  if (!policy) return null;
  if (model.auth === 'mock') return null;
  const capability = model.reasoning;
  if (policy.mode === 'auto')
    return capability?.providerDefault
      ? null
      : 'automatic reasoning requires a verified provider default for this transport';
  if (policy.mode === 'provider_default')
    return capability?.providerDefault
      ? null
      : 'provider default reasoning is not verified for this transport';
  return capability?.levels.includes(policy.level)
    ? null
    : `reasoning ${policy.level} is not supported by this model`;
}

/** A fixed level or the provider default, as asked: never judged. */
export function fixedReasoning(
  policy: ReasoningPolicy | undefined,
  preparationId: string,
): ReasoningResolution | undefined {
  if (!policy || policy.mode === 'auto') return undefined;
  return {
    preparationId,
    requested: policy,
    resolved: policy.mode === 'fixed' ? policy.level : null,
    source: policy.mode === 'fixed' ? 'fixed' : 'provider-default',
  };
}
