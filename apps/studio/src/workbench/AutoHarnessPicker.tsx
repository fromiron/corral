import type { HarnessBindingRef, HarnessProfileView } from '@corral/contracts';
import { Select } from '@corral/react/ui';
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useServices } from '../services.tsx';

/** An explicit pinned work style for Auto; choosing it never grants trust. */
export function AutoHarnessPicker({
  value,
  onChange,
  disabled,
}: {
  value: HarnessBindingRef | undefined;
  onChange: (value: HarnessBindingRef | undefined) => void;
  disabled: boolean;
}) {
  const { harnesses: api } = useServices();
  const t = useTranslations('Composer');
  const h = useTranslations('Harness');
  const [profiles, setProfiles] = useState<HarnessProfileView[]>([]);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    void revision;
    if (!api) return;
    let active = true;
    void api.profileManagement().then(
      (profiles) => {
        if (active) {
          setProfiles(profiles);
          setFailed(false);
        }
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [api, revision]);
  if (!api) return null;
  const key = value ? `${value.profileId}:${value.revision}` : '';
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Select
        variant="chip"
        label={t('autoHarnessLabel')}
        value={key}
        disabled={disabled}
        onOpenChange={(open) => {
          if (open) setRevision((n) => n + 1);
        }}
        options={[
          { value: '', label: t('autoHarnessDefault') },
          ...(key && !profiles.some((profile) => `${profile.profileId}:${profile.revision}` === key)
            ? [{ value: key, label: `${value?.profileId} · r${value?.revision}`, disabled: true }]
            : []),
          ...profiles
            .filter(
              (profile) =>
                !profile.archivedAt || `${profile.profileId}:${profile.revision}` === key,
            )
            .map((profile) => ({
              value: `${profile.profileId}:${profile.revision}`,
              label: `${profile.name} · r${profile.revision}`,
              disabled: Boolean(profile.archivedAt),
            })),
        ]}
        onValueChange={(key) => {
          if (!key) return onChange(undefined);
          const profile = profiles.find(
            (profile) => `${profile.profileId}:${profile.revision}` === key,
          );
          if (profile) onChange({ profileId: profile.profileId, revision: profile.revision });
        }}
      />
      {failed ? (
        <p role="alert" className="text-xs text-danger">
          {h('loadFailed')}
        </p>
      ) : null}
    </div>
  );
}
