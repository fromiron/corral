import type { ModelProfileView, ProviderAuthView, ReasoningSettings } from '@corral/client';
import { Button, Input, Switch } from '@corral/react/design-kit';
import { type FormEvent, useEffect, useState } from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import { useServices } from '../services.tsx';
import {
  ModelSettingsRefresh,
  useModelSettings,
  useModelSettingsRefresh,
} from '../workbench/modelSettings.tsx';
import { SectionIndex } from '../workbench/SectionIndex.tsx';
import { useSettingsForm, useSettingsTask } from '../workbench/SettingsLifecycle.tsx';
import { ApiKeyInput } from './ApiKeyInput.tsx';
import { ImageProfileSettings } from './ImageProfileSettings.tsx';
import { LocalAiPanel } from './LocalAiPanel.tsx';
import { ModelConfigEditor } from './ModelConfigEditor.tsx';
import { ModelImportPanel } from './ModelImportPanel.tsx';
import { ModelUsagePanel } from './ModelUsagePanel.tsx';
import { SettingsLayout } from './SettingsPage.tsx';

/**
 * /settings/models. Sign-in happens on the provider's own page, opened by
 * the person; this page only shows status and expiry. No token is ever sent here.
 */
export function ModelSettingsPage() {
  const t = useTranslations('Models');
  const ti = useTranslations('ModelImport');
  const tim = useTranslations('ImageProfiles');
  const tr = useTranslations('Reasoning');
  const tu = useTranslations('ModelUsage');
  const tl = useTranslations('LocalAi');
  const { models, mode, live } = useServices();
  const { profiles, providers, catalog, config, refresh, error, loading } =
    useModelSettings(models);
  const [editing, setEditing] = useState(false);
  // A finished local AI install changes what automatic reasoning can use.
  const [localAiInstalls, setLocalAiInstalls] = useState(0);

  return (
    <ModelSettingsRefresh value={refresh}>
      <SettingsLayout active="models">
        <main className="settings-content">
          <h2 className="text-2xl font-semibold">{t('heading')}</h2>
          {error ? (
            <p role="alert" className="text-danger">
              {t('loadFailed')}{' '}
              <Button onClick={() => void refresh().catch(() => {})}>{t('tryAgain')}</Button>
            </p>
          ) : null}
          {loading ? <p role="status">{t('loading')}</p> : null}
          {mode !== 'server' || !models ? (
            <p className="text-sm text-muted-foreground">{t('browserOnly')}</p>
          ) : !live ? (
            <p className="text-sm text-muted-foreground">{t('noLive')}</p>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">{t('intro')}</p>
              <SectionIndex
                sections={[
                  { id: 'models-profiles', label: t('profiles') },
                  { id: 'models-providers', label: t('providers') },
                  { id: 'models-import', label: ti('heading') },
                  { id: 'models-images', label: tim('heading') },
                  { id: 'models-reasoning', label: tr('workspaceHeading') },
                  { id: 'models-local-ai', label: tl('heading') },
                  { id: 'models-usage', label: tu('heading') },
                ]}
              />
              {editing && config ? (
                <div id="models-profiles" tabIndex={-1} className="outline-none">
                  <ModelConfigEditor
                    config={config}
                    catalog={catalog}
                    onDone={() => setEditing(false)}
                  />
                </div>
              ) : (
                <div
                  id="models-profiles"
                  tabIndex={-1}
                  className="flex flex-col gap-3 outline-none"
                >
                  <ProfilesTable
                    profiles={profiles}
                    {...(config ? { onEdit: () => setEditing(true) } : {})}
                  />
                  {config ? (
                    <Button
                      variant="tertiary"
                      size="compact"
                      type="button"
                      onClick={() => setEditing(true)}
                      className="self-start"
                    >
                      {t('editModels')}
                    </Button>
                  ) : null}
                </div>
              )}
              <section
                id="models-providers"
                tabIndex={-1}
                aria-labelledby="providers-heading"
                className="flex flex-col gap-2 outline-none"
              >
                <h3 id="providers-heading" className="text-sm font-semibold">
                  {t('providers')}
                </h3>
                {providers.map((provider) => (
                  <ProviderCard
                    key={`${provider.providerId}:${config?.modelProviders.find((endpoint) => endpoint.id === provider.providerId)?.baseUrl ?? ''}`}
                    provider={provider}
                    revision={config?.revision}
                  />
                ))}
              </section>
              <div id="models-import" tabIndex={-1} className="outline-none">
                <ModelImportPanel />
              </div>
              <div id="models-images" tabIndex={-1} className="outline-none">
                <ImageProfileSettings modelProfiles={profiles} />
              </div>
              <div id="models-reasoning" tabIndex={-1} className="outline-none">
                <ReasoningSettingsPanel key={`${config?.revision}:${localAiInstalls}`} />
              </div>
              <div id="models-local-ai" tabIndex={-1} className="outline-none">
                <LocalAiPanel onInstalled={() => setLocalAiInstalls((count) => count + 1)} />
              </div>
              <ModelUsagePanel />
            </>
          )}
        </main>
      </SettingsLayout>
    </ModelSettingsRefresh>
  );
}

