import type { HarnessPreview } from '@corral/client';
import type { AgentRole, HarnessProfileRevision } from '@corral/contracts';
import { useStudioStores } from '@corral/react';
import { Button } from '@corral/react/ui';
import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { HarnessPreviewView } from '../pages/HarnessSettingsPage.tsx';
import { useCurrentProject } from '../projects.ts';
import { useServices } from '../services.tsx';

export function HarnessRoleSettings({ role, nodeId }: { role: AgentRole; nodeId: string }) {
  const t = useTranslations('Harness');
  const { harnesses: api } = useServices();
  const { editor } = useStudioStores();
  const projectId = useCurrentProject();
  const [profiles, setProfiles] = useState<HarnessProfileRevision[]>([]);
  const [preview, setPreview] = useState<HarnessPreview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const selection = role.harness ? `${role.harness.profileId}:${role.harness.revision}` : '';
  useEffect(() => {
    if (!api) return;
    let active = true;
    const refresh = () => {
      void api.profiles().then(
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
    void selection;
    setPreview(null);
    setError('');
  }, [selection]);
  if (!api) return null;
  return (
    <section className="flex flex-col gap-2 border-y border-line py-3">
      <label className="flex flex-col gap-1 text-xs font-medium">
        {t('heading')}
        <select
          className="rounded-md border border-line bg-surface p-2 text-sm"
          value={selection}
          disabled={busy}
          onChange={(e) => {
            const profile = profiles.find((p) => `${p.profileId}:${p.revision}` === e.target.value);
            editor.getState().updateNode(nodeId, {
              harness: profile
                ? { profileId: profile.profileId, revision: profile.revision }
                : null,
            });
          }}
        >
          <option value="">{t('basic')}</option>
          {selection && !profiles.some((p) => `${p.profileId}:${p.revision}` === selection) ? (
            <option value={selection}>
              {role.harness?.profileId} · r{role.harness?.revision}
            </option>
          ) : null}
          {profiles.map((p) => (
            <option key={p.profileId} value={`${p.profileId}:${p.revision}`}>
              {p.name} · r{p.revision}
            </option>
          ))}
        </select>
      </label>
      <Link to="/settings/harness" className="text-xs text-accent underline">
        {t('manage')}
      </Link>
      {role.harness ? (
        <>
          <p className="text-xs text-muted">{t('pinned', { revision: role.harness.revision })}</p>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => {
              if (!role.harness) return;
              setBusy(true);
              setError('');
              void api
                .preview(role.harness, projectId)
                .then(setPreview, () => setError(t('error')))
                .finally(() => setBusy(false));
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
