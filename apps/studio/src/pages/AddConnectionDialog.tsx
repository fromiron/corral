import {
  ApiError,
  type CatalogProvider,
  type EndpointConfig,
  type LoginView,
  type ModelConfig,
  type ModelProfileView,
  type ProviderAuthView,
} from '@corral/client';
import { providerMark } from '@corral/react';
import {
  Button,
  ConnectedMark,
  ConnectionDirectory,
  type ConnectionDirectoryEntry,
  ConnectionDiscovery,
  ConnectionSheet,
  InputCopy,
  InputField,
  InputGroup,
  KitButton,
  TabItem,
  Tabs,
  TabsList,
} from '@corral/react/design-kit';
import { ArrowLeft, Download, ExternalLink, Globe } from '@corral/react/icons';
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useServices } from '../services.tsx';
import { useModelSettingsRefresh } from '../workbench/modelSettings.tsx';
import { useSettingsForm, useSettingsTask } from '../workbench/SettingsLifecycle.tsx';
import { ApiKeyInput } from './ApiKeyInput.tsx';
import { ModelImportPanel } from './ModelImportPanel.tsx';
import { endpointIdFor } from './modelConnections.ts';

/** Where the dialog opens: the directory, one provider's connect face, an address, an import. */
export type AddConnectionStart =
  | { face: 'find' }
  | { face: 'import' }
  | { face: 'connect'; providerId: string; method?: 'oauth' | 'apiKey' }
  | { face: 'address'; providerId?: string };

type Face =
  | { face: 'find' }
  | { face: 'import' }
  | { face: 'connect'; providerId: string; method: 'oauth' | 'apiKey' }
  | { face: 'address'; providerId: string | null; editing: boolean }
  | { face: 'found'; providerId: string };

const ADDRESS = '__address';

/** https anywhere; http only on this computer, where a key cannot leave it (the server agrees). */
function addressProblem(text: string): boolean {
  try {
    const url = new URL(text.trim());
    if (url.protocol === 'https:') return false;
    return !(
      url.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase())
    );
  } catch {
    return true;
  }
}

/**
 * Add connection: one dialog whose faces are find → connect → found
 * (features/model-connections.md, 연결). A typed key, token or callback address is never shown
 * again once sent; leaving with typed input asks first.
 */