function ProviderCard({
  provider,
  revision,
}: {
  provider: ProviderAuthView;
  revision: string | undefined;
}) {
  const t = useTranslations('Models');
  const format = useFormatter();
  const { models } = useServices();
  const refresh = useModelSettingsRefresh();
  const [redirect, setRedirect] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const login = provider.login;
  const borrowed = provider.source === 'codex-cli';
  // A key the page can remove: one entered here, not one from the server environment.
  const ownKey = provider.method === 'api_key' && provider.source === 'corral';

  const runSettingsTask = useSettingsTask(`provider:${provider.providerId}`);
  useSettingsForm({
    dirty: Boolean(apiKey || redirect),
    pending: busy,
    ...(!redirect && apiKey.trim() ? { save: persistKey } : {}),
  });
  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await runSettingsTask(action);
      await refresh();
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const submitRedirect = (event: FormEvent) => {
    event.preventDefault();
    if (!redirect.trim()) return;
    void act(async () => {
      await models?.submitRedirect(provider.providerId, redirect.trim());
      setRedirect('');
    });
  };

  async function persistKey() {
    const key = apiKey.trim();
    if (!key || !models || busy) return false;
    return act(async () => {
      await models.setApiKey(provider.providerId, key, revision);
      setApiKey('');
    });
  }
  const saveKey = (event: FormEvent) => {
    event.preventDefault();
    void persistKey();
  };

  return (
    <article
      tabIndex={-1}
      aria-label={provider.name}
      className="settings-surface flex flex-col gap-3 outline-none focus-visible:outline-2 focus-visible:outline-focus-ring"
      data-testid={`provider-${provider.providerId}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="font-medium">{provider.name}</h4>
        <div className="flex items-center gap-2 text-xs">
          {(provider.method === 'oauth' && !borrowed) || ownKey ? (
            <Button
              variant="tertiary"
              size="compact"
              type="button"
              disabled={busy}
              onClick={() =>
                void act(() => models?.logout(provider.providerId) ?? Promise.resolve())
              }
              className="self-start"
            >
              {ownKey ? t('removeKey') : t('signOut')}
            </Button>
          ) : null}
          {provider.methods.oauth && (!provider.signedIn || borrowed) && !login ? (
            <Button
              variant="tertiary"
              size="compact"
              type="button"
              disabled={busy}
              onClick={() =>
                void act(() => models?.startLogin(provider.providerId) ?? Promise.resolve())
              }
            >
              {borrowed ? t('signInInstead') : t('signIn')}
            </Button>
          ) : null}
        </div>
      </div>
      <p role="status" className="text-sm" data-testid="auth-status">
        {borrowed
          ? t('signedInCodex')
          : provider.method === 'oauth'
            ? t('signedInOauth', { subscription: String(provider.subscription) })
            : provider.method === 'none'
              ? t('keyless')
              : provider.method === 'api_key'
                ? provider.source === 'environment'
                  ? t('signedInEnvKey')
                  : t('signedInKey')
                : t('notSignedIn')}
      </p>
      {provider.endpoint ? (
        <p className="text-xs text-muted-foreground">
          {t('endpoint', { host: provider.endpoint })}
        </p>
      ) : null}
      {provider.endpoint ? (
        <div className="flex flex-col items-start gap-2 text-xs">
          <p className="text-muted-foreground">{t('connectionTestHint')}</p>
          <Button
            variant="tertiary"
            size="compact"
            disabled={busy || !revision}
            onClick={() =>
              revision &&
              void act(
                () => models?.testEndpoint(provider.providerId, revision) ?? Promise.resolve(),
              )
            }
          >
            {t('testConnection')}
          </Button>
          {provider.connectionTest ? (
            <p role="status">
              {t(`connectionTest.${provider.connectionTest.kind}`)}
              {' · '}
              {format.dateTime(new Date(provider.connectionTest.checkedAt), {
                hour: 'numeric',
                minute: 'numeric',
              })}
              {provider.connectionTest.status ? ` · HTTP ${provider.connectionTest.status}` : ''}
            </p>
          ) : null}
        </div>
      ) : null}
      {provider.endpointChanged ? (
        <p role="alert" className="text-xs text-danger">
          {t('endpointChanged')}
        </p>
      ) : null}
      {provider.expiresAt && provider.method === 'oauth' ? (
        <p className="text-xs text-muted-foreground">
          {t('expires', {
            time: format.dateTime(new Date(provider.expiresAt), {
              dateStyle: 'medium',
              timeStyle: 'short',
            }),
          })}
        </p>
      ) : null}
      {borrowed ? <p className="text-xs text-muted-foreground">{t('codexHint')}</p> : null}
      {borrowed && !provider.permissionsOk ? (
        <p role="alert" className="text-xs text-danger">
          {t('codexPermissions')}
        </p>
      ) : null}

      {provider.methods.apiKey && (!provider.signedIn || borrowed) && !login ? (
        <form onSubmit={saveKey} className="flex flex-col gap-1">
          <div className="flex items-end gap-2">
            <ApiKeyInput value={apiKey} onChange={setApiKey} disabled={busy} />
            <Button variant="primary" type="submit" disabled={busy || !apiKey.trim()}>
              {t('saveKey')}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t('keyHint')}</p>
        </form>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      {login && login.state !== 'failed' ? (
        <div className="flex flex-col gap-2 rounded-lg bg-surface p-3 text-sm">
          {login.authUrl ? (
            <Button
              className="self-start"
              render={<a href={login.authUrl} target="_blank" rel="noopener noreferrer" />}
            >
              {t('openSignIn')}
            </Button>
          ) : null}
          <p className="text-xs text-muted-foreground">
            {login.state === 'exchanging' ? t('exchanging') : t('openHint')}
          </p>
          <form onSubmit={submitRedirect} className="flex flex-col gap-1">
            <label
              htmlFor={`redirect-${provider.providerId}`}
              className="text-xs text-muted-foreground"
            >
              {t('pasteLabel')}
            </label>
            <div className="flex gap-2">
              <Input
                id={`redirect-${provider.providerId}`}
                disabled={busy}
                value={redirect}
                onChange={(e) => setRedirect(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                className="min-w-0 flex-1 font-mono"
              />
              <Button
                variant="tertiary"
                size="compact"
                type="submit"
                disabled={busy}
                className="self-start"
              >
                {t('paste')}
              </Button>
              <Button
                variant="tertiary"
                size="compact"
                type="button"
                disabled={busy}
                onClick={() =>
                  void act(() => models?.cancelLogin(provider.providerId) ?? Promise.resolve())
                }
                className="self-start"
              >
                {t('cancel')}
              </Button>
            </div>
          </form>
        </div>
      ) : null}
      {login?.state === 'failed' ? (
        <div role="alert" className="flex items-center gap-2 text-sm text-danger">
          {t('failed', { message: login.error ?? '' })}
          <Button
            variant="tertiary"
            size="compact"
            type="button"
            disabled={busy}
            onClick={() =>
              void act(() => models?.startLogin(provider.providerId) ?? Promise.resolve())
            }
            className="self-start"
          >
            {t('tryAgain')}
          </Button>
        </div>
      ) : null}
    </article>
  );
}

function ProfilesTable({
  profiles,
  onEdit,
}: {
  profiles: ModelProfileView[];
  /** Opens the in-app editor, the fix for a model a sign-in cannot use (#82 SET-S07). */
  onEdit?: () => void;
}) {
  const t = useTranslations('Models');
  const tokens = (count: number | null) => (count === null ? t('unknown') : t('tokens', { count }));
  return (
    <section aria-labelledby="profiles-heading" className="flex flex-col gap-2">
      <h3 id="profiles-heading" className="text-sm font-semibold">
        {t('profiles')}
      </h3>
      <ul className="flex flex-col gap-3">
        {profiles.map((profile) => (
          <li
            key={profile.profileId}
            className="settings-row"
            data-testid={`profile-${profile.profileId}`}
          >
            <div>
              <h3>{profile.modelName ?? profile.modelId}</h3>
              <p>
                {profile.profileId} · {profile.provider}/{profile.modelId}
              </p>
              <p>
                {t(
                  profile.imageInput === true
                    ? 'imageSupported'
                    : profile.imageInput === false
                      ? 'textOnly'
                      : 'imageUnknown',
                )}{' '}
                · {t('context')} {tokens(profile.contextWindow)} · {t('maxOutput')}{' '}
                {tokens(profile.maxOutputTokens)}
              </p>
            </div>
            {profile.available &&
            profile.method === 'oauth' &&
            profile.subscriptionSupported === false ? (
              <div className="flex flex-col items-start gap-1.5 sm:items-end">
                <p title={t('fileHint')}>{t('notWithSubscription')}</p>
                {onEdit ? (
                  <Button variant="tertiary" size="compact" type="button" onClick={onEdit}>
                    {t('changeModel')}
                  </Button>
                ) : null}
              </div>
            ) : (
              <p>
                {!profile.available
                  ? t('unknownModel')
                  : profile.keyConfigured
                    ? t('configured')
                    : t('needsSignIn')}
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ReasoningSettingsPanel() {
  const runSettingsTask = useSettingsTask('model-config');
  const t = useTranslations('Reasoning');
  const { models } = useServices();
  const refresh = useModelSettingsRefresh();
  const [settings, setSettings] = useState<ReasoningSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    let mounted = true;
    void models?.reasoning().then(
      (value) => {
        if (mounted) setSettings(value);
      },
      () => {
        if (mounted) setError(true);
      },
    );
    return () => {
      mounted = false;
    };
  }, [models]);
  return (
    <section className="settings-row" aria-label={t('workspaceHeading')}>
      <div>
        <h3>{t('workspaceHeading')}</h3>
        <p>{t('applyHint')}</p>
        {settings ? (
          <p>{settings.available ? `${settings.version} · ${t('ready')}` : t('installHint')}</p>
        ) : null}
        {error ? (
          <p role="alert" className="text-danger">
            {t('settingsError')}
          </p>
        ) : null}
      </div>
      <Switch
        label={t('enableApply')}
        checked={settings?.apply ?? false}
        disabled={!settings || busy}
        onToggle={async () => {
          if (!models || !settings) return;
          setBusy(true);
          setError(false);
          try {
            const apply = !settings.apply;
            setSettings(await runSettingsTask(() => models.setReasoning(apply, settings.revision)));
            await refresh();
          } catch {
            setError(true);
          } finally {
            setBusy(false);
          }
        }}
      />
    </section>
  );
}
