import { UltraSelection, UltraTeamSnapshot } from '@corral/contracts';
import { Checkbox, Select, Switch } from '@corral/react/design-kit';
import { useTranslations } from 'use-intl';
import type { ProfileInfo } from './useModels.ts';

type TournamentSelection = Extract<UltraSelection, { version: 2 }>;

export function defaultUltraSelection(
  primary: string,
  profiles: ProfileInfo[] | null,
): TournamentSelection {
  const main = profiles?.find((profile) => profile.profileId === primary);
  const candidates =
    profiles?.filter(
      (profile) =>
        profile.profileId !== primary &&
        profile.available &&
        profile.reasoningCapabilities?.levels.length &&
        (profile.modelId ?? profile.profileId) !== (main?.modelId ?? primary),
    ) ?? [];
  const other = candidates.find((profile) => profile.provider !== main?.provider) ?? candidates[0];
  return {
    version: 2,
    modelProfiles: [primary, ...(other ? [other.profileId] : [])],
    verifierProfile: other?.profileId ?? primary,
  };
}

/**
 * New Ultra requests use the CR-048 tournament. A draft saved with the earlier selection keeps
 * its pool and verifier; its opt-in comparison models become the tournament's candidates.
 */
export function currentUltraSelection(value: UltraSelection): TournamentSelection {
  if (value.version === 2) return value;
  return {
    version: 2,
    modelProfiles: value.modelProfiles,
    verifierProfile: value.verifierProfile,
    ...(value.comparison ? { candidates: value.comparison.modelProfiles } : {}),
  };
}

/** A selection recalled from a draft, request entry or Run snapshot; null when it has none. */
export function recalledUltraSelection(value: unknown): UltraSelection | null {
  const selection = UltraSelection.safeParse(value);
  if (selection.success) return selection.data;
  const snapshot = UltraTeamSnapshot.safeParse(value);
  if (!snapshot.success) return null;
  if (snapshot.data.version === 1) {
    const { reasoning: _reasoning, ...legacy } = snapshot.data;
    return legacy;
  }
  const { modelProfiles, verifierProfile, candidates, refinementRounds, autoApply } = snapshot.data;
  return { version: 2, modelProfiles, verifierProfile, candidates, refinementRounds, autoApply };
}

export function UltraModels({
  primary,
  profiles,
  value: selection,
  onChange,
  disabled,
}: {
  primary: string;
  profiles: ProfileInfo[] | null;
  value: UltraSelection;
  onChange: (value: TournamentSelection) => void;
  disabled: boolean;
}) {
  const t = useTranslations('Composer');
  const value = currentUltraSelection(selection);
  const candidates = value.candidates ?? value.modelProfiles;
  const labelOf = (id: string) =>
    profiles?.find((profile) => profile.profileId === id)?.label ?? id;
  const changePool = (id: string, checked: boolean) => {
    const pool = checked
      ? [...value.modelProfiles, id]
      : value.modelProfiles.filter((profile) => profile !== id);
    onChange({
      ...value,
      modelProfiles: pool,
      ...(value.candidates
        ? { candidates: value.candidates.map((id) => (pool.includes(id) ? id : primary)) }
        : {}),
      verifierProfile:
        pool.includes(value.verifierProfile) && value.verifierProfile !== primary
          ? value.verifierProfile
          : (pool.find((id) => id !== primary) ?? primary),
    });
  };
  return (
    <fieldset
      disabled={disabled}
      className="flex w-full min-w-0 flex-col gap-2 rounded fill-group p-3 text-xs"
    >
      <legend className="font-medium">{t('ultraModels')}</legend>
      <p className="text-muted-foreground">{t('ultraModelScope')}</p>
      <div className="flex flex-wrap gap-3">
        {[
          ...(profiles ?? []),
          ...value.modelProfiles
            .filter((id) => !profiles?.some((profile) => profile.profileId === id))
            .map((profileId) => ({
              profileId,
              label: profileId,
              available: false,
              reasoningCapabilities: undefined,
            })),
        ].map((profile) => {
          const checked = value.modelProfiles.includes(profile.profileId);
          return (
            <Checkbox
              key={profile.profileId}
              label={`${profile.label}${profile.profileId === primary ? ` (${t('ultraPrimary')})` : ''}`}
              checked={checked}
              disabled={
                profile.profileId === primary ||
                (!checked &&
                  (!profile.available ||
                    !profile.reasoningCapabilities?.levels.length ||
                    value.modelProfiles.length >= 5))
              }
              onToggle={() => changePool(profile.profileId, !checked)}
            />
          );
        })}
      </div>
      <span>{t('ultraVerifier')}</span>
      <Select
        label={t('ultraVerifier')}
        value={value.verifierProfile}
        disabled={disabled}
        onValueChange={(verifierProfile) => onChange({ ...value, verifierProfile })}
        options={[
          ...(value.verifierProfile === primary
            ? [{ value: primary, label: t('ultraNeedsModels'), disabled: true }]
            : []),
          ...value.modelProfiles
            .filter((profile) => profile !== primary)
            .map((id) => ({ value: id, label: labelOf(id) })),
        ]}
      />
      <p className="text-muted-foreground">{t('ultraMaximum')}</p>
      <p className="text-muted-foreground">{t('ultraTournamentScope')}</p>
      <span>{t('ultraCandidateCount')}</span>
      <Select
        label={t('ultraCandidateCount')}
        value={String(candidates.length)}
        disabled={disabled}
        options={[2, 3, 4, 5].map((count) => ({ value: String(count), label: String(count) }))}
        onValueChange={(count) =>
          onChange({
            ...value,
            candidates: Array.from(
              { length: Number(count) },
              (_, index) =>
                candidates[index] ??
                value.modelProfiles[index % value.modelProfiles.length] ??
                primary,
            ),
          })
        }
      />
      <div className="flex flex-wrap gap-2">
        {candidates.map((profileId, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: Candidate slots retain their position when their assigned model changes.
          <div key={index} className="flex min-w-0 flex-col gap-1">
            <span>{t('ultraCandidateModel', { number: index + 1 })}</span>
            <Select
              label={t('ultraCandidateModel', { number: index + 1 })}
              value={profileId}
              disabled={disabled}
              options={value.modelProfiles.map((id) => ({ value: id, label: labelOf(id) }))}
              onValueChange={(chosen) =>
                onChange({
                  ...value,
                  candidates: candidates.map((id, position) => (position === index ? chosen : id)),
                })
              }
            />
          </div>
        ))}
      </div>
      <span>{t('ultraRefinementRounds')}</span>
      <Select
        label={t('ultraRefinementRounds')}
        value={String(value.refinementRounds ?? 2)}
        disabled={disabled}
        options={[0, 1, 2, 3].map((rounds) => ({ value: String(rounds), label: String(rounds) }))}
        onValueChange={(rounds) => onChange({ ...value, refinementRounds: Number(rounds) })}
      />
      <Switch
        label={t('ultraAutoApply')}
        checked={value.autoApply ?? true}
        onToggle={() => onChange({ ...value, autoApply: !(value.autoApply ?? true) })}
      />
      <p role="note" className="text-warning">
        {t('ultraNoLimits')}
      </p>
    </fieldset>
  );
}
