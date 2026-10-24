import {
  ProfileContextOverrides,
  type ProfileContextPolicy,
  type ProfileContextResolution,
} from '@corral/contracts';
import { contextBudgetLimitsFor } from '@corral/pi-runtime-port/budget';

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
  const adaptive = contextBudgetLimitsFor({ contextWindow, maxTokens: maxOutputTokens });
  const reserveTokens = profile.compaction?.reserveTokens ?? adaptive.requestHeadroom;
  const keepRecentTokens =
    profile.compaction?.keepRecentTokens ??
    Math.min(
      adaptive.keepRecentTokens,
      Math.max(0, Math.floor((contextWindow - reserveTokens - 1) / 2)),
    );
  const inconsistent =
    reserveTokens >= contextWindow || keepRecentTokens >= contextWindow - reserveTokens;
  const errors = inconsistent
    ? [
        'context policy requires reserveTokens < contextWindow and keepRecentTokens < contextWindow - reserveTokens',
      ]
    : [];
  const warnings: ProfileContextPolicy['warnings'] = [];
  if (reserveTokens < maxOutputTokens) warnings.push('reserve_below_output');
  if (base.contextWindow !== null && contextWindow > base.contextWindow)
    warnings.push('above_model_limit');
  return {
    policy: {
      version: 2,
      contextWindow,
      reserveTokens,
      keepRecentTokens,
      explicit,
      configRevision,
      baseContextWindow: base.contextWindow,
      baseSource: base.source,
      sources: {
        contextWindow: profile.contextWindow !== undefined ? 'profile' : base.source,
        reserveTokens: profile.compaction?.reserveTokens !== undefined ? 'profile' : 'adaptive',
        keepRecentTokens:
          profile.compaction?.keepRecentTokens !== undefined ? 'profile' : 'adaptive',
      },
      warnings,
    },
    errors,
  };
}
