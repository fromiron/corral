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
