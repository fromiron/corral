import {
  ProfileContextOverrides,
  type ProfileContextPolicy,
  type ProfileContextResolution,
} from '@corral/contracts';

export const PI_COMPACTION_DEFAULTS = { reserveTokens: 16_384, keepRecentTokens: 20_000 } as const;

/** One interpretation shared by save validation, preview and the frozen Run model snapshot. */
export function resolveProfileContext(
  input: ProfileContextOverrides,
  base: { contextWindow: number | null; source: ProfileContextPolicy['baseSource'] },
  configRevision: string,
  maxOutputTokens: number,
): ProfileContextResolution {
  const parsed = ProfileContextOverrides.safeParse({
    contextWindow: input.contextWindow,
    compaction: input.compaction,
  });
  if (!parsed.success)
    return {
      policy: null,
      errors: ['context policy fields must be safe integers in their permitted ranges'],
    };
  const profile = parsed.data;
  const contextWindow = profile.contextWindow ?? base.contextWindow;
  const explicit =
    profile.contextWindow !== undefined ||
    profile.compaction?.reserveTokens !== undefined ||
    profile.compaction?.keepRecentTokens !== undefined;
  if (contextWindow === null)
    return {
      policy: null,
      errors: explicit ? ['the model context limit is unknown; specify contextWindow'] : [],
    };
  const reserveTokens = profile.compaction?.reserveTokens ?? PI_COMPACTION_DEFAULTS.reserveTokens;
  const keepRecentTokens =
    profile.compaction?.keepRecentTokens ?? PI_COMPACTION_DEFAULTS.keepRecentTokens;
  const inconsistent =
    reserveTokens >= contextWindow || keepRecentTokens >= contextWindow - reserveTokens;
  const errors =
    explicit && inconsistent
      ? [
          'context policy requires reserveTokens < contextWindow and keepRecentTokens < contextWindow - reserveTokens',
        ]
      : [];
  const warnings: ProfileContextPolicy['warnings'] = [];
  if (inconsistent && !explicit) warnings.push('legacy_inconsistent');
  if (reserveTokens < maxOutputTokens) warnings.push('reserve_below_output');
  if (base.contextWindow !== null && contextWindow > base.contextWindow)
    warnings.push('above_model_limit');
  return {
    policy: {
      version: 1,
      contextWindow,
      reserveTokens,
      keepRecentTokens,
      explicit,
      configRevision,
      baseContextWindow: base.contextWindow,
      baseSource: base.source,
      sources: {
        contextWindow: profile.contextWindow !== undefined ? 'profile' : base.source,
        reserveTokens: profile.compaction?.reserveTokens !== undefined ? 'profile' : 'pi_default',
        keepRecentTokens:
          profile.compaction?.keepRecentTokens !== undefined ? 'profile' : 'pi_default',
      },
      warnings,
    },
    errors,
  };
}
