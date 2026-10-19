import type { ModelProfileView, ProviderAuthView, ReasoningSettings } from '@corral/client';
import { useRouter } from '@tanstack/react-router';
import { type FormEvent, useEffect, useState } from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import { modelSettingsRoute } from '../router.tsx';
import { useServices } from '../services.tsx';
import { ApiKeyInput } from './ApiKeyInput.tsx';
import { ModelConfigEditor } from './ModelConfigEditor.tsx';
import { SettingsLayout } from './SettingsPage.tsx';

/**
 * /settings/models (Spec §4.1, C-058). Sign-in happens on the provider's own page, opened by
 * the person; this page only shows status and expiry. No token is ever sent here.
 */
export function ModelSettingsPage() {
  const t = useTranslations('Models');
  const { models, mode, live } = useServices();
  const { profiles, providers, catalog, config } = modelSettingsRoute.useLoaderData();
  const [editing, setEditing] = useState(false);
  const router = useRouter();
  const pending = providers.some((p) => p.login && p.login.state !== 'failed');

  // While a sign-in is open in another tab, follow its progress.
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => void router.invalidate(), 1500);
    return () => clearInterval(timer);
  }, [pending, router]);

  return (
    <SettingsLayout active="models">
      <main className="mx-auto flex max-w-4xl flex-col gap-6 p-6 sm:p-10">
        <h2 className="text-lg font-semibold">{t('heading')}</h2>
        {mode !== 'server' || !models ? (
          <p className="text-sm text-muted">{t('browserOnly')}</p>
        ) : !live ? (
          <p className="text-sm text-muted">{t('noLive')}</p>
        ) : (
          <>
            <p className="text-sm text-muted">{t('intro')}</p>
            <ReasoningSettingsPanel key={config?.revision} />
            <section aria-labelledby="providers-heading" className="flex flex-col gap-2">
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
            {editing && config ? (
              <ModelConfigEditor
                config={config}
                catalog={catalog}
                onDone={() => setEditing(false)}
              />
            ) : (
              <>
                <ProfilesTable profiles={profiles} />
                {config ? (
                  <button
                    type="button"
                    onClick={() => setEditing(true)}
                    className="self-start rounded-md border border-accent px-3 py-1.5 text-sm text-accent"
                  >
                    {t('editModels')}
                  </button>
                ) : null}
              </>
            )}
          </>
        )}
      </main>
    </SettingsLayout>
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
  const router = useRouter();
  const [redirect, setRedirect] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const login = provider.login;
  const borrowed = provider.source === 'codex-cli';
  // A key the page can remove: one entered here, not one from the server environment.
  const ownKey = provider.method === 'api_key' && provider.source === 'corral';

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await router.invalidate();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
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

  const saveKey = (event: FormEvent) => {
    event.preventDefault();
    const key = apiKey.trim();
    if (!key) return;
    void act(async () => {
      await models?.setApiKey(provider.providerId, key, revision);
      setApiKey('');
    });
  };

  return (
    <article
      className="flex flex-col gap-2 rounded-lg border border-line bg-raised p-3"
      data-testid={`provider-${provider.providerId}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="font-medium">{provider.name}</h4>
        <div className="flex items-center gap-2 text-xs">
          {(provider.method === 'oauth' && !borrowed) || ownKey ? (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void act(() => models?.logout(provider.providerId) ?? Promise.resolve())
              }
              className="rounded border border-line px-2 py-1"
            >
              {ownKey ? t('removeKey') : t('signOut')}
            </button>
          ) : null}
          {provider.methods.oauth && (!provider.signedIn || borrowed) && !login ? (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void act(() => models?.startLogin(provider.providerId) ?? Promise.resolve())
              }
              className={
                borrowed
                  ? 'rounded border border-line px-2 py-1'
                  : 'rounded-md bg-accent px-3 py-1.5 font-medium text-on-accent'
              }
            >
              {borrowed ? t('signInInstead') : t('signIn')}
            </button>
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
        <p className="text-xs text-muted">{t('endpoint', { host: provider.endpoint })}</p>
      ) : null}
      {provider.endpointChanged ? (
        <p role="alert" className="text-xs text-danger">
          {t('endpointChanged')}
        </p>
      ) : null}
      {provider.expiresAt && provider.method === 'oauth' ? (
        <p className="text-xs text-muted">
          {t('expires', {
            time: format.dateTime(new Date(provider.expiresAt), {
              dateStyle: 'medium',
              timeStyle: 'short',
            }),
          })}
        </p>
      ) : null}
      {borrowed ? <p className="text-xs text-muted">{t('codexHint')}</p> : null}
      {borrowed && !provider.permissionsOk ? (
        <p role="alert" className="text-xs text-danger">
          {t('codexPermissions')}
        </p>
      ) : null}

      {provider.methods.apiKey && (!provider.signedIn || borrowed) && !login ? (
        <form onSubmit={saveKey} className="flex flex-col gap-1">
          <div className="flex items-end gap-2">
            <ApiKeyInput value={apiKey} onChange={setApiKey} disabled={busy} />
            <button
              type="submit"
              disabled={busy || !apiKey.trim()}
              className="rounded border border-line px-2 py-1 text-xs"
            >
              {t('saveKey')}
            </button>
          </div>
          <p className="text-xs text-muted">{t('keyHint')}</p>
        </form>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      {login && login.state !== 'failed' ? (
        <div className="flex flex-col gap-2 rounded-md border border-line p-2 text-sm">
          {login.authUrl ? (
            <a
              href={login.authUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="self-start rounded-md bg-accent px-3 py-1.5 font-medium text-on-accent"
            >
              {t('openSignIn')}
            </a>
          ) : null}
          <p className="text-xs text-muted">
            {login.state === 'exchanging' ? t('exchanging') : t('openHint')}
          </p>
          <form onSubmit={submitRedirect} className="flex flex-col gap-1">
            <label htmlFor={`redirect-${provider.providerId}`} className="text-xs text-muted">
              {t('pasteLabel')}
            </label>
            <div className="flex gap-2">
              <input
                id={`redirect-${provider.providerId}`}
                value={redirect}
                onChange={(e) => setRedirect(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                className="min-w-0 flex-1 rounded border border-line bg-surface px-2 py-1 font-mono text-xs"
              />
              <button
                type="submit"
                disabled={busy}
                className="rounded border border-line px-2 py-1 text-xs"
              >
                {t('paste')}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void act(() => models?.cancelLogin(provider.providerId) ?? Promise.resolve())
                }
                className="rounded border border-line px-2 py-1 text-xs"
              >
                {t('cancel')}
              </button>
            </div>
          </form>
        </div>
      ) : null}
      {login?.state === 'failed' ? (
        <div role="alert" className="flex items-center gap-2 text-sm text-danger">
          {t('failed', { message: login.error ?? '' })}
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void act(() => models?.startLogin(provider.providerId) ?? Promise.resolve())
            }
            className="rounded border border-line px-2 py-1 text-xs text-text"
          >
            {t('tryAgain')}
          </button>
        </div>
      ) : null}
    </article>
  );
}

function ProfilesTable({ profiles }: { profiles: ModelProfileView[] }) {
  const t = useTranslations('Models');
  const tokens = (count: number | null) => (count === null ? t('unknown') : t('tokens', { count }));
  return (
    <section aria-labelledby="profiles-heading" className="flex flex-col gap-2">
      <h3 id="profiles-heading" className="text-sm font-semibold">
        {t('profiles')}
      </h3>
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-muted">
          <tr>
            <th className="py-1">{t('profile')}</th>
            <th>{t('model')}</th>
            <th>{t('context')}</th>
            <th>{t('maxOutput')}</th>
            <th>{t('status')}</th>
          </tr>
        </thead>
        <tbody>
          {profiles.map((profile) => (
            <tr
              key={profile.profileId}
              className="border-t border-line"
              data-testid={`profile-${profile.profileId}`}
            >
              <td className="py-1 font-mono text-xs">{profile.profileId}</td>
              <td>
                {profile.modelName ?? profile.modelId}{' '}
                <span className="font-mono text-xs text-muted">
                  {profile.provider}/{profile.modelId}
                </span>
              </td>
              <td>{tokens(profile.contextWindow)}</td>
              <td>{tokens(profile.maxOutputTokens)}</td>
              <td>
                {!profile.available
                  ? t('unknownModel')
                  : profile.method === 'oauth' && profile.subscriptionSupported === false
                    ? t('notWithSubscription')
                    : profile.keyConfigured
                      ? t('ready')
                      : t('needsSignIn')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function ReasoningSettingsPanel() {
  const t = useTranslations('Reasoning');
  const { models } = useServices();
  const router = useRouter();
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
    <section
      className="flex flex-col gap-2 rounded-lg border border-line p-3"
      aria-label={t('workspaceHeading')}
    >
      <h3 className="font-semibold">{t('workspaceHeading')}</h3>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={settings?.apply ?? false}
          disabled={!settings || busy}
          onChange={async (event) => {
            if (!models || !settings) return;
            setBusy(true);
            setError(false);
            try {
              setSettings(await models.setReasoning(event.target.checked, settings.revision));
              await router.invalidate();
            } catch {
              setError(true);
            } finally {
              setBusy(false);
            }
          }}
        />
        {t('enableApply')}
      </label>
      <p className="text-xs text-muted">{t('applyHint')}</p>
      {settings ? (
        <p className="text-xs">
          {settings.available
            ? `${settings.version} · ${t('ready')}`
            : t('installHint', { command: 'corral judge install' })}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {t('settingsError')}
        </p>
      ) : null}
    </section>
  );
}
