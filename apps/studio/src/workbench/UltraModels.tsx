import type { UltraSelection } from '@corral/contracts';
import { Select } from '@corral/react/ui';
import { useTranslations } from 'use-intl';
import type { ProfileInfo } from './useModels.ts';

export function defaultUltraSelection(
  primary: string,
  profiles: ProfileInfo[] | null,
): UltraSelection {
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
    version: 1,
    modelProfiles: [primary, ...(other ? [other.profileId] : [])],
    verifierProfile: other?.profileId ?? primary,
  };
}

export function UltraModels({
  primary,
  profiles,
  value,
  onChange,
  disabled,
}: {
  primary: string;
  profiles: ProfileInfo[] | null;
  value: UltraSelection;
  onChange: (value: UltraSelection) => void;
  disabled: boolean;
}) {
  const t = useTranslations('Composer');
  const changePool = (id: string, checked: boolean) => {
    const pool = checked
      ? [...value.modelProfiles, id]
      : value.modelProfiles.filter((profile) => profile !== id);
    onChange({
      ...value,
      modelProfiles: pool,
      verifierProfile:
        pool.includes(value.verifierProfile) && value.verifierProfile !== primary
          ? value.verifierProfile
          : (pool.find((id) => id !== primary) ?? primary),
    });
  };
  return (
    <fieldset
      disabled={disabled}
      className="flex w-full min-w-0 flex-col gap-2 rounded border border-line p-3 text-xs"
    >
      <legend className="font-medium">{t('ultraModels')}</legend>
      <p className="text-muted">{t('ultraModelScope')}</p>
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
            <label key={profile.profileId} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={checked}
                disabled={
                  profile.profileId === primary ||
                  (!checked &&
                    (!profile.available ||
                      !profile.reasoningCapabilities?.levels.length ||
                      value.modelProfiles.length >= 5))
                }
                onChange={(event) => changePool(profile.profileId, event.target.checked)}
              />
              {profile.label}
              {profile.profileId === primary ? ` (${t('ultraPrimary')})` : ''}
            </label>
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
            .map((id) => ({
              value: id,
              label: profiles?.find((profile) => profile.profileId === id)?.label ?? id,
            })),
        ]}
      />
      <p className="text-muted">{t('ultraMaximum')}</p>
    </fieldset>
  );
}
