import type { ModelProfileSnapshot, ReasoningPolicy, ReasoningResolution } from '@corral/contracts';

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

/**
 * An automatic request with the effort mode off (features/effort-routing.md): no judge, the
 * provider default. A compaction request keeps the internal medium policy where the model has it.
 */
export function automaticReasoning(
  compaction: boolean,
  levels: readonly string[],
  preparationId: string,
): ReasoningResolution {
  const requested = { mode: 'auto' } as const;
  if (compaction)
    return {
      requested,
      resolved: levels.includes('medium') ? 'medium' : null,
      source: 'internal-policy',
      preparationId,
    };
  return { requested, resolved: null, source: 'off', preparationId };
}
