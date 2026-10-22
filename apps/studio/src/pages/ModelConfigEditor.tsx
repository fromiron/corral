import {
  ApiError,
  type CatalogProvider,
  type EndpointConfig,
  type ModelConfig,
  type ProfileConfig,
} from '@corral/client';
import { X } from '@corral/react/icons';
import { Button, Select } from '@corral/react/ui';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useServices } from '../services.tsx';
import { useModelSettingsRefresh } from '../workbench/modelSettings.tsx';
import { ProfileContextDetails } from '../workbench/ProfileContextDetails.tsx';
import { useSettingsForm, useSettingsTask } from '../workbench/SettingsLifecycle.tsx';
import { ApiKeyInput } from './ApiKeyInput.tsx';

/**
 * Profiles and OpenAI-compatible endpoints, edited on the Models page and saved to
 * `.corral/config.json` (CR-008). Keys go separately to the credential API after config saves.
 */
export function ModelConfigEditor({
  config: initialConfig,
  catalog,
  onDone,
}: {
  config: ModelConfig;
  catalog: CatalogProvider[];
  onDone: () => void;
}) {
  const t = useTranslations('ModelConfig');
  const { models } = useServices();
  const refresh = useModelSettingsRefresh();
  const headingId = useId();
  // Auth polling may refresh the parent while this draft still belongs to the earlier config.
  const [config, setConfig] = useState(initialConfig);
  const [profiles, setProfiles] = useState<ProfileRow[]>(() =>
    config.modelProfiles.map(profileDraft),
  );
  const [endpoints, setEndpoints] = useState<EndpointDraft[]>(config.modelProviders.map(toDraft));
  const [endpointKeys, setEndpointKeys] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const runSettingsTask = useSettingsTask('model-config');
  const initialDraft = useRef(JSON.stringify({ profiles, endpoints }));
  const dirty =
    JSON.stringify({ profiles, endpoints }) !== initialDraft.current ||
    Object.values(endpointKeys).some(Boolean);
  const [preview, setPreview] = useState(initialConfig.effectiveProfiles);
  const [previewError, setPreviewError] = useState<string | null>(null);
  useEffect(() => {
    if (!models) return;
    const controller = new AbortController();
    setPreview(undefined);
    setPreviewError(null);
    const timer = setTimeout(() => {
      try {
        const modelProfiles = profiles.map(fromProfile);
        void models
          .previewConfig(
            { revision: config.revision, modelProfiles, modelProviders: endpoints.map(fromDraft) },
            controller.signal,
          )
          .then((result) => {
            if (!controller.signal.aborted) setPreview(result.effectiveProfiles);
          })
          .catch(() => {
            if (!controller.signal.aborted) setPreviewError(t('previewUnavailable'));
          });
      } catch {
        setPreviewError(t('invalidNumber'));
      }
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [profiles, endpoints, config.revision, models, t]);

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
  const setEndpoint = (index: number, patch: Partial<EndpointDraft>) => {
    const endpoint = endpoints[index]!;
    if (patch.id !== undefined || patch.baseUrl !== undefined || patch.access !== undefined)
      setEndpointKeys((keys) => ({ ...keys, [endpoint.uid]: '' }));
    setEndpoints(endpoints.map((e, i) => (i === index ? { ...e, ...patch } : e)));
  };

  const save = async () => {
    if (!models || savingRef.current) return false;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    let stage: 'config' | 'keys' | 'refresh' = 'config';
    try {
      await runSettingsTask(async () => {
        let modelProfiles: ProfileConfig[];
        try {
          modelProfiles = profiles.map(fromProfile);
        } catch {
          throw new Error(t('invalidNumber'));
        }
        const saved = await models.saveConfig({
          revision: config.revision,
          modelProfiles,
          modelProviders: endpoints.map(fromDraft),
        });
        setConfig(saved);
        stage = 'keys';
        for (const endpoint of endpoints) {
          const key = endpointKeys[endpoint.uid]?.trim();
          if (endpoint.access !== 'api_key' || !key) continue;
          await models.setApiKey(endpoint.id.trim(), key, saved.revision);
          setEndpointKeys((keys) => ({ ...keys, [endpoint.uid]: '' }));
        }
        stage = 'refresh';
        await refresh();
      });
      onDone();
      return true;
    } catch (failure) {
      setError(
        t(stage === 'config' ? 'refused' : stage === 'keys' ? 'keysFailed' : 'refreshFailed', {
          message:
            failure instanceof ApiError && failure.code === 'REVISION_CONFLICT'
              ? t('conflict')
              : failure instanceof Error
                ? failure.message
                : String(failure),
        }),
      );
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  useSettingsForm({ dirty, pending: saving, save });
  const field = 'settings-field';
  return (
    <section aria-labelledby={headingId} className="settings-surface flex flex-col gap-4">
      <h3 id={headingId} className="text-sm font-semibold">
        {t('heading')}
      </h3>
      {config.usingDefaults ? <p className="text-xs text-muted">{t('usingDefaults')}</p> : null}

      <fieldset disabled={saving} className="flex flex-col gap-2">
        <legend className="text-sm font-medium">{t('profiles')}</legend>
        <p className="text-xs text-muted">{t('profilesHint')}</p>
        <p className="text-xs text-muted">{t('isolationHint')}</p>
        {profiles.map((profile, index) => {
          const provider = choices.find((c) => c.id === profile.provider);
          const known = provider?.models.some((m) => m.id === profile.model);
          const label = profile.id || t('newProfile', { n: index + 1 });
          return (
            <div key={profile.uid} className="flex flex-wrap items-center gap-3">
              {/* Persistent field titles: the accessible names stay on the controls (#75). */}
              <div className="flex flex-col gap-1">
                <span aria-hidden="true" className="text-2xs text-muted">
                  {t('fieldName')}
                </span>
                <input
                  aria-label={t('profileId', { n: index + 1 })}
                  value={profile.id}
                  readOnly={index < config.modelProfiles.length}
                  onChange={(e) => setProfile(index, { id: e.target.value })}
                  className={`${field} w-32 font-mono`}
                />
              </div>
              <div className="flex flex-col gap-1">
                <span aria-hidden="true" className="text-2xs text-muted">
                  {t('fieldProvider')}
                </span>
                <Select
                  label={t('providerOf', { profile: label })}
                  value={profile.provider}
                  disabled={saving}
                  className="h-9"
                  onValueChange={(value) => {
                    const next = choices.find((c) => c.id === value);
                    setProfile(index, { provider: value, model: next?.models[0]?.id ?? '' });
                  }}
                  options={[
                    ...(provider ? [] : [{ value: profile.provider, label: profile.provider }]),
                    ...choices.map((c) => ({ value: c.id, label: c.name })),
                  ]}
                />
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span aria-hidden="true" className="text-2xs text-muted">
                  {t('fieldModel')}
                </span>
                <Select
                  label={t('modelOf', { profile: label })}
                  value={profile.model}
                  disabled={saving}
                  className="h-9 min-w-0"
                  onValueChange={(value) => setProfile(index, { model: value })}
                  options={[
                    ...(known || !profile.model
                      ? []
                      : [
                          { value: profile.model, label: t('notInCatalog', { id: profile.model }) },
                        ]),
                    ...(provider?.models.map((m) => ({ value: m.id, label: m.name })) ?? []),
                  ]}
                />
              </div>
              <label className="flex h-9 items-center gap-1 self-end text-xs">
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
              <Button
                variant="outline"
                size="sm"
                type="button"
                aria-label={t('removeProfile', { profile: label })}
                onClick={() => setProfiles(profiles.filter((_, i) => i !== index))}
                className="self-end"
              >
                <X aria-hidden="true" />
                {t('removeShort')}
              </Button>
              <div className="grid w-full gap-2 sm:grid-cols-3">
                {(['contextWindow', 'reserveTokens', 'keepRecentTokens'] as const).map((key) => (
                  <label key={key} className="flex min-w-0 flex-col gap-1 text-xs">
                    <span>{t(key, { profile: label })}</span>
                    <input
                      inputMode="numeric"
                      aria-label={t(key, { profile: label })}
                      placeholder={t('inherit')}
                      value={profile[key]}
                      onChange={(event) => setProfile(index, { [key]: event.target.value })}
                      className={`${field} min-w-0 w-full`}
                    />
                  </label>
                ))}
              </div>
              <div className="w-full" data-testid={`context-policy-${profile.id}`}>
                {preview?.[profile.id] ? (
                  <>
                    <ProfileContextDetails policy={preview[profile.id]!.policy} />
                    {preview[profile.id]!.errors.length ? (
                      <p className="text-xs text-danger">{t('invalidRelation')}</p>
                    ) : null}
                  </>
                ) : (
                  <p className="text-xs text-muted">{previewError ?? t('previewPending')}</p>
                )}
              </div>
            </div>
          );
        })}
        <Button
          variant="outline"
          size="sm"
          type="button"
          onClick={() =>
            setProfiles([
              ...profiles,
              {
                uid: uid(),
                contextWindow: '',
                reserveTokens: '',
                keepRecentTokens: '',
                id: `model-${String.fromCharCode(97 + profiles.length)}`,
                provider: choices[0]?.id ?? '',
                model: choices[0]?.models[0]?.id ?? '',
              },
            ])
          }
          className="self-start"
        >
          {t('addProfile')}
        </Button>
      </fieldset>

      <fieldset disabled={saving} className="flex flex-col gap-2">
        <legend className="text-sm font-medium">{t('endpoints')}</legend>
        <p className="text-xs text-muted">{t('endpointsHint')}</p>
        {endpoints.map((endpoint, index) => {
          const n = index + 1;
          return (
            <div key={endpoint.uid} className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-xs">
                <span>{t('endpointId', { n })}</span>
                <input
                  aria-label={t('endpointId', { n })}
                  placeholder="hive"
                  value={endpoint.id}
                  onChange={(e) => setEndpoint(index, { id: e.target.value })}
                  className={`${field} font-mono`}
                />
                <span className="text-muted">{t('endpointIdHint')}</span>
              </label>
              <label className="flex flex-col gap-1 text-xs">
                <span>{t('endpointName', { n })}</span>
                <input
                  aria-label={t('endpointName', { n })}
                  placeholder="Hive"
                  value={endpoint.name}
                  onChange={(e) => setEndpoint(index, { name: e.target.value })}
                  className={field}
                />
                <span className="text-muted">{t('endpointNameHint')}</span>
              </label>
              <label className="flex flex-col gap-1 text-xs sm:col-span-2">
                <span>{t('endpointAddress', { n })}</span>
                <input
                  aria-label={t('endpointAddress', { n })}
                  placeholder="http://127.0.0.1:11434/v1"
                  value={endpoint.baseUrl}
                  onChange={(e) => setEndpoint(index, { baseUrl: e.target.value })}
                  className={`${field} font-mono sm:col-span-2`}
                />
              </label>
              <div className="flex flex-col gap-1 text-xs">
                <span>{t('endpointAccess', { n })}</span>
                <Select
                  label={t('endpointAccess', { n })}
                  value={endpoint.access}
                  disabled={saving}
                  className="h-9"
                  onValueChange={(value) => setEndpoint(index, { access: value })}
                  options={[
                    { value: 'none', label: t('accessNone') },
                    { value: 'api_key', label: t('accessKey') },
                  ]}
                />
              </div>
              <Button
                variant="outline"
                size="sm"
                type="button"
                onClick={() => {
                  setEndpointKeys((keys) => {
                    const next = { ...keys };
                    delete next[endpoint.uid];
                    return next;
                  });
                  setEndpoints(endpoints.filter((_, i) => i !== index));
                }}
                className="self-start"
              >
                {t('removeEndpoint')}
              </Button>
              {endpoint.access === 'api_key' ? (
                <div className="flex flex-col gap-1 sm:col-span-2">
                  <ApiKeyInput
                    value={endpointKeys[endpoint.uid] ?? ''}
                    disabled={saving}
                    onChange={(value) =>
                      setEndpointKeys((keys) => ({ ...keys, [endpoint.uid]: value }))
                    }
                  />
                  <p className="text-xs text-muted">{t('endpointKeyHint')}</p>
                </div>
              ) : null}
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
        <Button
          variant="outline"
          size="sm"
          type="button"
          onClick={() =>
            setEndpoints([
              ...endpoints,
              {
                uid: uid(),
                originalModels: [],
                id: '',
                name: '',
                baseUrl: '',
                access: 'none',
                models: '',
              },
            ])
          }
          className="self-start"
        >
          {t('addEndpoint')}
        </Button>
        {changedOrigins.length > 0 ? (
          <p className="text-xs text-warning">
            {t('originChanged', { names: changedOrigins.map((e) => e.name || e.id).join(', ') })}
          </p>
        ) : null}
      </fieldset>

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          type="button"
          onClick={onDone}
          disabled={saving}
          className="self-start"
        >
          {t('cancel')}
        </Button>
        <Button type="button" disabled={saving} onClick={() => void save()}>
          {t('save')}
        </Button>
      </div>
    </section>
  );
}

/** A row's identity while it is edited (names can change or be empty). */
const uid = () => globalThis.crypto.randomUUID();
type ProfileRow = Omit<ProfileConfig, 'contextWindow' | 'compaction'> & {
  uid: string;
  contextWindow: string;
  reserveTokens: string;
  keepRecentTokens: string;
};
function profileDraft(profile: ProfileConfig): ProfileRow {
  const { contextWindow, compaction, ...binding } = profile;
  return {
    ...binding,
    uid: uid(),
    contextWindow: contextWindow?.toString() ?? '',
    reserveTokens: compaction?.reserveTokens?.toString() ?? '',
    keepRecentTokens: compaction?.keepRecentTokens?.toString() ?? '',
  };
}
function fromProfile(row: ProfileRow): ProfileConfig {
  const { uid: _uid, contextWindow: c, reserveTokens: r, keepRecentTokens: k, ...binding } = row;
  const number = (value: string, min: number, max = Number.MAX_SAFE_INTEGER) => {
    if (!value.trim()) return undefined;
    const n = Number(value);
    if (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(n) || n < min || n > max)
      throw new Error('invalid number');
    return n;
  };
  const contextWindow = number(c, 1, 10_000_000),
    reserveTokens = number(r, 0),
    keepRecentTokens = number(k, 0);
  return {
    ...binding,
    id: binding.id.trim(),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(reserveTokens !== undefined || keepRecentTokens !== undefined
      ? {
          compaction: {
            ...(reserveTokens !== undefined ? { reserveTokens } : {}),
            ...(keepRecentTokens !== undefined ? { keepRecentTokens } : {}),
          },
        }
      : {}),
  };
}

/** An endpoint as edited: its models are one id per line. */
type EndpointDraft = Omit<EndpointConfig, 'models'> & {
  models: string;
  uid: string;
  originalModels: EndpointConfig['models'];
};

const modelIds = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

function toDraft(endpoint: EndpointConfig): EndpointDraft {
  return {
    ...endpoint,
    uid: uid(),
    originalModels: endpoint.models,
    models: endpoint.models.map((m) => m.id).join('\n'),
  };
}

/** Back to the config shape, keeping the limits a model already had. */
function fromDraft(draft: EndpointDraft): EndpointConfig {
  const id = draft.id.trim();
  // `uid` is the row's identity in the editor only.
  const previous = draft.originalModels;
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