export function AddConnectionDialog({
  open,
  onOpenChange,
  start,
  providers,
  catalog,
  config,
  profiles,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  start: AddConnectionStart;
  providers: ProviderAuthView[];
  catalog: CatalogProvider[];
  config: ModelConfig | null;
  profiles: ModelProfileView[];
}) {
  const t = useTranslations('AddConnection');
  const { models } = useServices();
  const methodsOf = (providerId: string) =>
    catalog.find((entry) => entry.providerId === providerId)?.methods ??
    providers.find((entry) => entry.providerId === providerId)?.methods ?? {
      oauth: false,
      apiKey: false,
    };
  const initial = (from: AddConnectionStart): Face =>
    from.face === 'connect'
      ? {
          face: 'connect',
          providerId: from.providerId,
          method: from.method ?? (methodsOf(from.providerId).oauth ? 'oauth' : 'apiKey'),
        }
      : from.face === 'address'
        ? {
            face: 'address',
            providerId: from.providerId ?? null,
            editing: Boolean(from.providerId),
          }
        : from;
  const [face, setFace] = useState<Face>(() => initial(start));
  const [query, setQuery] = useState('');
  const [typed, setTyped] = useState(false);
  const confirmLeave = useSettingsForm({ dirty: typed });

  // A sign-in this dialog started and has not seen finish; leaving cancels it.
  const login = useRef<{ providerId: string; seen: boolean } | null>(null);
  const cancelLogin = () => {
    const running = login.current;
    login.current = null;
    if (running) void models?.cancelLogin(running.providerId).catch(() => {});
  };
  useEffect(
    () => () => {
      const running = login.current;
      if (running) void models?.cancelLogin(running.providerId).catch(() => {});
    },
    [models],
  );
  const go = (next: Face) => {
    if (face.face === 'connect' && (next.face !== 'found' || next.providerId !== face.providerId))
      cancelLogin();
    setTyped(false);
    setFace(next);
  };
  const close = async () => {
    if (typed && !(await confirmLeave())) return;
    if (face.face !== 'found') cancelLogin();
    onOpenChange(false);
  };

  const nameOf = (providerId: string) =>
    catalog.find((entry) => entry.providerId === providerId)?.name ??
    providers.find((entry) => entry.providerId === providerId)?.name ??
    providerId;
  const endpoint =
    face.face === 'address' && face.providerId
      ? config?.modelProviders.find((entry) => entry.id === face.providerId)
      : undefined;
  const title =
    face.face === 'find'
      ? t('title.find')
      : face.face === 'import'
        ? t('title.import')
        : face.face === 'address'
          ? face.editing && endpoint
            ? endpoint.name
            : t('title.address')
          : nameOf(face.providerId);

  const back = (
    <Button variant="tertiary" onClick={() => go({ face: 'find' })}>
      <ArrowLeft aria-hidden />
      {t('back')}
    </Button>
  );

  let body: ReactNode = null;
  if (face.face === 'find') {
    const connected = new Set(providers.filter((p) => p.signedIn).map((p) => p.providerId));
    const entries: ConnectionDirectoryEntry[] = [
      {
        id: ADDRESS,
        name: t('address'),
        logo: Globe,
        description: t('addressHint'),
        keywords: 'openai compatible endpoint url ollama lm studio vllm',
      },
      ...catalog
        .filter((entry) => !entry.endpoint && (entry.methods.oauth || entry.methods.apiKey))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
        .map((entry) => {
          const logo = providerMark(entry.providerId);
          return {
            id: entry.providerId,
            name: entry.name,
            ...(logo ? { logo } : {}),
            description: [
              entry.methods.oauth ? t('methods.oauth') : null,
              entry.methods.apiKey ? t('methods.apiKey') : null,
            ]
              .filter(Boolean)
              .join(' · '),
            keywords: entry.providerId,
            ...(connected.has(entry.providerId)
              ? { trailing: <ConnectedMark label={t('connected')} /> }
              : {}),
          };
        }),
    ];
    body = (
      <ConnectionDirectory
        entries={entries}
        query={query}
        onQueryChange={setQuery}
        onPick={(entry) =>
          go(
            entry.id === ADDRESS
              ? { face: 'address', providerId: null, editing: false }
              : {
                  face: 'connect',
                  providerId: entry.id,
                  method: methodsOf(entry.id).oauth ? 'oauth' : 'apiKey',
                },
          )
        }
        labels={{
          search: t('search'),
          directory: t('providers'),
          noMatch: (q) => t('noMatch', { query: q }),
        }}
        footer={
          <Button
            variant="ghost"
            size="compact"
            className="justify-self-start text-muted-foreground"
            onClick={() => go({ face: 'import' })}
          >
            <Download aria-hidden />
            {t('importEntry')}
          </Button>
        }
      />
    );
  } else if (face.face === 'import') {
    body = (
      <div className="grid gap-4">
        <ModelImportPanel />
        <div className="flex justify-start">{back}</div>
      </div>
    );
  } else if (face.face === 'connect') {
    const methods = methodsOf(face.providerId);
    const both = methods.oauth && methods.apiKey;
    body = (
      <div className="grid gap-4">
        {both ? (
          <Tabs
            value={face.method}
            onValueChange={(method) => {
              if (method === face.method) return;
              cancelLogin();
              setTyped(false);
              setFace({ ...face, method: method as 'oauth' | 'apiKey' });
            }}
            className="w-full"
          >
            <TabsList aria-label={t('how')} className="w-full">
              <TabItem value="oauth" label={t('methods.oauth')} className="flex-1" />
              <TabItem value="apiKey" label={t('methods.apiKey')} className="flex-1" />
            </TabsList>
          </Tabs>
        ) : null}
        {face.method === 'oauth' ? (
          <SignInFace
            key={face.providerId}
            providerId={face.providerId}
            name={nameOf(face.providerId)}
            provider={providers.find((p) => p.providerId === face.providerId)}
            login={login}
            onTyped={setTyped}
            onDone={() => go({ face: 'found', providerId: face.providerId })}
            back={back}
          />
        ) : (
          <KeyFace
            key={face.providerId}
            providerId={face.providerId}
            revision={config?.revision}
            onTyped={setTyped}
            onDone={() => go({ face: 'found', providerId: face.providerId })}
            back={back}
          />
        )}
      </div>
    );
  } else if (face.face === 'address') {
    body = (
      <AddressFace
        endpoint={endpoint ?? null}
        editing={face.editing}
        config={config}
        takenIds={[
          ...catalog.map((entry) => entry.providerId),
          ...providers.map((entry) => entry.providerId),
          ...(config?.modelProviders.map((entry) => entry.id) ?? []),
        ]}
        onTyped={setTyped}
        onDone={(id) => go({ face: 'found', providerId: id })}
        back={face.editing ? null : back}
      />
    );
  } else {
    const found = profiles
      .filter((view) => view.provider === face.providerId && view.available)
      .map((view) => ({ id: view.modelId, name: view.modelName ?? view.modelId }));
    const unique = [...new Map(found.map((item) => [item.id, item])).values()];
    body = (
      <div className="grid gap-4">
        <ConnectionDiscovery
          working={false}
          items={unique}
          labels={{
            reading: t('reading'),
            before: t('foundBefore'),
            after: (count) => t('foundAfter', { count }),
            list: t('foundList'),
            more: (count) => t('more', { count }),
          }}
        />
        <div className="flex justify-end">
          <Button variant="primary" onClick={() => onOpenChange(false)}>
            {t('done')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <ConnectionSheet
      open={open}
      onOpenChange={(next) => {
        if (!next) void close();
      }}
      face={
        face.face === 'connect' || face.face === 'found'
          ? `${face.face}:${face.providerId}`
          : face.face
      }
      title={title}
      closeLabel={t('close')}
      focusTitle={face.face !== 'find'}
    >
      {body}
    </ConnectionSheet>
  );
}

/**
 * The failure line of a face: the server's own reason as it gave it (such as a provider that
 * needs more than a key), or "Not saved" with what went wrong before the server answered.
 */
function failureText(failure: unknown, t: ReturnType<typeof useTranslations<'AddConnection'>>) {
  if (failure instanceof ApiError)
    return failure.code === 'REVISION_CONFLICT' ? t('conflict') : failure.message;
  return t('notSaved', {
    message: failure instanceof Error ? failure.message : String(failure),
  });
}

function SignInFace({
  providerId,
  name,
  provider,
  login,
  onTyped,
  onDone,
  back,
}: {
  providerId: string;
  name: string;
  provider: ProviderAuthView | undefined;
  login: { current: { providerId: string; seen: boolean } | null };
  onTyped: (typed: boolean) => void;
  onDone: () => void;
  back: ReactNode;
}) {
  const t = useTranslations('AddConnection');
  const { models } = useServices();
  const refresh = useModelSettingsRefresh();
  const runTask = useSettingsTask(`sign-in:${providerId}`);
  const [started, setStarted] = useState<LoginView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pasting, setPasting] = useState(false);
  const [redirect, setRedirect] = useState('');
  const [busy, setBusy] = useState(false);

  const start = async () => {
    if (!models) return;
    setError(null);
    login.current = { providerId, seen: false };
    try {
      const view = await runTask(() => models.startLogin(providerId));
      setStarted(view);
      await refresh();
    } catch (failure) {
      login.current = null;
      setError(failureText(failure, t));
    }
  };
  // Choosing subscription sign-in starts it: the provider page is the next step.
  const once = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: The sign-in starts once per face.
  useEffect(() => {
    if (once.current) return;
    once.current = true;
    if (provider?.login && provider.login.state !== 'failed') {
      login.current = { providerId, seen: true };
      return;
    }
    void start();
  }, []);

  const view = provider?.login ?? started;
  // The poll shows the sign-in running, then gone with the provider connected: it finished.
  useEffect(() => {
    const running = login.current;
    if (running?.providerId !== providerId) return;
    if (provider?.login) running.seen = true;
    else if (running.seen && provider?.signedIn) {
      login.current = null;
      onDone();
    }
  });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const url = redirect.trim();
    if (!url || !models) return;
    setBusy(true);
    setError(null);
    try {
      await runTask(() => models.submitRedirect(providerId, url));
      setRedirect('');
      onTyped(false);
      setPasting(false);
      await refresh();
    } catch (failure) {
      setError(failureText(failure, t));
    } finally {
      setBusy(false);
    }
  };

  const failed = view?.state === 'failed';
  return (
    <div className="grid gap-4">
      {failed ? (
        <p role="alert" className="m-0 text-body text-danger">
          {t('signInFailed', { message: view.error ?? '' })}
        </p>
      ) : (
        <p role="status" className="m-0 shimmer-text text-body text-muted-foreground">
          {!view?.authUrl
            ? t('starting')
            : view.state === 'exchanging'
              ? t('exchanging')
              : t('waiting', { name })}
        </p>
      )}
      {error ? (
        <p role="alert" className="m-0 text-body text-danger">
          {error}
        </p>
      ) : null}
      {view?.userCode && !failed ? (
        <InputCopy
          value={view.userCode}
          label={t('code')}
          labels={{
            copy: t('copy'),
            copied: t('copied'),
            failed: t('copyFailed'),
            copyFailed: t('copyFailed'),
            copyToClipboard: t('copyCode'),
          }}
          className="[&_mark]:text-subtitle [&_mark]:tracking-[0.12em]"
        />
      ) : null}
      {view?.authUrl && !view.userCode && !failed ? (
        pasting ? (
          <form onSubmit={(event) => void submit(event)} className="flex items-end gap-2">
            <InputGroup className="min-w-0 flex-1">
              <InputField
                index={0}
                label={t('pasteLabel')}
                value={redirect}
                disabled={busy}
                autoComplete="off"
                spellCheck={false}
                inputMode="url"
                placeholder="http://127.0.0.1:1455/…"
                onChange={(value) => {
                  setRedirect(value);
                  onTyped(Boolean(value));
                }}
              />
            </InputGroup>
            <Button type="submit" variant="tertiary" disabled={busy || !redirect.trim()}>
              {t('paste')}
            </Button>
          </form>
        ) : (
          <Button
            variant="ghost"
            size="compact"
            className="justify-self-start text-muted-foreground"
            onClick={() => setPasting(true)}
          >
            {t('pasteToggle')}
          </Button>
        )
      ) : null}
      <div className="flex items-center justify-between gap-2">
        {back}
        {failed ? (
          <Button variant="primary" onClick={() => void start()}>
            {t('tryAgain')}
          </Button>
        ) : view?.authUrl ? (
          <Button
            variant="primary"
            render={<a href={view.authUrl} target="_blank" rel="noopener noreferrer" />}
          >
            {t('openSignIn', { name })}
            <ExternalLink aria-hidden />
          </Button>
        ) : (
          <KitButton variant="primary" loading>
            {t('openSignIn', { name })}
          </KitButton>
        )}
      </div>
    </div>
  );
}

