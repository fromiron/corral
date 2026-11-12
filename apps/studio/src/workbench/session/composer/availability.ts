import type { AutoModelChoice } from '@corral/contracts';
import type { SessionIntent } from '@corral/core';
import { autoNotReady, autoReasoningUnsupported } from '../../autoChoice.ts';
import type { Blocked } from '../../composerIntent.ts';
import type { ProfileInfo, RoleModel } from '../../useModels.ts';

// Whether the composer can send now, and why not: models, the team, the live runtime, and the
// items this intent cannot carry.

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
  hasLatest,
  steerTarget,
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
    chips: readonly unknown[];
    missingChips: readonly unknown[];
  };
  blocked: Blocked;
  hasLatest: boolean;
  steerTarget: string;
}) {
  const { attachmentsBusy, imagesBusy } = draft;
  const attachmentCount = draft.attachments.length;
  const imageCount = draft.images.length;
  const chipCount = draft.chips.length;
  const missingChipCount = draft.missingChips.length;
  // UX-04: with live models chosen, a role whose model is not connected stops the request
  // before it is sent, with the way to connect it.
  const notReady =
    runMode === 'live' && (intent === 'next' || intent === 'explain') && profiles
      ? roles.filter((r) => !profiles.some((p) => p.profileId === r.profileId && p.available))
      : [];
  // an auto request on a disconnected model is stopped, never simulated instead.
  const autoBlocked =
    isAuto &&
    (intent === 'next' || intent === 'explain') &&
    profiles !== null &&
    autoNotReady(autoChoice, profiles, runMode);
  const autoProfile = profiles?.find((p) => p.profileId === autoChoice.modelProfile);
  const reasoningBlocked =
    isAuto && intent === 'next' && autoReasoningUnsupported(autoChoice, profiles, runMode);
  const liveUnavailable =
    runMode === 'live' && !live && (intent === 'next' || intent === 'explain');
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
    (attachmentCount > 0 && intent !== 'next' && intent !== 'queue') ||
    autoBlocked ||
    reasoningBlocked ||
    notReady.length > 0 ||
    blocked !== null ||
    missingChipCount > 0 ||
    (missingTeam && (intent === 'next' || intent === 'explain')) ||
    (intent === 'explain' && !hasLatest) ||
    (intent === 'steer' && !steerTarget);
  // Items this intent does not carry share one notice and one wording (#89).
  const heldForNew = [
    ...(chipCount && intent !== 'next' ? (['references'] as const) : []),
    ...(imageCount > 0 && intent !== 'next' ? (['images'] as const) : []),
    ...(attachmentCount > 0 && intent !== 'next' && intent !== 'queue'
      ? (['attachments'] as const)
      : []),
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
