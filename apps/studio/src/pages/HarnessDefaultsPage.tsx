import type { HarnessDefault, HarnessProfileView } from '@corral/contracts';
import { Button, Select } from '@corral/react/ui';
import { Link, useBlocker } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useServices } from '../services.tsx';
import { useSettingsNavigation } from '../workbench/navigation.ts';
import { SettingsLayout } from './SettingsPage.tsx';

const bindingKey = (value: HarnessDefault) =>
  value.binding ? `${value.binding.profileId}:${value.binding.revision}` : '';

export function HarnessDefaultsPage({ scope }: { scope: 'personal' | 'project' }) {
  const navigation = useSettingsNavigation();
  const n = useTranslations('Navigation');
  const scopeId = scope === 'personal' ? 'default' : navigation.projectId;
  return (
    <SettingsLayout active={scope === 'personal' ? 'defaults' : 'project-defaults'}>
      <main className="settings-content">
        <h2 className="text-2xl font-semibold">
          {n(scope === 'personal' ? 'personalDefaults' : 'projectDefaults')}
        </h2>
        {scopeId ? (
          <DefaultsEditor key={`${scope}:${scopeId}`} scope={scope} scopeId={scopeId} />
        ) : null}
      </main>
    </SettingsLayout>
  );
}

function DefaultsEditor({ scope, scopeId }: { scope: 'personal' | 'project'; scopeId: string }) {
  const { harnesses: api } = useServices();
  const navigation = useSettingsNavigation();
  const t = useTranslations('Harness');
  const r = useTranslations('Resources');
  const [current, setCurrent] = useState<HarnessDefault | null>(null);
  const [profiles, setProfiles] = useState<HarnessProfileView[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const dirty = current !== null && draft !== bindingKey(current);
  useBlocker({
    shouldBlockFn: () => dirty && !window.confirm(r('leaveUnsaved')),
    enableBeforeUnload: () => dirty,
  });
  useEffect(() => {
    if (!api) return;
    let active = true;
    void Promise.all([api.default(scope, scopeId), api.profileManagement()]).then(
      ([value, list]) => {
        if (!active) return;
        setCurrent(value);
        setDraft(bindingKey(value));
        setProfiles(list);
      },
      () => active && setError(t('loadFailed')),
    );
    return () => {
      active = false;
    };
  }, [api, scope, scopeId, t]);
  async function save() {
    if (!api || !current || busy || !dirty) return;
    const picked = profiles.find((p) => `${p.profileId}:${p.revision}` === draft);
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const value = await api.setDefault(
        current,
        picked ? { profileId: picked.profileId, revision: picked.revision } : null,
      );
      setCurrent(value);
      setDraft(bindingKey(value));
      setNotice(t('defaultSaved'));
      window.dispatchEvent(new Event('corral:harness-changed'));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('error'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <p className="text-sm text-muted">
        {t(scope === 'personal' ? 'personalDefaultHint' : 'projectDefaultHint')}
      </p>
      {!api ? (
        <p>{t('localOnly')}</p>
      ) : (
        <>
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
          <section className="settings-row">
            <div>
              <h3>{t(scope)}</h3>
              <p>{t('defaultsHint')}</p>
            </div>
            <Select
              label={t(scope)}
              value={draft}
              disabled={!current || busy}
              className="h-9 w-full sm:w-72"
              onValueChange={(value) => {
                setDraft(value);
                setNotice('');
              }}
              options={[
                { value: '', label: t('none') },
                ...(current?.binding &&
                !profiles.some((p) => `${p.profileId}:${p.revision}` === bindingKey(current))
                  ? [
                      {
                        value: bindingKey(current),
                        label: `${current.binding.profileId} · r${current.binding.revision}`,
                      },
                    ]
                  : []),
                ...profiles
                  .filter((p) => !p.archivedAt || `${p.profileId}:${p.revision}` === draft)
                  .map((p) => ({
                    value: `${p.profileId}:${p.revision}`,
                    label: `${p.name} · r${p.revision}`,
                  })),
              ]}
            />
          </section>
          <div className="flex gap-2">
            <Button disabled={!dirty || busy} onClick={() => void save()}>
              {r('save')}
            </Button>
            <Button
              variant="outline"
              disabled={!dirty || busy}
              onClick={() => {
                if (current) setDraft(bindingKey(current));
                setError('');
              }}
            >
              {r('cancel')}
            </Button>
          </div>
          <p role="status" className="text-sm">
            {busy ? t('busy') : notice}
          </p>
        </>
      )}
      <Button
        variant="outline"
        className="self-start"
        render={<Link to="/settings/harness" search={navigation.search} />}
      >
        {r('manageProfiles')}
      </Button>
    </>
  );
}
