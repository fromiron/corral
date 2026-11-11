import type {
  CatalogProvider,
  ModelConfig,
  ModelProfileView,
  ProviderAuthView,
  SourcedValue,
} from '@corral/client';
import { providerMark } from '@corral/react';
import {
  Button,
  type Connection,
  Connections,
  cn,
  fontWeights,
  InputField,
  InputGroup,
  Menu,
  MenuItem,
  MenuPopup,
  MenuTrigger,
} from '@corral/react/design-kit';
import { Brain, Ellipsis, ImageIcon, Plus, RefreshCw, Search } from '@corral/react/icons';
import { type KeyboardEvent, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useServices } from '../services.tsx';
import { useModelSettingsRefresh } from '../workbench/modelSettings.tsx';
import { useSettingsTask } from '../workbench/SettingsLifecycle.tsx';
import { AddConnectionDialog, type AddConnectionStart } from './AddConnectionDialog.tsx';
import { ModelCatalogDialog } from './ModelCatalogDialog.tsx';
import {
  type ConnectionAction,
  connectionState,
  modelKey,
  sortConnections,
} from './modelConnections.ts';

/** A list longer than this gets a filter inside its row. */
const FILTER_FROM = 12;
/** Rows drawn at first; scrolling near the end draws the next ones. */
const PAGE = 60;

/**
 * Settings → Models → Connections: the connected providers (and the ones profiles name) as rows
 * with one line each, and one way to add a connection (features/model-connections.md, 연결).
 */
export function ModelConnections({
  providers,
  catalog,
  profiles,
  config,
  onMakeProfile,
  onOpenProfile,
}: {
  providers: ProviderAuthView[];
  catalog: CatalogProvider[];
  profiles: ModelProfileView[];
  config: ModelConfig | null;
  onMakeProfile: (provider: string, modelId: string) => void;
  onOpenProfile: (profileId: string) => void;
}) {
  const t = useTranslations('Connections');
  const { models } = useServices();
  const refresh = useModelSettingsRefresh();
  const runTask = useSettingsTask('model-connections');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [adding, setAdding] = useState<AddConnectionStart | null>(null);
  const [catalogView, setCatalogView] = useState<'show' | 'refresh' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const act = async (providerId: string, action: () => Promise<unknown>) => {
    setBusy(providerId);
    setErrors(({ [providerId]: _, ...rest }) => rest);
    try {
      await runTask(action);
      await refresh();
    } catch (failure) {
      setErrors((all) => ({
        ...all,
        [providerId]: t('failed', {
          message: failure instanceof Error ? failure.message : String(failure),
        }),
      }));
    } finally {
      setBusy(null);
    }
  };
  const refreshModels = (provider: ProviderAuthView) =>
    config &&
    act(
      provider.providerId,
      () =>
        models?.refreshEndpointModels(provider.providerId, config.revision) ?? Promise.resolve(),
    );
  const run = (provider: ProviderAuthView, action: ConnectionAction) => {
    if (action === 'retry') return void refreshModels(provider);
    if (provider.endpoint) return setAdding({ face: 'address', providerId: provider.providerId });
    setAdding({
      face: 'connect',
      providerId: provider.providerId,
      ...(action === 'enterKeyAgain' ? { method: 'apiKey' as const } : {}),
    });
  };
  const removeEndpoint = (provider: ProviderAuthView) => {
    if (!config || !models) return;
    const users = config.modelProfiles.filter((p) => p.provider === provider.providerId);
    if (users.length) {
      setErrors((all) => ({
        ...all,
        [provider.providerId]: t('usedBy', { profiles: users.map((p) => p.id).join(', ') }),
      }));
      return;
    }
    void act(provider.providerId, async () => {
      // The key goes first, while the server still knows the endpoint.
      if (provider.method === 'api_key' && provider.source === 'corral')
        await models.logout(provider.providerId);
      await models.saveConfig({
        revision: config.revision,
        modelProfiles: config.modelProfiles,
        modelProviders: config.modelProviders.filter((e) => e.id !== provider.providerId),
      });
    });
  };

  const rows: Connection[] = sortConnections(providers).map((provider) => {
    const state = connectionState(provider);
    // A connection listed only because profiles point at it, with no models of its own to show.
    const users = (config?.modelProfiles ?? []).filter((p) => p.provider === provider.providerId);
    const line =
      state.kind === 'connected'
        ? state.count === 0 && users.length
          ? t('usedBy', { profiles: users.map((p) => p.id).join(', ') })
          : t('summary', {
              method: t(`method.${state.method}`),
              models: t('models', { count: state.count }),
            })
        : t(`cause.${state.cause}`);
    const action = state.kind === 'action' ? state.action : null;
    const logo = providerMark(provider.providerId);
    return {
      id: provider.providerId,
      name: provider.name,
      ...(logo ? { logo } : {}),
      status:
        state.kind === 'connected'
          ? 'connected'
          : busy === provider.providerId
            ? 'connecting'
            : state.status,
      line,
      action: action
        ? {
            label: t(`action.${action}`),
            name: t('actionNamed', { action: t(`action.${action}`), name: provider.name }),
            loading: busy === provider.providerId,
            run: () => run(provider, action),
          }
        : null,
      details: (
        <ConnectionDetails
          provider={provider}
          catalog={catalog}
          profiles={profiles}
          config={config}
          busy={busy === provider.providerId}
          error={errors[provider.providerId] ?? null}
          onMakeProfile={onMakeProfile}
          onOpenProfile={onOpenProfile}
          onDisconnect={() =>
            void act(
              provider.providerId,
              () => models?.logout(provider.providerId) ?? Promise.resolve(),
            )
          }
          onRefresh={() => void refreshModels(provider)}
          onEditAddress={() => setAdding({ face: 'address', providerId: provider.providerId })}
          onRemove={() => removeEndpoint(provider)}
          onSignInHere={() =>
            setAdding({ face: 'connect', providerId: provider.providerId, method: 'oauth' })
          }
        />
      ),
    };
  });

  return (
    <section id="models-providers" tabIndex={-1} className="outline-none">
      <Connections
        connections={rows}
        expanded={expanded}
        onExpandedChange={setExpanded}
        titleHidden
        onAdd={() => setAdding({ face: 'find' })}
        addOpen={adding !== null}
        actions={
          <Menu>
            <MenuTrigger
              render={
                <Button variant="ghost" size="icon" aria-label={t('more')} title={t('more')} />
              }
            >
              <Ellipsis aria-hidden />
            </MenuTrigger>
            <MenuPopup align="end" className="w-60">
              <MenuItem onClick={() => setCatalogView('show')}>{t('catalog')}</MenuItem>
              <MenuItem onClick={() => setCatalogView('refresh')}>{t('refreshCatalog')}</MenuItem>
            </MenuPopup>
          </Menu>
        }
        labels={{
          title: t('heading'),
          add: t('add'),
          empty: t('empty'),
          announce: (connection) =>
            connection.status === 'connected'
              ? t('announce.connected', { name: connection.name, models: connection.line })
              : t('announce.needs', { name: connection.name, line: connection.line }),
          removed: (name) => t('announce.removed', { name }),
        }}
      />
      {adding ? (
        <AddConnectionDialog
          open
          onOpenChange={(open) => {
            if (!open) setAdding(null);
          }}
          start={adding}
          providers={providers}
          catalog={catalog}
          config={config}
          profiles={profiles}
        />
      ) : null}
      {catalogView ? (
        <ModelCatalogDialog
          refresh={catalogView === 'refresh'}
          onClose={() => setCatalogView(null)}
        />
      ) : null}
    </section>
  );
}

