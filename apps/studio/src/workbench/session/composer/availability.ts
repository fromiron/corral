import type { AutoModelChoice } from '@corral/contracts';
import type { SessionIntent } from '@corral/core';
import { autoNotReady, autoReasoningUnsupported } from '../../autoChoice.ts';
import type { Blocked } from '../../composerIntent.ts';
import type { ProfileInfo, RoleModel } from '../../useModels.ts';

// Whether the composer can send now, and why not: models, the team, the live runtime, and the
// items this intent cannot carry.

/** A run starts with at most this many references, text attachments and images together. */
export const START_ITEMS_MAX = 20;

/**
 * How many references, text attachments and images a new or next request has over the limit
 * (features/composer-flow.md "합류 대상"); 0 for any other send, which starts no run.
 */
export function startItemsOver(
  intent: SessionIntent,
  draft: {
    references: readonly unknown[];
    attachments: readonly unknown[];
    images: readonly unknown[];
  },
): number {
  if (intent !== 'next' && intent !== 'queue') return 0;
  return Math.max(
    0,
    draft.references.length + draft.attachments.length + draft.images.length - START_ITEMS_MAX,
  );
}

export function composerAvailability({
  intent,
  runMode,
  live,
  isAuto,
  missingTeam,
  roles,
  profiles,
  autoChoice,
  draft,
  blocked,
  steerTarget,
  loading,
}: {
  intent: SessionIntent;
  runMode: 'mock' | 'live';
  live: boolean;
  isAuto: boolean;
  missingTeam: boolean;
  roles: RoleModel[];
  profiles: ProfileInfo[] | null;
  autoChoice: AutoModelChoice;
  draft: {
    attachmentsBusy: boolean;
    imagesBusy: boolean;
    attachments: readonly unknown[];
    images: readonly unknown[];
    references: readonly unknown[];
    chips: readonly unknown[];
    missingChips: readonly unknown[];
  };
  blocked: Blocked;
  steerTarget: string;
  /** The run's record is not read yet, so where Send goes is not known. */
  loading: boolean;
}) {
  const { attachmentsBusy, imagesBusy } = draft;
  const imageCount = draft.images.length;
  const chipCount = draft.chips.length;
  const missingChipCount = draft.missingChips.length;
  // UX-04: with live models chosen, a role whose model is not connected stops the request
  // before it is sent, with the way to connect it.
  const notReady =
    runMode === 'live' && intent === 'next' && profiles
      ? roles.filter((r) => !profiles.some((p) => p.profileId === r.profileId && p.available))
      : [];
  // an auto request on a disconnected model is stopped, never simulated instead.
  const autoBlocked =
    isAuto && intent === 'next' && profiles !== null && autoNotReady(autoChoice, profiles, runMode);
  const autoProfile = profiles?.find((p) => p.profileId === autoChoice.modelProfile);
  const reasoningBlocked =
    isAuto && intent === 'next' && autoReasoningUnsupported(autoChoice, profiles, runMode);
  const liveUnavailable = runMode === 'live' && !live && intent === 'next';
  const savedRequestUnavailable =
    missingTeam ||
    (runMode === 'live' && !live) ||
    (isAuto && profiles !== null && autoNotReady(autoChoice, profiles, runMode)) ||
    (isAuto && autoReasoningUnsupported(autoChoice, profiles, runMode)) ||
    (runMode === 'live' &&
      profiles !== null &&
      roles.some(
        (role) =>
          !profiles.some((profile) => profile.profileId === role.profileId && profile.available),
      ));
  const unavailable =
    liveUnavailable ||
    attachmentsBusy ||
    imagesBusy ||
    loading ||
    autoBlocked ||
    reasoningBlocked ||
    notReady.length > 0 ||
    blocked !== null ||
    missingChipCount > 0 ||
    startItemsOver(intent, draft) > 0 ||
    (missingTeam && intent === 'next') ||
    (intent === 'steer' && !steerTarget);
  // Items this intent does not carry share one notice and one wording (#89). Text attachments
  // ride every send; references and images a new or a next request (features/composer-flow.md
  // "합류 대상").
  const forNewRun = intent === 'next' || intent === 'queue';
  const heldForNew = [
    ...(chipCount && !forNewRun ? (['references'] as const) : []),
    ...(imageCount > 0 && !forNewRun ? (['images'] as const) : []),
  ];
  return {
    notReady,
    autoBlocked,
    autoProfile,
    reasoningBlocked,
    liveUnavailable,
    savedRequestUnavailable,
    unavailable,
    heldForNew,
  };
}
