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
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useServices } from '../services.tsx';
import { useModelSettingsRefresh } from '../workbench/modelSettings.tsx';
import { useSettingsForm, useSettingsTask } from '../workbench/SettingsLifecycle.tsx';
import { SettingsTaskPending } from '../workbench/settingsTasks.ts';
import { ApiKeyInput } from './ApiKeyInput.tsx';
import { ModelImportPanel } from './ModelImportPanel.tsx';
import { endpointIdFor, modelReady, offeredToAdd } from './modelConnections.ts';

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
/** How often a face reads the lists again while it waits for them to settle. */
const READ_EVERY = 1500;
/** Reads after a sign-in left the list with no connection showing before it counts as ended. */
const SETTLE_READS = 3;
/** Reads of a found face's model list before it stops asking (it keeps saying it is reading). */
const LIST_READS = 20;

/** A sign-in the dialog follows: started by a face, or picked up from the lists. */
interface Followed {
  providerId: string;
  /** The server has it: a read showed it, or starting it was answered. */
  seen: boolean;
  /** Picked up from the lists rather than started here. */
  adopted: boolean;
}

const conflicted = (failure: unknown) =>
  failure instanceof ApiError && failure.code === 'REVISION_CONFLICT';

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

  // A sign-in this dialog follows and has not seen finish; leaving cancels it.
  const login = useRef<Followed | null>(null);
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
        .filter(
          (entry) =>
            !entry.endpoint &&
            (entry.methods.oauth || entry.methods.apiKey) &&
            offeredToAdd(entry.providerId, providers, config),
        )
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
        <ModelImportPanel onTyped={setTyped} />
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
    body = (
      <FoundFace
        providerId={face.providerId}
        profiles={profiles}
        onDone={() => onOpenChange(false)}
      />
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
 * The models a connection gave, read again until its list is there: a partial read says the list
 * is still being read rather than that there are none.
 */
function FoundFace({
  providerId,
  profiles,
  onDone,
}: {
  providerId: string;
  profiles: ModelProfileView[];
  onDone: () => void;
}) {
  const t = useTranslations('AddConnection');
  const refresh = useModelSettingsRefresh();
  const found = profiles
    .filter((view) => view.provider === providerId && modelReady(view))
    .map((view) => ({ id: view.modelId, name: view.modelName ?? view.modelId }));
  const unique = [...new Map(found.map((item) => [item.id, item])).values()];
  const reading = unique.length === 0;
  const [reads, setReads] = useState(0);
  useEffect(() => {
    if (!reading || reads >= LIST_READS) return;
    const timer = setTimeout(() => {
      void refresh()
        .catch(() => {})
        .finally(() => setReads((n) => n + 1));
    }, READ_EVERY);
    return () => clearTimeout(timer);
  }, [reading, reads, refresh]);
  return (
    <div className="grid gap-4">
      <ConnectionDiscovery
        working={reading}
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
        <Button variant="primary" onClick={onDone}>
          {t('done')}
        </Button>
      </div>
    </div>
  );
}

/**
 * The failure line of a face: the server's own reason as it gave it (such as a provider that
 * needs more than a key), or "Not saved" with what went wrong before the server answered.
 */
function failureText(
  failure: unknown,
  t: ReturnType<typeof useTranslations<'AddConnection'>>,
  ts: ReturnType<typeof useTranslations<'SettingsDialog'>>,
) {
  // The same write still running from before: said in the settings' own words.
  if (failure instanceof SettingsTaskPending) return ts('pending');
  if (failure instanceof ApiError)
    return failure.code === 'REVISION_CONFLICT' ? t('conflict') : failure.message;
  return t('notSaved', {
    message: failure instanceof Error ? failure.message : String(failure),
  });
}

function SignInFace({
  providerId,
  provider,
  login,
  onTyped,
  onDone,
  back,
}: {
  providerId: string;
  provider: ProviderAuthView | undefined;
  login: { current: Followed | null };
  onTyped: (typed: boolean) => void;
  onDone: () => void;
  back: ReactNode;
}) {
  const t = useTranslations('AddConnection');
  const ts = useTranslations('SettingsDialog');
  const tc = useTranslations('Connections');
  const { models } = useServices();
  const refresh = useModelSettingsRefresh();
  // Each face's own task: a start left behind by an earlier face never blocks this one's.
  const runTask = useSettingsTask(`sign-in:${providerId}:${useId()}`);
  const [started, setStarted] = useState<LoginView | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The sign-in left the lists without a connection: it ended unfinished.
  const [ended, setEnded] = useState(false);
  // Reads since the sign-in left the lists with no connection showing yet.
  const [missed, setMissed] = useState(0);
  const [pasting, setPasting] = useState(false);
  const [redirect, setRedirect] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => onTyped(Boolean(redirect)), [redirect, onTyped]);

  // Connected by a sign-in of Corral's own: a key, or a login borrowed from another tool, that
  // the provider already had does not count as this sign-in finishing.
  const finished = (p: ProviderAuthView | undefined) =>
    Boolean(p?.signedIn && p.method === 'oauth' && p.source !== 'codex-cli');

  const pending = useRef(false);
  const start = async () => {
    if (!models || pending.current) return;
    pending.current = true;
    setStarting(true);
    setError(null);
    setEnded(false);
    setMissed(0);
    setStarted(null);
    const mine: Followed = { providerId, seen: false, adopted: false };
    login.current = mine;
    let view: LoginView;
    try {
      view = await runTask(() => models.startLogin(providerId));
    } catch (failure) {
      // Only this face's own sign-in stops being followed; a later face's is left alone.
      if (login.current === mine) {
        login.current = null;
        setError(failureText(failure, t, ts));
      }
      return;
    } finally {
      pending.current = false;
      setStarting(false);
    }
    if (login.current !== mine) {
      // Left while it started: cancel it unless another face now follows this provider.
      if (login.current?.providerId !== providerId)
        void models.cancelLogin(providerId).catch(() => {});
      return;
    }
    // The server has it now, whether or not the next read shows it.
    mine.seen = true;
    setStarted(view);
    void refresh().catch(() => {});
  };
  // Choosing subscription sign-in starts it: the provider page is the next step.
  const once = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: The sign-in starts once per face.
  useEffect(() => {
    if (once.current) return;
    once.current = true;
    if (provider?.login && provider.login.state !== 'failed') {
      login.current = { providerId, seen: true, adopted: true };
      return;
    }
    void start();
  }, []);

  const view = provider?.login ?? started;
  const listed = Boolean(provider?.login);
  // The lists show the sign-in, then it is gone with the provider connected by it: it finished.
  useEffect(() => {
    const running = login.current;
    if (running?.providerId !== providerId) return;
    if (provider?.login) {
      running.seen = true;
      return;
    }
    if (running.seen && finished(provider)) {
      login.current = null;
      onDone();
    }
  });
  // Gone from the lists with no connection showing yet: read again until it settles, then start
  // a picked-up sign-in again, or say this one ended.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Reads follow the sign-in's own state.
  useEffect(() => {
    const running = login.current;
    if (running?.providerId !== providerId || !running.seen || listed || ended) return;
    if (finished(provider)) return;
    if (missed >= SETTLE_READS) {
      if (running.adopted) void start();
      else {
        login.current = null;
        setEnded(true);
      }
      return;
    }
    const timer = setTimeout(() => {
      void refresh()
        .catch(() => {})
        .finally(() => setMissed((n) => n + 1));
    }, READ_EVERY);
    return () => clearTimeout(timer);
  }, [started, listed, missed, ended, provider?.signedIn, provider?.method]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const url = redirect.trim();
    if (!url || !models) return;
    setBusy(true);
    setError(null);
    try {
      const accepted = await runTask(() => models.submitRedirect(providerId, url));
      // Sent: the address is not shown again, accepted or not.
      setRedirect('');
      if (!accepted) {
        setError(t('pasteRefused'));
        return;
      }
      setPasting(false);
    } catch (failure) {
      setError(failureText(failure, t, ts));
      return;
    } finally {
      setBusy(false);
    }
    void refresh().catch(() => {});
  };

  const failed = view?.state === 'failed';
  const stopped = failed || ended;
  return (
    <div className="grid gap-4">
      {failed ? (
        <p role="alert" className="m-0 text-body text-danger">
          {t('signInFailed', { message: view.error ?? '' })}
        </p>
      ) : ended ? (
        <p role="alert" className="m-0 text-body text-danger">
          {tc('cause.signInFailed')}
        </p>
      ) : (
        <p role="status" className="m-0 shimmer-text text-body text-muted-foreground">
          {!view?.authUrl
            ? t('starting')
            : view.state === 'exchanging'
              ? t('exchanging')
              : t('waiting')}
        </p>
      )}
      {error ? (
        <p role="alert" className="m-0 text-body text-danger">
          {error}
        </p>
      ) : null}
      {view?.userCode && !stopped ? (
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
      {view?.authUrl && !view.userCode && !stopped ? (
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
                onChange={setRedirect}
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
        {stopped ? (
          <KitButton variant="primary" loading={starting} onClick={() => void start()}>
            {t('tryAgain')}
          </KitButton>
        ) : view?.authUrl ? (
          <Button
            variant="primary"
            render={<a href={view.authUrl} target="_blank" rel="noopener noreferrer" />}
          >
            {t('openSignIn')}
            <ExternalLink aria-hidden />
          </Button>
        ) : (
          <KitButton variant="primary" loading>
            {t('openSignIn')}
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
  const ts = useTranslations('SettingsDialog');
  const { models } = useServices();
  const refresh = useModelSettingsRefresh();
  const runTask = useSettingsTask(`api-key:${providerId}`);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => onTyped(Boolean(key)), [key, onTyped]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = key.trim();
    if (!value || !models || busy) return;
    setBusy(true);
    setError(null);
    try {
      await runTask(async () => {
        try {
          return await models.setApiKey(providerId, value, revision);
        } catch (failure) {
          if (!conflicted(failure)) throw failure;
          // Something else was saved since: the key goes onto the config as it is now.
          return await models.setApiKey(providerId, value, (await models.config()).revision);
        }
      });
    } catch (failure) {
      // A key the server answered about leaves the page; one that never reached it stays to
      // send again.
      if (failure instanceof ApiError) setKey('');
      // The server's own reason, such as a provider that needs more than a key.
      setError(failureText(failure, t, ts));
      return;
    } finally {
      setBusy(false);
    }
    setKey('');
    await refresh().catch(() => {});
    onDone();
  };
  return (
    <form onSubmit={(event) => void submit(event)} className="grid gap-4">
      <ApiKeyInput kitLabel value={key} disabled={busy} onChange={setKey} />
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
  const ts = useTranslations('SettingsDialog');
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
  // Typed input is whatever differs from the endpoint as saved, and a typed key.
  const kept = saved.current?.endpoint ?? endpoint;
  const typed =
    name !== (kept?.name ?? '') ||
    address !== (kept?.baseUrl ?? '') ||
    access !== (kept?.access ?? 'api_key') ||
    Boolean(key);
  useEffect(() => onTyped(typed), [typed, onTyped]);

  /** Saves the address onto `onto`, sends a typed key and fetches the model list. */
  const connect = async (onto: ModelConfig) => {
    if (!models) return;
    const baseUrl = address.trim();
    const label = name.trim() || new URL(baseUrl).host;
    const current =
      (saved.current &&
        onto.modelProviders.find((entry) => entry.id === saved.current?.endpoint.id)) ??
      saved.current?.endpoint ??
      endpoint;
    const known = Boolean(current && onto.modelProviders.some((entry) => entry.id === current.id));
    let revision = known || !saved.current ? onto.revision : saved.current.revision;
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
      const others = onto.modelProviders.filter((entry) => entry.id !== next.id);
      const result = await models.saveConfig({
        revision,
        modelProfiles: onto.modelProfiles,
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
    await refresh().catch(() => {});
    if (fetched.kind === 'connected') onDone(next.id);
    else setError(t(`fetch.${fetched.kind}`));
  };

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
        try {
          await connect(config);
        } catch (failure) {
          if (!conflicted(failure)) throw failure;
          // Something else was saved since: the address goes onto the config as it is now.
          await connect(await models.config());
        }
      });
    } catch (failure) {
      // A key the server answered about leaves the page; one that never reached it stays.
      if (failure instanceof ApiError) setKey('');
      setError(failureText(failure, t, ts));
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
          onChange={setName}
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
          className="[&_input]:font-mono"
          {...(invalid ? { error: t('addressInvalid') } : {})}
          onChange={(value) => {
            setAddress(value);
            setInvalid(false);
          }}
        />
      </InputGroup>
      <Tabs
        value={access}
        onValueChange={(value) => {
          setAccess(value as EndpointConfig['access']);
          // No key: a key typed for it does not stay behind.
          if (value === 'none') setKey('');
        }}
        className="w-full"
      >
        <TabsList aria-label={t('access')} className="w-full">
          <TabItem value="api_key" label={t('accessKey')} className="flex-1" disabled={busy} />
          <TabItem value="none" label={t('accessNone')} className="flex-1" disabled={busy} />
        </TabsList>
      </Tabs>
      {access === 'api_key' ? (
        <ApiKeyInput
          kitLabel
          value={key}
          disabled={busy}
          {...(endpoint || saved.current ? { placeholder: t('keepKey') } : {})}
          onChange={setKey}
        />
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