/** One model of a connection, with the limits the row marks. */
interface ConnectionModel {
  id: string;
  name: string;
  contextWindow: SourcedValue<number> | null;
  reasoning: SourcedValue<string[]> | null;
  imageInput: SourcedValue<boolean> | null;
  /** The named profile that already points at this model. */
  profile: string | null;
}

function modelsOf(
  provider: ProviderAuthView,
  catalog: CatalogProvider[],
  profiles: ModelProfileView[],
): ConnectionModel[] {
  const named = new Map(
    profiles
      .filter((p) => p.source === 'profile' && p.provider === provider.providerId)
      .map((p) => [modelKey(p.provider, p.modelId), p.profileId]),
  );
  const endpoint = provider.endpoint
    ? catalog.find((entry) => entry.endpoint && entry.providerId === provider.providerId)
    : undefined;
  // The levels a model offers are the server's, read from its model views; none means the
  // provider's own default only.
  const levels = (modelId: string) =>
    profiles.find(
      (p) => p.provider === provider.providerId && p.modelId === modelId && p.reasoningCapabilities,
    )?.reasoningCapabilities?.levels ?? [];
  if (endpoint)
    return endpoint.models.map((model) => ({
      id: model.id,
      name: model.name,
      contextWindow: model.limits?.contextWindow ?? null,
      reasoning: model.limits?.reasoning.value
        ? { value: levels(model.id), source: model.limits.reasoning.source }
        : null,
      imageInput: model.limits?.imageInput ?? null,
      profile: named.get(modelKey(provider.providerId, model.id)) ?? null,
    }));
  if (!provider.signedIn) return [];
  const seen = new Set<string>();
  const out: ConnectionModel[] = [];
  for (const view of profiles) {
    if (view.provider !== provider.providerId || !view.available) continue;
    if (view.source === 'profile' && !view.keyConfigured) continue;
    if (seen.has(view.modelId)) continue;
    seen.add(view.modelId);
    const config = { source: 'config' as const };
    out.push({
      id: view.modelId,
      name: view.modelName ?? view.modelId,
      contextWindow: view.contextWindow !== null ? { value: view.contextWindow, ...config } : null,
      reasoning: view.reasoningCapabilities?.levels.length
        ? { value: view.reasoningCapabilities.levels, ...config }
        : view.reasoning
          ? { value: [], ...config }
          : null,
      imageInput: view.imageInput != null ? { value: view.imageInput, ...config } : null,
      profile: named.get(modelKey(view.provider, view.modelId)) ?? null,
    });
  }
  return out;
}

