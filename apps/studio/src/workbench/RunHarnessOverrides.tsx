import type { HarnessPreview } from '@corral/client';
import type {
  HarnessBindingRef,
  HarnessOverrides,
  HarnessProfileRevision,
} from '@corral/contracts';
import { Button } from '@corral/react/ui';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { HarnessPreviewView } from '../pages/HarnessSettingsPage.tsx';
import { useServices } from '../services.tsx';

export function RunHarnessOverrides({
  roles,
  projectId,
  value,
  onChange,
  disabled = false,
}: {
  roles: { roleId: string; name: string; harness?: HarnessBindingRef }[];
  projectId: string;
  value: HarnessOverrides;
  onChange(value: HarnessOverrides): void;
  disabled?: boolean;
}) {
  const { harnesses: api } = useServices();
  const t = useTranslations('Harness');
  const [profiles, setProfiles] = useState<HarnessProfileRevision[]>([]);
  const [failed, setFailed] = useState(false);
  const [preview, setPreview] = useState<{
    key: string;
    value?: HarnessPreview;
    error?: boolean;
  } | null>(null);
  const selectionKey = JSON.stringify([
    projectId,
    roles.map((role) => [role.roleId, role.harness]),
    value,
  ]);
  const request = useRef(0);
  useEffect(() => {
    void selectionKey;
    return () => {
      request.current += 1;
    };
  }, [selectionKey]);
  useEffect(() => {
    if (!api) return;
    let active = true;
    void api.profiles().then(
      (profiles) => {
        if (active) setProfiles(profiles);
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [api]);
  if (!api || !roles.some((role) => role.harness)) return null;
  return (
    <details className="rounded border border-line p-2 text-xs">
      <summary className="cursor-pointer">
        {t('runStyles')}
        {Object.keys(value).length ? ` · ${Object.keys(value).length}` : ''}
      </summary>
      <fieldset disabled={disabled} className="mt-2 flex flex-col gap-2">
        <p className="text-muted">{t('runStyleHint')}</p>
        {failed ? <p role="alert">{t('loadFailed')}</p> : null}
        {roles.flatMap((role) => {
          if (!role.harness) return [];
          const binding = role.harness,
            chosen = value[role.roleId],
            selected = chosen ? `${chosen.profileId}:${chosen.revision}` : '';
          return [
            <div key={role.roleId} className="flex flex-col gap-2">
              <label className="flex flex-col gap-1">
                {t('runStyleFor', { name: role.name })}
                <select
                  className="rounded border border-line bg-surface p-2"
                  value={selected}
                  onChange={(event) => {
                    const profile = profiles.find(
                      (profile) =>
                        `${profile.profileId}:${profile.revision}` === event.target.value,
                    );
                    const next = { ...value };
                    if (profile)
                      next[role.roleId] = {
                        profileId: profile.profileId,
                        revision: profile.revision,
                      };
                    else delete next[role.roleId];
                    onChange(next);
                    setPreview(null);
                  }}
                >
                  <option value="">{t('keepRoleStyle')}</option>
                  {selected &&
                  !profiles.some(
                    (profile) => `${profile.profileId}:${profile.revision}` === selected,
                  ) ? (
                    <option value={selected}>{selected}</option>
                  ) : null}
                  {profiles.map((profile) => (
                    <option
                      key={profile.profileId}
                      value={`${profile.profileId}:${profile.revision}`}
                    >
                      {profile.name} · r{profile.revision}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const key = selectionKey;
                  const version = ++request.current;
                  setPreview({ key });
                  void api.preview(binding, projectId, chosen).then(
                    (value) => {
                      if (version === request.current) setPreview({ key, value });
                    },
                    () => {
                      if (version === request.current) setPreview({ key, error: true });
                    },
                  );
                }}
              >
                {t('previewRunStyle', { name: role.name })}
              </Button>
            </div>,
          ];
        })}
        {preview?.key === selectionKey ? (
          <div data-testid="run-harness-preview">
            {preview.error ? (
              <p role="alert">{t('error')}</p>
            ) : preview.value ? (
              <HarnessPreviewView preview={preview.value} />
            ) : (
              <p role="status">{t('busy')}</p>
            )}
          </div>
        ) : null}
      </fieldset>
    </details>
  );
}
