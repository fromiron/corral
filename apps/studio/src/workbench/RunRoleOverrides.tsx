import type { RoleRunOverrides } from '@corral/contracts';
import { ReasoningSelect } from '@corral/react';
import { Select } from '@corral/react/ui';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import type { ProfileInfo, RoleModel } from './useModels.ts';

/** This request only; changing a team's defaults remains an editor action. */
export function RunRoleOverrides({
  roles,
  profiles,
  value,
  onChange,
}: {
  roles: RoleModel[];
  profiles: ProfileInfo[] | null;
  value: RoleRunOverrides;
  onChange: (value: RoleRunOverrides) => void;
}) {
  const t = useTranslations('Reasoning');
  const [open, setOpen] = useState(false);
  if (!roles.length) return null;
  return (
    <details
      className="rounded border border-line p-2 text-xs"
      data-testid="run-role-overrides"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer font-medium">{t('runOverrides')}</summary>
      {open ? (
        <div className="mt-2 flex flex-col gap-3">
          {roles.map((role) => {
            const override = value[role.roleId] ?? {};
            const profile = profiles?.find(
              (p) => p.profileId === (override.modelProfile ?? role.profileId),
            );
            const update = (change: typeof override) => {
              const next = { ...value };
              if (Object.keys(change).length) next[role.roleId] = change;
              else delete next[role.roleId];
              onChange(next);
            };
            return (
              <fieldset key={role.roleId} className="flex flex-col gap-1">
                <legend className="font-semibold">{role.name}</legend>
                <Select
                  label={`${role.name} · ${t('model')}`}
                  value={override.modelProfile ?? ''}
                  onValueChange={(modelProfile) => {
                    const next = { ...override };
                    if (modelProfile) next.modelProfile = modelProfile;
                    else delete next.modelProfile;
                    update(next);
                  }}
                  options={[
                    { value: '', label: `${t('inherit')} · ${role.profileId}` },
                    ...(profiles ?? []).map((p) => ({ value: p.profileId, label: p.label })),
                  ]}
                />
                <ReasoningSelect
                  inherit
                  value={override.reasoning}
                  capabilities={profile?.reasoningCapabilities}
                  onChange={(policy) => {
                    const next = { ...override };
                    if (policy) next.reasoning = policy;
                    else delete next.reasoning;
                    update(next);
                  }}
                />
                <span className="text-muted">
                  {t('saved')}:{' '}
                  {role.reasoning?.mode === 'fixed'
                    ? role.reasoning.level
                    : (role.reasoning?.mode ?? t('legacy'))}
                </span>
              </fieldset>
            );
          })}
        </div>
      ) : null}
    </details>
  );
}
