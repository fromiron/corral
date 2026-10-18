import type { HarnessPreview } from '@corral/client';
import type { AgentRole, HarnessProfileView } from '@corral/contracts';
import { useStudioStores } from '@corral/react';
import { Button, Select } from '@corral/react/ui';
import { Link } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { HarnessPreviewView } from '../pages/HarnessSettingsPage.tsx';
import { useCurrentProject } from '../projects.ts';
import { useServices } from '../services.tsx';

export function HarnessRoleSettings({ role, nodeId }: { role: AgentRole; nodeId: string }) {
  const t = useTranslations('Harness'),
    r = useTranslations('Resources');
  const { harnesses: api } = useServices();
  const { editor } = useStudioStores();
  const projectId = useCurrentProject();
  const [profiles, setProfiles] = useState<HarnessProfileView[]>([]);
  const [preview, setPreview] = useState<HarnessPreview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const selection = role.harness ? `${role.harness.profileId}:${role.harness.revision}` : '';
  const contextKey = `${projectId}:${nodeId}:${role.id}:${selection}`;
  const request = useRef(0);
  useEffect(() => {
    if (!api) return;
    let active = true;
    const refresh = () => {
      void api.profileManagement().then(
        (p) => active && setProfiles(p),
        () => active && setError(t('loadFailed')),
      );
    };
    refresh();
    window.addEventListener('focus', refresh);
    window.addEventListener('corral:harness-changed', refresh);
    return () => {
      active = false;
      window.removeEventListener('focus', refresh);
      window.removeEventListener('corral:harness-changed', refresh);
    };
  }, [api, t]);
  useEffect(() => {
    void contextKey;
    setPreview(null);
    setError('');
    setBusy(false);
    return () => {
      request.current += 1;
    };
  }, [contextKey]);
  if (!api) return null;
  return (
    <section className="flex flex-col gap-2 border-y border-line py-3">
      <div className="flex flex-col gap-1 text-xs font-medium">
        <span>{t('heading')}</span>
        <Select
          label={t('heading')}
          value={selection}
          disabled={busy}
          options={[
            { value: '', label: t('basic') },
            ...(selection &&
            !profiles.some((profile) => `${profile.profileId}:${profile.revision}` === selection)
              ? [
                  {
                    value: selection,
                    label: `${role.harness?.profileId} · r${role.harness?.revision}`,
                  },
                ]
              : []),
            ...profiles
              .filter(
                (profile) =>
                  !profile.archivedAt || `${profile.profileId}:${profile.revision}` === selection,
              )
              .map((profile) => ({
                value: `${profile.profileId}:${profile.revision}`,
                label: `${profile.name} · r${profile.revision}${profile.archivedAt ? ` · ${r('archived')}` : ''}`,
              })),
          ]}
          onValueChange={(value) => {
            const profile = profiles.find(
              (profile) => `${profile.profileId}:${profile.revision}` === value,
            );
            editor.getState().updateNode(nodeId, {
              harness: profile
                ? { profileId: profile.profileId, revision: profile.revision }
                : null,
            });
          }}
        />
      </div>
      <Link to="/settings/harness" className="text-xs text-accent underline">
        {t('manage')}
      </Link>
      {role.harness ? (
        <>
          <p className="text-xs text-muted">{t('pinned', { revision: role.harness.revision })}</p>
          {profiles.some(
            (profile) =>
              profile.profileId === role.harness?.profileId &&
              profile.revision > role.harness.revision,
          ) ? (
            <p className="text-xs text-warning">{r('profileOlder')}</p>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => {
              if (!role.harness) return;
              const version = ++request.current;
              setBusy(true);
              setError('');
              void api
                .preview(role.harness, projectId)
                .then(
                  (value) => {
                    if (version === request.current) setPreview(value);
                  },
                  () => {
                    if (version === request.current) setError(t('error'));
                  },
                )
                .finally(() => {
                  if (version === request.current) setBusy(false);
                });
            }}
          >
            {busy ? t('busy') : t('preview')}
          </Button>
        </>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
      {preview ? (
        <>
          <p className="text-xs text-warning">
            {preview.snapshot.policy === 'trusted-native' ? t('nativeWarning') : ''}
          </p>
          <HarnessPreviewView preview={preview} />
        </>
      ) : null}
    </section>
  );
}