function KeyFace({
  providerId,
  revision,
  onTyped,
  onDone,
  back,
}: {
  providerId: string;
  revision: string | undefined;
  onTyped: (typed: boolean) => void;
  onDone: () => void;
  back: ReactNode;
}) {
  const t = useTranslations('AddConnection');
  const tm = useTranslations('Models');
  const { models } = useServices();
  const refresh = useModelSettingsRefresh();
  const runTask = useSettingsTask(`api-key:${providerId}`);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const safety = `${providerId}-key-safety`;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = key.trim();
    if (!value || !models || busy) return;
    setBusy(true);
    setError(null);
    try {
      await runTask(() => models.setApiKey(providerId, value, revision));
      setKey('');
      onTyped(false);
      await refresh();
      onDone();
    } catch (failure) {
      // The server's own reason, such as a provider that needs more than a key.
      setError(failureText(failure, t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={(event) => void submit(event)} className="grid gap-4">
      <div className="grid gap-1">
        <ApiKeyInput
          kitLabel
          value={key}
          disabled={busy}
          describedBy={safety}
          onChange={(value) => {
            setKey(value);
            onTyped(Boolean(value));
          }}
        />
        <p id={safety} className="m-0 text-caption text-muted-foreground">
          {tm('keySafety')}
        </p>
      </div>
      {error ? (
        <p role="alert" className="m-0 text-body text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex items-center justify-between gap-2">
        {back}
        <KitButton type="submit" variant="primary" loading={busy} disabled={!key.trim()}>
          {t('connect')}
        </KitButton>
      </div>
    </form>
  );
}

function AddressFace({
  endpoint,
  editing,
  config,
  takenIds,
  onTyped,
  onDone,
  back,
}: {
  endpoint: EndpointConfig | null;
  editing: boolean;
  config: ModelConfig | null;
  takenIds: string[];
  onTyped: (typed: boolean) => void;
  onDone: (id: string) => void;
  back: ReactNode;
}) {
  const t = useTranslations('AddConnection');
  const tm = useTranslations('Models');
  const { models } = useServices();
  const refresh = useModelSettingsRefresh();
  const runTask = useSettingsTask('endpoint');
  const [name, setName] = useState(endpoint?.name ?? '');
  const [address, setAddress] = useState(endpoint?.baseUrl ?? '');
  const [access, setAccess] = useState<EndpointConfig['access']>(endpoint?.access ?? 'api_key');
  const [key, setKey] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The endpoint this face saved, before the parent's config has caught up with it.
  const saved = useRef<{ endpoint: EndpointConfig; revision: string } | null>(null);
  const safety = 'endpoint-key-safety';
  const changed = (next: string, before: string | undefined) => onTyped(next !== (before ?? ''));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!models || !config || busy) return;
    if (addressProblem(address)) {
      setInvalid(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await runTask(async () => {
        const baseUrl = address.trim();
        const label = name.trim() || new URL(baseUrl).host;
        const current =
          (saved.current &&
            config.modelProviders.find((entry) => entry.id === saved.current?.endpoint.id)) ??
          saved.current?.endpoint ??
          endpoint;
        const known = Boolean(
          current && config.modelProviders.some((entry) => entry.id === current.id),
        );
        let revision = known || !saved.current ? config.revision : saved.current.revision;
        const next: EndpointConfig = current
          ? { ...current, name: label, baseUrl, access }
          : {
              id: endpointIdFor(label, takenIds),
              name: label,
              baseUrl,
              access,
              models: [],
            };
        const differs =
          !current ||
          current.name !== next.name ||
          current.baseUrl !== next.baseUrl ||
          current.access !== next.access;
        if (differs) {
          const others = config.modelProviders.filter((entry) => entry.id !== next.id);
          const result = await models.saveConfig({
            revision,
            modelProfiles: config.modelProfiles,
            modelProviders: [...others, next],
          });
          revision = result.revision;
          saved.current = { endpoint: next, revision };
        }
        const typedKey = key.trim();
        if (access === 'api_key' && typedKey) {
          await models.setApiKey(next.id, typedKey, revision);
          setKey('');
        }
        const fetched = await models.refreshEndpointModels(next.id, revision);
        onTyped(false);
        await refresh();
        if (fetched.kind === 'connected') onDone(next.id);
        else setError(t(`fetch.${fetched.kind}`));
      });
    } catch (failure) {
      setError(failureText(failure, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} noValidate className="grid gap-4">
      <InputGroup className="grid w-full gap-3">
        <InputField
          index={0}
          label={t('name')}
          value={name}
          disabled={busy}
          placeholder={t('namePlaceholder')}
          autoComplete="off"
          onChange={(value) => {
            setName(value);
            changed(value, endpoint?.name);
          }}
        />
        <InputField
          index={1}
          label={t('addressField')}
          value={address}
          disabled={busy}
          placeholder="http://127.0.0.1:11434/v1"
          autoComplete="off"
          spellCheck={false}
          inputMode="url"
          className="font-mono"
          {...(invalid ? { error: t('addressInvalid') } : {})}
          onChange={(value) => {
            setAddress(value);
            setInvalid(false);
            changed(value, endpoint?.baseUrl);
          }}
        />
      </InputGroup>
      <Tabs
        value={access}
        onValueChange={(value) => setAccess(value as EndpointConfig['access'])}
        className="w-full"
      >
        <TabsList aria-label={t('access')} className="w-full">
          <TabItem value="api_key" label={t('accessKey')} className="flex-1" disabled={busy} />
          <TabItem value="none" label={t('accessNone')} className="flex-1" disabled={busy} />
        </TabsList>
      </Tabs>
      {access === 'api_key' ? (
        <div className="grid gap-1">
          <ApiKeyInput
            kitLabel
            value={key}
            disabled={busy}
            describedBy={safety}
            {...(endpoint || saved.current ? { placeholder: t('keepKey') } : {})}
            onChange={(value) => {
              setKey(value);
              onTyped(Boolean(value));
            }}
          />
          <p id={safety} className="m-0 text-caption text-muted-foreground">
            {tm('keySafety')}
          </p>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="m-0 text-body text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex items-center justify-between gap-2">
        {back ?? <span />}
        <KitButton type="submit" variant="primary" loading={busy} disabled={!address.trim()}>
          {editing ? t('save') : t('connect')}
        </KitButton>
      </div>
    </form>
  );
}