/** 128k, 1M: a context window at a glance. */
function shortTokens(count: number) {
  if (count >= 1_000_000) {
    const m = count / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1).replace(/\.0$/, '')}M`;
  }
  return `${Math.round(count / 1000)}k`;
}

function ConnectionDetails({
  provider,
  catalog,
  profiles,
  config,
  busy,
  error,
  onMakeProfile,
  onOpenProfile,
  onDisconnect,
  onRefresh,
  onEditAddress,
  onRemove,
  onSignInHere,
}: {
  provider: ProviderAuthView;
  catalog: CatalogProvider[];
  profiles: ModelProfileView[];
  config: ModelConfig | null;
  busy: boolean;
  error: string | null;
  onMakeProfile: (provider: string, modelId: string) => void;
  onOpenProfile: (profileId: string) => void;
  onDisconnect: () => void;
  onRefresh: () => void;
  onEditAddress: () => void;
  onRemove: () => void;
  onSignInHere: () => void;
}) {
  const t = useTranslations('Connections');
  const tm = useTranslations('Models');
  const tq = useTranslations('Reasoning');
  const list = useMemo(() => modelsOf(provider, catalog, profiles), [provider, catalog, profiles]);
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState(PAGE);
  const [focusIndex, setFocusIndex] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const q = query.trim().toLowerCase();
  const matches = q
    ? list.filter((model) =>
        q.split(/\s+/).every((word) => `${model.name} ${model.id}`.toLowerCase().includes(word)),
      )
    : list;
  const drawn = matches.slice(0, shown);
  const users = (config?.modelProfiles ?? []).filter((p) => p.provider === provider.providerId);
  const own =
    provider.source === 'corral' && (provider.method === 'oauth' || provider.method === 'api_key');
  const borrowed = provider.source === 'codex-cli';

  const withSource = (text: string, value: SourcedValue<unknown> | null) =>
    value && value.source !== 'config'
      ? t('withSource', { value: text, source: t(`source.${value.source}`) })
      : text;
  // One tab stop for the list; arrows move between the rows' actions.
  const onListKey = (e: KeyboardEvent<HTMLUListElement>) => {
    const next =
      e.key === 'ArrowDown'
        ? focusIndex + 1
        : e.key === 'ArrowUp'
          ? focusIndex - 1
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? matches.length - 1
              : null;
    if (next === null) return;
    e.preventDefault();
    const index = Math.max(0, Math.min(matches.length - 1, next));
    if (index >= shown) setShown(index + PAGE);
    setFocusIndex(index);
    requestAnimationFrame(() =>
      listRef.current?.querySelectorAll<HTMLElement>('[data-model-action]')[index]?.focus(),
    );
  };

  return (
    <div className="grid gap-3" aria-busy={busy || undefined}>
      {borrowed && !provider.permissionsOk ? (
        <p role="alert" className="m-0 text-caption text-warning">
          {tm('codexPermissions')}
        </p>
      ) : null}
      {list.length > FILTER_FROM ? (
        <InputGroup className="w-full">
          <InputField
            index={0}
            label={t('filter')}
            labelHidden
            icon={Search}
            placeholder={t('filter')}
            value={query}
            onChange={(value) => {
              setQuery(value);
              setShown(PAGE);
              setFocusIndex(0);
            }}
            autoComplete="off"
          />
        </InputGroup>
      ) : null}
      {list.length ? (
        <ul
          ref={listRef}
          aria-label={t('modelList', { name: provider.name })}
          className="m-0 grid max-h-[22rem] list-none overflow-y-auto overscroll-contain p-0"
          onKeyDown={onListKey}
          onScroll={(event) => {
            const el = event.currentTarget;
            if (el.scrollTop + el.clientHeight > el.scrollHeight - 200 && shown < matches.length)
              setShown(shown + PAGE);
          }}
        >
          {drawn.map((model, index) => {
            const context = model.contextWindow;
            const reasoning = model.reasoning;
            const levels = reasoning?.value.length
              ? t('reasoning', {
                  levels: reasoning.value.map((level) => tq(`level.${level}`)).join(', '),
                })
              : t('reasoningOn');
            return (
              <li
                key={model.id}
                className={cn(
                  'group/model flex min-h-8 items-center gap-2 py-1 text-body',
                  index > 0 && 'border-t border-border',
                )}
              >
                <span className="min-w-0 flex-1 truncate text-foreground">{model.name}</span>{' '}
                {/* Fixed slots keep each mark in its own column down the list. */}
                <span className="flex shrink-0 items-center gap-2 text-caption text-muted-foreground tabular-nums">
                  {context ? (
                    <span
                      data-mark="context"
                      className="w-10 text-right"
                      title={withSource(t('context', { value: context.value }), context)}
                    >
                      {shortTokens(context.value)}
                    </span>
                  ) : (
                    <span aria-hidden className="w-10" />
                  )}
                  {reasoning ? (
                    <span
                      data-mark="reasoning"
                      title={withSource(levels, reasoning)}
                      className="inline-flex"
                    >
                      <Brain aria-hidden className="size-3.5" strokeWidth={1.5} />
                      <span className="sr-only">{levels}</span>
                    </span>
                  ) : (
                    <span aria-hidden className="size-3.5" />
                  )}
                  {model.imageInput?.value ? (
                    <span
                      data-mark="image"
                      title={withSource(t('image'), model.imageInput)}
                      className="inline-flex"
                    >
                      <ImageIcon aria-hidden className="size-3.5" strokeWidth={1.5} />
                      <span className="sr-only">{t('image')}</span>
                    </span>
                  ) : (
                    <span aria-hidden className="size-3.5" />
                  )}
                </span>{' '}
                {model.profile ? (
                  <Button
                    variant="ghost"
                    size="compact"
                    data-model-action=""
                    tabIndex={index === focusIndex ? 0 : -1}
                    onFocus={() => setFocusIndex(index)}
                    aria-label={t('openProfile', { profile: model.profile })}
                    className="max-w-[40%] shrink-0 font-mono text-muted-foreground"
                    onClick={() => onOpenProfile(model.profile as string)}
                  >
                    <span className="truncate">{model.profile}</span>
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="compact"
                    data-model-action=""
                    tabIndex={index === focusIndex ? 0 : -1}
                    onFocus={() => setFocusIndex(index)}
                    aria-label={t('makeProfileFor', { model: model.name })}
                    className="shrink-0 text-muted-foreground opacity-0 transition-opacity duration-(--duration-moderate) ease-(--ease-out-soft) motion-reduce:transition-none group-hover/model:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
                    onClick={() => onMakeProfile(provider.providerId, model.id)}
                  >
                    {/* Narrow, the row keeps the model's name and marks; the plus is the action. */}
                    <Plus aria-hidden className="sm:hidden" />
                    <span className="max-sm:hidden">{t('makeProfile')}</span>
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
      {list.length > FILTER_FROM && q && !matches.length ? (
        <p className="m-0 text-caption text-muted-foreground [overflow-wrap:anywhere]">
          {t('noMatch', { query: query.trim() })}
        </p>
      ) : null}
      {!provider.signedIn && users.length ? (
        <p className="m-0 text-caption text-muted-foreground">
          {t('usedBy', { profiles: users.map((p) => p.id).join(', ') })}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="m-0 text-caption text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-t border-border pt-2.5">
        {provider.endpoint ? (
          <span
            className="mr-auto min-w-0 truncate font-mono text-caption text-muted-foreground"
            style={{ fontVariationSettings: fontWeights.normal }}
          >
            {provider.endpoint}
          </span>
        ) : (
          <span className="mr-auto" />
        )}
        {provider.endpoint ? (
          <>
            <Button
              variant="tertiary"
              size="compact"
              disabled={busy || !config}
              onClick={onRefresh}
            >
              <RefreshCw aria-hidden />
              {t('refreshModels')}
            </Button>
            <Button variant="tertiary" size="compact" disabled={busy} onClick={onEditAddress}>
              {t('editAddress')}
            </Button>
          </>
        ) : null}
        {borrowed && provider.methods.oauth ? (
          <Button variant="tertiary" size="compact" disabled={busy} onClick={onSignInHere}>
            {t('signInHere')}
          </Button>
        ) : null}
        {own && provider.signedIn ? (
          <Button
            variant="tertiary"
            size="compact"
            disabled={busy}
            aria-label={t('disconnectNamed', { name: provider.name })}
            onClick={onDisconnect}
          >
            {t('disconnect')}
          </Button>
        ) : null}
        {provider.endpoint ? (
          <Button
            variant="ghost-destructive"
            size="compact"
            disabled={busy || !config}
            aria-label={t('removeNamed', { name: provider.name })}
            onClick={onRemove}
          >
            {t('remove')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
