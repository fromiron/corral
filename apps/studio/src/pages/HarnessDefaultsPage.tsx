import type { HarnessDefault, HarnessProfileRevision, HarnessProfileView } from '@corral/contracts';
import { Button, Select } from '@corral/react/design-kit';
import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useServices } from '../services.tsx';
import { useSettingsNavigation } from '../workbench/navigation.ts';
import { ScopeLadder } from '../workbench/ScopeLadder.tsx';
import { useSettingsForm, useSettingsTask } from '../workbench/SettingsLifecycle.tsx';
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
        <ScopeLadder current={scope} />
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
  const [pinned, setPinned] = useState<HarnessProfileRevision | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const dirty = current !== null && draft !== bindingKey(current);
  const run = useSettingsTask(`default:${scope}:${scopeId}`);
  useSettingsForm({ dirty, pending: busy, save });
  useEffect(() => {
    if (!api) return;
    let active = true;
    void Promise.all([api.default(scope, scopeId), api.profileManagement()]).then(
      async ([value, list]) => {
        const pinned =
          value.binding && !list.some((p) => `${p.profileId}:${p.revision}` === bindingKey(value))
            ? await api.profile(value.binding).catch(() => null)
            : null;
        if (!active) return;
        setCurrent(value);
        setDraft(bindingKey(value));
        setProfiles(list);
        setPinned(pinned);
      },
      () => active && setError(t('loadFailed')),
    );
    return () => {
      active = false;
    };
  }, [api, scope, scopeId, t]);
  async function save() {
    if (!api || !current || busy || !dirty) return false;
    const picked = profiles.find((p) => `${p.profileId}:${p.revision}` === draft);
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const value = await run(() =>
        api.setDefault(
          current,
          picked ? { profileId: picked.profileId, revision: picked.revision } : null,
        ),
      );
      setCurrent(value);
      setDraft(bindingKey(value));
      setNotice(t('defaultSaved'));
      window.dispatchEvent(new Event('corral:harness-changed'));
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : t('error'));
      return false;
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <p className="text-sm text-muted-foreground">
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
                        label: `${pinned?.name ?? current.binding.profileId} · r${current.binding.revision}`,
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
              variant="tertiary"
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
        variant="tertiary"
        className="self-start"
        render={<Link {...navigation.link('harness')} />}
      >
        {r('manageProfiles')}
      </Button>
    </>
  );
}
