import type { CatalogProvider, EndpointConfig, ModelConfig, ProfileConfig } from '@corral/client';
import { useRouter } from '@tanstack/react-router';
import { useId, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useServices } from '../services.tsx';

/**
 * Profiles and OpenAI-compatible endpoints, edited on the Models page and saved to
 * `.corral/config.json` (CR-008). Keys are not part of it; they stay in Settings' sign-in.
 */
export function ModelConfigEditor({
  config,
  catalog,
  onDone,
}: {
  config: ModelConfig;
  catalog: CatalogProvider[];
  onDone: () => void;
}) {
  const t = useTranslations('ModelConfig');
  const { models } = useServices();
  const router = useRouter();
  const headingId = useId();
  const [profiles, setProfiles] = useState<ProfileRow[]>(() =>
    config.modelProfiles.map((p) => ({ ...p, uid: uid() })),
  );
  const [endpoints, setEndpoints] = useState<EndpointDraft[]>(config.modelProviders.map(toDraft));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Providers to choose from: pi-ai's own, then the endpoints as they are being edited.
  const builtins = catalog.filter((p) => !p.endpoint);
  const choices: { id: string; name: string; models: { id: string; name: string }[] }[] = [
    ...endpoints
      .filter((e) => e.id.trim())
      .map((e) => ({
        id: e.id.trim(),
        name: e.name.trim() || e.id.trim(),
        models: modelIds(e.models).map((id) => ({ id, name: id })),
      })),
    ...builtins.map((p) => ({ id: p.providerId, name: p.name, models: p.models })),
  ];
  const changedOrigins = endpoints.filter((e) => {
    const before = config.modelProviders.find((p) => p.id === e.id.trim());
    return before && e.access === 'api_key' && origin(before.baseUrl) !== origin(e.baseUrl);
  });

  const setProfile = (index: number, patch: Partial<ProfileRow>) =>
    setProfiles(profiles.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  const setEndpoint = (index: number, patch: Partial<EndpointDraft>) =>
    setEndpoints(endpoints.map((e, i) => (i === index ? { ...e, ...patch } : e)));

  const save = async () => {
    if (!models) return;
    setSaving(true);
    setError(null);
    try {
      await models.saveConfig({
        revision: config.revision,
        modelProfiles: profiles.map(({ uid: _uid, ...p }) => ({ ...p, id: p.id.trim() })),
        modelProviders: endpoints.map((e) => fromDraft(e, config.modelProviders)),
      });
      await router.invalidate();
      onDone();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSaving(false);
    }
  };

  const field = 'rounded border border-line bg-surface px-2 py-1 text-sm';
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-4 rounded-lg border border-accent/60 bg-raised p-3"
    >
      <h3 id={headingId} className="text-sm font-semibold">
        {t('heading')}
      </h3>
      {config.usingDefaults ? <p className="text-xs text-muted">{t('usingDefaults')}</p> : null}

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">{t('profiles')}</legend>
        <p className="text-xs text-muted">{t('profilesHint')}</p>
        <p className="text-xs text-muted">{t('isolationHint')}</p>
        {profiles.map((profile, index) => {
          const provider = choices.find((c) => c.id === profile.provider);
          const known = provider?.models.some((m) => m.id === profile.model);
          const label = profile.id || t('newProfile', { n: index + 1 });
          return (
            <div key={profile.uid} className="flex flex-wrap items-center gap-2">
              <input
                aria-label={t('profileId', { n: index + 1 })}
                value={profile.id}
                readOnly={index < config.modelProfiles.length}
                onChange={(e) => setProfile(index, { id: e.target.value })}
                className={`${field} w-32 font-mono`}
              />
              <select
                aria-label={t('providerOf', { profile: label })}
                value={profile.provider}
                onChange={(e) => {
                  const next = choices.find((c) => c.id === e.target.value);
                  setProfile(index, { provider: e.target.value, model: next?.models[0]?.id ?? '' });
                }}
                className={field}
              >
                {provider ? null : <option value={profile.provider}>{profile.provider}</option>}
                {choices.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <select
                aria-label={t('modelOf', { profile: label })}
                value={profile.model}
                onChange={(e) => setProfile(index, { model: e.target.value })}
                className={`${field} min-w-0 flex-1`}
              >
                {known || !profile.model ? null : (
                  <option value={profile.model}>{t('notInCatalog', { id: profile.model })}</option>
                )}
                {provider?.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
              <label className="flex items-center gap-1 text-xs">
                <input
                  type="checkbox"
                  checked={profile.workerIsolation === 'linux-bwrap'}
                  onChange={(event) =>
                    setProfile(index, {
                      workerIsolation: event.target.checked ? 'linux-bwrap' : undefined,
                    })
                  }
                />
                {t('isolateProfile', { profile: label })}
              </label>
              <button
                type="button"
                aria-label={t('removeProfile', { profile: label })}
                onClick={() => setProfiles(profiles.filter((_, i) => i !== index))}
                className="rounded border border-line px-2 py-1 text-xs"
              >
                ✕
              </button>
            </div>
          );
        })}
        <button
          type="button"
          onClick={() =>
            setProfiles([
              ...profiles,
              {
                uid: uid(),
                id: `model-${String.fromCharCode(97 + profiles.length)}`,
                provider: choices[0]?.id ?? '',
                model: choices[0]?.models[0]?.id ?? '',
              },
            ])
          }
          className="self-start rounded border border-line px-2 py-1 text-xs"
        >
          {t('addProfile')}
        </button>
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">{t('endpoints')}</legend>
        <p className="text-xs text-muted">{t('endpointsHint')}</p>
        {endpoints.map((endpoint, index) => {
          const n = index + 1;
          return (
            <div
              key={endpoint.uid}
              className="grid gap-2 rounded border border-line p-2 sm:grid-cols-2"
            >
              <input
                aria-label={t('endpointId', { n })}
                placeholder="ollama"
                value={endpoint.id}
                onChange={(e) => setEndpoint(index, { id: e.target.value })}
                className={`${field} font-mono`}
              />
              <input
                aria-label={t('endpointName', { n })}
                placeholder="Ollama"
                value={endpoint.name}
                onChange={(e) => setEndpoint(index, { name: e.target.value })}
                className={field}
              />
              <input
                aria-label={t('endpointAddress', { n })}
                placeholder="http://127.0.0.1:11434/v1"
                value={endpoint.baseUrl}
                onChange={(e) => setEndpoint(index, { baseUrl: e.target.value })}
                className={`${field} font-mono sm:col-span-2`}
              />
              <select
                aria-label={t('endpointAccess', { n })}
                value={endpoint.access}
                onChange={(e) =>
                  setEndpoint(index, { access: e.target.value as EndpointConfig['access'] })
                }
                className={field}
              >
                <option value="none">{t('accessNone')}</option>
                <option value="api_key">{t('accessKey')}</option>
              </select>
              <button
                type="button"
                onClick={() => setEndpoints(endpoints.filter((_, i) => i !== index))}
                className="justify-self-start rounded border border-line px-2 py-1 text-xs"
              >
                {t('removeEndpoint')}
              </button>
              <label className="flex flex-col gap-1 text-xs sm:col-span-2">
                <span>{t('endpointModels', { n })}</span>
                <textarea
                  value={endpoint.models}
                  rows={2}
                  onChange={(e) => setEndpoint(index, { models: e.target.value })}
                  className={`${field} font-mono`}
                />
              </label>
            </div>
          );
        })}
        <button
          type="button"
          onClick={() =>
            setEndpoints([
              ...endpoints,
              { uid: uid(), id: '', name: '', baseUrl: '', access: 'none', models: '' },
            ])
          }
          className="self-start rounded border border-line px-2 py-1 text-xs"
        >
          {t('addEndpoint')}
        </button>
        {changedOrigins.length > 0 ? (
          <p className="text-xs text-warning">
            {t('originChanged', { names: changedOrigins.map((e) => e.name || e.id).join(', ') })}
          </p>
        ) : null}
      </fieldset>

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {t('refused', { message: error })}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onDone}
          className="rounded border border-line px-3 py-1.5 text-sm"
        >
          {t('cancel')}
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={() => void save()}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent disabled:opacity-50"
        >
          {t('save')}
        </button>
      </div>
    </section>
  );
}

/** A row's identity while it is edited (names can change or be empty). */
const uid = () => globalThis.crypto.randomUUID();
type ProfileRow = ProfileConfig & { uid: string };

/** An endpoint as edited: its models are one id per line. */
type EndpointDraft = Omit<EndpointConfig, 'models'> & { models: string; uid: string };

const modelIds = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

function toDraft(endpoint: EndpointConfig): EndpointDraft {
  return { ...endpoint, uid: uid(), models: endpoint.models.map((m) => m.id).join('\n') };
}

/** Back to the config shape, keeping the limits a model already had. */
function fromDraft(draft: EndpointDraft, before: EndpointConfig[]): EndpointConfig {
  const id = draft.id.trim();
  // `uid` is the row's identity in the editor only.
  const previous = before.find((e) => e.id === id)?.models ?? [];
  return {
    id,
    name: draft.name.trim() || id,
    baseUrl: draft.baseUrl.trim(),
    access: draft.access,
    models: modelIds(draft.models).map(
      (modelId) => previous.find((m) => m.id === modelId) ?? { id: modelId },
    ),
  };
}

function origin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
