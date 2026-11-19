import type { RoleHarnessPreview } from '@corral/client';
import type {
  HarnessBindingRef,
  HarnessOverrides,
  HarnessProfileView,
  RoleMcpToolRef,
  RoleSkillRef,
} from '@corral/contracts';
import { Button, Select } from '@corral/react/design-kit';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { HarnessPreviewView } from '../pages/HarnessSettingsPage.tsx';
import { useServices } from '../services.tsx';
import { McpPreviewProblem, RoleHarnessProblem } from './HarnessRoleSettings.tsx';

export function RunHarnessOverrides({
  roles,
  projectId,
  value,
  onChange,
  disabled = false,
}: {
  roles: {
    roleId: string;
    name: string;
    harness?: HarnessBindingRef;
    skills?: RoleSkillRef[];
    mcpTools?: RoleMcpToolRef[];
  }[];
  projectId: string;
  value: HarnessOverrides;
  onChange(value: HarnessOverrides): void;
  disabled?: boolean;
}) {
  const { harnesses: api } = useServices();
  const t = useTranslations('Harness');
  const [profiles, setProfiles] = useState<HarnessProfileView[]>([]);
  const [failed, setFailed] = useState(false);
  const [preview, setPreview] = useState<{
    key: string;
    value?: RoleHarnessPreview;
    skills?: RoleSkillRef[];
    error?: boolean;
  } | null>(null);
  const selectionKey = JSON.stringify([
    projectId,
    roles.map((role) => [role.roleId, role.harness, role.skills, role.mcpTools]),
    value,
  ]);
  const request = useRef(0);
  useEffect(() => {
    setPreview((current) => (current?.key === selectionKey ? current : null));
    return () => {
      request.current += 1;
    };
  }, [selectionKey]);
  useEffect(() => {
    if (!api) return;
    let active = true;
    void api.profileManagement().then(
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
    <details className="rounded fill-group p-2 text-caption">
      <summary className="cursor-pointer">
        {t('runStyles')}
        {Object.keys(value).length ? ` · ${Object.keys(value).length}` : ''}
      </summary>
      <fieldset disabled={disabled} className="mt-2 flex flex-col gap-2">
        <p className="text-muted-foreground">{t('runStyleHint')}</p>
        {failed ? <p role="alert">{t('loadFailed')}</p> : null}
        {roles.flatMap((role) => {
          if (!role.harness) return [];
          const binding = role.harness,
            chosen = value[role.roleId],
            selected = chosen ? `${chosen.profileId}:${chosen.revision}` : '';
          return [
            <div key={role.roleId} className="flex flex-col gap-2">
              <div className="flex flex-col gap-1">
                <span>{t('runStyleFor', { name: role.name })}</span>
                <Select
                  label={t('runStyleFor', { name: role.name })}
                  value={selected}
                  placeholder={t('keepRoleStyle')}
                  disabled={disabled}
                  options={[
                    { value: '', label: t('keepRoleStyle') },
                    ...(selected &&
                    !profiles.some(
                      (profile) => `${profile.profileId}:${profile.revision}` === selected,
                    )
                      ? [{ value: selected, label: selected }]
                      : []),
                    ...profiles
                      .filter(
                        (profile) =>
                          !profile.archivedAt ||
                          `${profile.profileId}:${profile.revision}` === selected,
                      )
                      .map((profile) => ({
                        value: `${profile.profileId}:${profile.revision}`,
                        label: `${profile.name} · r${profile.revision}`,
                      })),
                  ]}
                  onValueChange={(selection) => {
                    const profile = profiles.find(
                      (profile) => `${profile.profileId}:${profile.revision}` === selection,
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
                />
              </div>
              <Button
                variant="tertiary"
                onClick={() => {
                  const key = selectionKey;
                  const version = ++request.current;
                  setPreview({ key });
                  const result =
                    role.skills === undefined && role.mcpTools === undefined
                      ? api.preview(binding, projectId, chosen)
                      : api.preview(
                          {
                            id: role.roleId,
                            harness: binding,
                            ...(role.skills && { skills: role.skills }),
                            ...(role.mcpTools && { mcpTools: role.mcpTools }),
                          },
                          projectId,
                          chosen,
                        );
                  void result.then(
                    (value) => {
                      if (version === request.current)
                        setPreview({ key, value, skills: role.skills });
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
            {preview.value?.snapshot ? (
              <HarnessPreviewView preview={preview.value} />
            ) : preview.value?.problem || preview.value?.mcpProblem ? (
              <>
                {preview.value.problem && (
                  <RoleHarnessProblem problem={preview.value.problem} skills={preview.skills} />
                )}
                {preview.value.mcpProblem && (
                  <McpPreviewProblem problem={preview.value.mcpProblem} />
                )}
              </>
            ) : preview.error || preview.value ? (
              <p role="alert">{t('error')}</p>
            ) : (
              <p role="status">{t('busy')}</p>
            )}
          </div>
        ) : null}
      </fieldset>
    </details>
  );
}
