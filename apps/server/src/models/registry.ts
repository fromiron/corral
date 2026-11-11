import { createHash, randomUUID } from 'node:crypto';
import {
  ContextMeter,
  type EndpointSpec,
  endpointProvider,
  type ModelBroker,
  managedRetryStream,
  modelReasoningCapabilities as reasoningCapabilities,
  reasoningRequest,
} from '@corral/adapter-pi';
import { providerFailure } from '@corral/adapter-pi/request-policy';
import type {
  AgentStartInput,
  AutoModelChoice,
  AutoRouteLevel,
  ModelProfileSnapshot,
  ModelRequestIntent,
  ProfileContextOverrides,
  ProfileContextPolicy,
  ReasoningCapabilities,
  TeamPlan,
} from '@corral/contracts';
import { canonicalJson } from '@corral/contracts';
import {
  AUTO_ROUTE_MAX_RESPONSE_BYTES,
  AUTO_ROUTE_TIMEOUT_MS,
  autoRouterPrompt,
  FALLBACK_OUTPUT_TOKENS,
  fixedReasoning,
  type ModelResolution,
  type ModelResolver,
  type RouteAnswer,
  resolveProfileContext,
} from '@corral/core';
import { accountModelStream, withSessionAffinityOptions } from '@corral/pi-runtime-port';
import type {
  Api,
  AssistantMessage,
  AuthEvent,
  AuthPrompt,
  CredentialStore,
  Model,
  Models,
  MutableModels,
} from '@earendil-works/pi-ai';
import type { ModelCatalogService } from './catalog-service.ts';
import { connectionProfileId } from './connection-models.ts';
import {
  type EndpointFetchResult,
  type EndpointModelCache,
  type EndpointModelSource,
  endpointAddress,
  fetchEndpointModels,
} from './endpoint-models.ts';
import { probeEndpoint } from './endpoint-probe.ts';
import {
  ENDPOINT_ORIGIN,
  type Endpoint,
  endpointModelSpec,
  endpointsFrom,
  type ModelValueField,
  registerEndpoints,
  registeredEndpointIds,
  type ValueSource,
} from './endpoints.ts';
import { ModelRequestRuntime, type RequestRuntimeOptions } from './request-runtime.ts';
import {
  DRAFT_MAX_OUTPUT_TOKENS,
  DRAFT_SYSTEM_PROMPT,
  DRAFT_TIMEOUT_MS,
  planFromAnswer,
} from './team-draft.ts';

// Model profiles and sign-in for the local server. Profiles name a provider
// and model; credentials stay in pi-ai's credential store on this computer. Views and errors
// carry status and expiry only: no token, key or callback URL ever leaves through them.

export interface ProfileConfig extends ProfileContextOverrides {
  id: string;
  provider: string;
  model: string;
  workerIsolation?: 'linux-bwrap';
}

/**
 * Two OpenAI profiles, used when the workspace config names none. Both are in pi-ai's
 * ChatGPT-account catalog: a ChatGPT sign-in refuses models outside it (live smoke, P3).
 */
export const DEFAULT_PROFILES: readonly ProfileConfig[] = [
  { id: 'model-a', provider: 'openai', model: 'gpt-6-luna' },
  { id: 'model-b', provider: 'openai', model: 'gpt-6.1-sol' },
];

/**
 * What a provider's key auth needs besides the key, as Pi resolves it (its Cloudflare
 * providers read these from the server environment). Named when a key alone is refused.
 */
const KEY_NEEDS: Readonly<Record<string, { what: string; env: string }>> = {
  'cloudflare-workers-ai': { what: 'a Cloudflare account ID', env: 'CLOUDFLARE_ACCOUNT_ID' },
  'cloudflare-ai-gateway': {
    what: 'a Cloudflare account ID and AI Gateway ID',
    env: 'CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_GATEWAY_ID',
  },
};

/** Corral's own sign-in to this provider makes a borrowed Codex CLI login no connection. */
const OPENAI = 'openai';

/** How a provider is reached: `none` is a keyless local endpoint. */
export type AuthMethod = 'oauth' | 'api_key' | 'none';

/** A sign-in request the registry cannot serve; `code` picks the HTTP answer. */
export class RegistryError extends Error {
  /** `conflict`: settings or the credential changed while the request was in flight. */
  readonly code: 'not_found' | 'unsupported' | 'conflict';
  constructor(code: 'not_found' | 'unsupported' | 'conflict', message: string) {
    super(message);
    this.code = code;
  }
}

/** The last model list fetch of an endpoint: its category, HTTP status and time. */
export interface EndpointModelsView {
  kind: EndpointFetchResult['kind'];
  status: number | null;
  fetchedAt: string;
  modelCount: number;
}

export interface ProviderAuthView {
  providerId: string;
  name: string;
  signedIn: boolean;
  method: AuthMethod | null;
  /** Ways this provider can be signed in to here. */
  methods: { oauth: boolean; apiKey: boolean };
  /** host[:port] of an OpenAI-compatible endpoint; null for pi-ai's own providers. */
  endpoint: string | null;
  /** A key was entered for another address than the one the workspace names now. */
  endpointChanged: boolean;
  connectionTest?: {
    kind:
      | 'connected'
      | 'authentication'
      | 'rateLimit'
      | 'server'
      | 'redirect'
      | 'unsupported'
      | 'connection';
    status: number | null;
    checkedAt: string;
  } | null;
  /** Subscription access (no per-request price is known). */
  subscription: boolean;
  /** When the current access token stops working; refreshed before requests. */
  expiresAt: string | null;
  login: LoginView | null;
  /**
   * Where the sign-in comes from: Corral's own store, the Codex CLI login read only,
   * or a key in the server environment (which the page cannot remove).
   */
  source: 'corral' | 'codex-cli' | 'environment' | null;
  /** True only when borrowed login permissions are verified private; false includes unknown. */
  permissionsOk: boolean;
  /** Models this connection can use now; 0 when it is not connected. */
  modelCount: number;
  /** An endpoint's last `/models` fetch; null for built-in providers and before any fetch. */
  modelFetch: Omit<EndpointModelsView, 'modelCount'> | null;
}

/** One value of an endpoint model and where it came from. */
export interface SourcedValue<T> {
  value: T;
  source: ValueSource;
}

export interface CatalogProvider {
  providerId: string;
  name: string;
  /** An OpenAI-compatible endpoint from the workspace config. */
  endpoint: boolean;
  methods: { oauth: boolean; apiKey: boolean };
  models: {
    id: string;
    name: string;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
    /** Endpoint models only: each limit and ability with its source. */
    limits?: {
      contextWindow: SourcedValue<number>;
      maxOutput: SourcedValue<number>;
      reasoning: SourcedValue<boolean>;
      imageInput: SourcedValue<boolean>;
    };
  }[];
}

export interface LoginView {
  state: 'waiting' | 'exchanging' | 'failed';
  /** The provider's sign-in page; opening it is the person's own step. */
  authUrl: string | null;
  /** The code to enter on that page, for a device-code sign-in. */
  userCode: string | null;
  error: string | null;
}

export interface ModelProfileView {
  profileId: string;
  /** A named profile from the config, or a model of a connected provider. */
  source: 'profile' | 'connection';
  provider: string;
  providerName: string;
  modelId: string;
  modelName: string | null;
  available: boolean;
  reasoning: boolean | null;
  imageInput?: boolean | null;
  reasoningCapabilities: ReasoningCapabilities;
  contextWindow: number | null;
  contextPolicy?: ProfileContextPolicy;
  maxOutputTokens: number | null;
  method: AuthMethod | null;
  keyConfigured: boolean;
  /** Whether a subscription sign-in may use this model; null when no list is known. */
  subscriptionSupported: boolean | null;
}

export interface RegistryOptions {
  configRevision?: string;
  credentials: CredentialStore;
  getDeviceId(): string;
  now?: () => number;
  /** Models a subscription sign-in may call, per provider; null when no list is known. */
  subscriptionModels?: (providerId: string) => ReadonlySet<string> | null;
  /** OpenAI-compatible endpoints from the workspace config, already registered. */
  endpoints?: ReadonlyMap<string, Endpoint>;
  /** Fetching endpoint model lists: the cache, models.dev metadata and the request function. */
  endpointModels?: {
    cache: EndpointModelCache;
    catalog?: ModelCatalogService | null;
    fetch?: typeof fetch;
    timeoutMs?: number;
  };
}

interface ModelFetch {
  /** The endpoint's credential epoch when the fetch started. */
  epoch: string;
  /** The endpoint as it was when the fetch started: its address and access. */
  endpoint: Endpoint;
  abort: AbortController;
  promise: Promise<EndpointModelsView>;
}

const SIGN_IN = (name: string) => `sign in to ${name} under Settings → Models`;

interface PendingLogin {
  view: LoginView;
  abort: AbortController;
  manual: ((value: string) => void) | null;
}

export class ModelRegistry implements ModelResolver {
  private readonly status = new Map<
    string,
    {
      method: AuthMethod | null;
      expires: number | null;
      endpointChanged: boolean;
      stored: boolean;
      /** What Pi says this credential can call, cached for the synchronous resolver. */
      models: readonly Model<Api>[];
    }
  >();
  private readonly logins = new Map<string, PendingLogin>();
  /** The newest status check per provider; an older one that finishes later is dropped. */
  private readonly statusChecks = new Map<string, number>();
  /** Every connection model id of every known provider, connected or not. */
  private connectionIds: Map<string, { provider: string; model: string }> | null = null;

  /**
   * The endpoint model definitions Runs were resolved with, by provider and snapshot hash, with
   * what a person wrote for them then. A later fetched change leaves them in use; a written change
   * refuses them (features/model-connections.md, Run과 엔드포인트 정의). Entries whose written part
   * no longer matches the config are dropped when it is saved.
   */
  private readonly pinned = new Map<
    string,
    { provider: string; modelId: string; spec: EndpointSpec; written: string }
  >();

  private readonly fetches = new Map<string, ModelFetch>();
  private readonly lastFetch = new Map<string, Omit<EndpointModelsView, 'modelCount'>>();
  /** Providers with a list Pi fetches whose refresh has finished in this process. */
  private readonly dynamicLoaded = new Set<string>();
  /** Bumped per provider when its credential changes; a fetch across a change is dropped. */
  private readonly credentialEpochs = new Map<string, number>();
  private readonly background = new Set<Promise<unknown>>();
  private readonly stopped = new AbortController();

  private readonly connectionTests = new Map<
    string,
    NonNullable<ProviderAuthView['connectionTest']>
  >();
  private connectionEpoch = 0;

  private requests?: ModelRequestRuntime;
  configureRequests(options: RequestRuntimeOptions) {
    this.requests = new ModelRequestRuntime(options);
  }
  retryAfterMs(model: ModelProfileSnapshot) {
    return model.provider ? (this.requests?.retryAfterMs(model.provider) ?? 0) : 0;
  }

  private managedStream(
    model: Parameters<Models['streamSimple']>[0],
    context: Parameters<Models['streamSimple']>[1],
    options: Parameters<Models['streamSimple']>[2],
    intent: ModelRequestIntent,
    admitted = false,
    snapshot?: ModelProfileSnapshot,
    meter?: ContextMeter,
    onDispatch?: () => () => void,
  ) {
    const prepared = withSessionAffinityOptions(
      {
        ...options,
        // Re-resolve the host's origin-bound credential; a bare per-request key loses its binding.
        ...(this.options.endpoints?.has(model.provider) ? { apiKey: undefined } : {}),
        onPayload: async (payload, selected) => {
          if (snapshot) this.endpointSpecOf(snapshot);
          return (await options?.onPayload?.(payload, selected)) ?? payload;
        },
        cacheRetention: options?.cacheRetention ?? 'short',
        sessionId:
          options?.sessionId ??
          createHash('sha256')
            .update(`${intent.owner.kind}:${intent.owner.sessionId ?? intent.owner.id}`)
            .digest('hex'),
      },
      model.api,
      this.options.endpoints?.get(model.provider)?.spec.sessionAffinity,
    );
    const open = (retryIndex = intent.retryIndex ?? 0) => {
      if (this.requests)
        return this.requests.stream(
          this.models,
          model,
          context,
          { ...intent, retryIndex },
          prepared,
          admitted,
          {
            subscription: this.status.get(model.provider)?.method === 'oauth',
            ...(this.isBuiltin(model.provider) ? { rates: model.cost } : {}),
          },
          snapshot,
          meter,
          onDispatch,
        );
      const finish = onDispatch?.();
      try {
        const stream = this.models.streamSimple(model, context, prepared);
        return finish ? accountModelStream(stream, finish) : stream;
      } catch (error) {
        finish?.();
        throw error;
      }
    };
    return admitted
      ? open()
      : managedRetryStream({
          model,
          signal: options?.signal ?? new AbortController().signal,
          open,
        });
  }

  private cachePolicy(profile: ProfileConfig): NonNullable<ModelProfileSnapshot['cachePolicy']> {
    if (profile.cacheRetention) return { retention: profile.cacheRetention, source: 'profile' };
    const endpoint = this.options.endpoints?.get(profile.provider)?.spec.cacheRetention;
    if (endpoint) return { retention: endpoint, source: 'endpoint' };
    const environment = process.env.PI_CACHE_RETENTION;
    if (environment === 'none' || environment === 'short' || environment === 'long')
      return { retention: environment, source: 'environment' };
    return { retention: 'short', source: 'product' };
  }

  private readonly models: MutableModels;
  private profiles: readonly ProfileConfig[];
  private options: RegistryOptions;

  constructor(models: MutableModels, profiles: readonly ProfileConfig[], options: RegistryOptions) {
    this.models = models;
    this.profiles = profiles;
    this.options = options;
  }

  private now() {
    return this.options.now?.() ?? Date.now();
  }

  /** pi-ai's own providers; endpoints, including ones no longer configured, are not among them. */
  private builtinProviders(): string[] {
    const registered = registeredEndpointIds(this.models);
    return this.models
      .getProviders()
      .map((provider) => provider.id)
      .filter((id) => !registered.has(id) && !this.options.endpoints?.has(id));
  }

  /** Providers whose status is kept: those the profiles name, the endpoints and Pi's own. */
  private statusProviders(): string[] {
    return [
      ...new Set([
        ...this.profiles.map((p) => p.provider),
        ...(this.options.endpoints?.keys() ?? []),
        ...this.builtinProviders(),
      ]),
    ];
  }

  /** A provider that can be signed in to here: one of Pi's or a configured endpoint. */
  private knownProvider(providerId: string): boolean {
    return Boolean(this.options.endpoints?.has(providerId)) || this.isBuiltin(providerId);
  }

  /**
   * Re-reads sign-in status and what each connection can call; the resolver answers from this
   * (run start is synchronous). Reads credentials and environment only: an OAuth token is
   * never refreshed here. One provider after its own request; all otherwise.
   */
  async refreshStatus(providerId?: string): Promise<void> {
    await Promise.all(
      (providerId ? [providerId] : this.statusProviders()).map((id) => this.checkStatus(id)),
    );
  }

  private async checkStatus(providerId: string) {
    const check = (this.statusChecks.get(providerId) ?? 0) + 1;
    this.statusChecks.set(providerId, check);
    const auth = await this.models.checkAuth(providerId).catch(() => undefined);
    const stored = await this.options.credentials.read(providerId).catch(() => undefined);
    const endpoint = this.options.endpoints?.get(providerId);
    const method: AuthMethod | null =
      endpoint?.spec.keyless && auth ? 'none' : (auth?.type ?? null);
    let models: readonly Model<Api>[] = [];
    if (method) {
      const available = await this.models.getAvailable(providerId).catch(() => []);
      // A subscription token reaches fewer models than an API key; list only those it can call.
      const allowed = method === 'oauth' ? this.options.subscriptionModels?.(providerId) : null;
      models = allowed ? available.filter((model) => allowed.has(model.id)) : available;
    }
    if (this.statusChecks.get(providerId) !== check) return;
    this.status.set(providerId, {
      method,
      expires: stored?.type === 'oauth' ? stored.expires : null,
      stored: stored !== undefined,
      endpointChanged: Boolean(
        endpoint && stored?.type === 'api_key' && stored.env?.[ENDPOINT_ORIGIN] !== endpoint.origin,
      ),
      models,
    });
  }

  /**
   * A borrowed Codex CLI login while Corral has its own OpenAI sign-in: it still serves a profile
   * that names it, but it is not a connection and lists no models, so the same models are not
   * offered twice (features/model-connections.md, 연결).
   */
  private shadowedLogin(providerId: string): boolean {
    if (providerId === OPENAI) return false;
    const layered = sourceAware(this.options.credentials);
    if (layered?.sourceOf(providerId) !== 'codex-cli') return false;
    const openai = this.status.get(OPENAI);
    return Boolean(openai?.method && openai.stored && layered.sourceOf(OPENAI) === 'corral');
  }

  /** Signed in and counted as a connection: its models are listed without a profile. */
  private isConnection(providerId: string): boolean {
    return Boolean(this.status.get(providerId)?.method) && !this.shadowedLogin(providerId);
  }

  /** The models of every known provider by connection profile id, built when first needed. */
  private connectionIndex() {
    if (this.connectionIds) return this.connectionIds;
    const index = new Map<string, { provider: string; model: string }>();
    for (const provider of [...(this.options.endpoints?.keys() ?? []), ...this.builtinProviders()])
      for (const model of this.models.getModels(provider)) {
        const id = connectionProfileId(provider, model.id);
        if (!index.has(id)) index.set(id, { provider, model: model.id });
      }
    this.connectionIds = index;
    return index;
  }

  /** The provider and model lists changed: ids are indexed again on next use. */
  private catalogChanged() {
    this.connectionIds = null;
  }

  /** A named profile, else a model of a connection; an id never stops resolving when signed out. */
  private profileFor(
    profile: string,
  ):
    | { ok: true; config: ProfileConfig; connection: boolean }
    | Extract<ModelResolution, { ok: false }> {
    const named = this.profiles.find((p) => p.id === profile);
    if (named) return { ok: true, config: named, connection: false };
    const listed = this.connectionIndex().get(profile);
    if (listed)
      return {
        ok: true,
        config: { id: profile, provider: listed.provider, model: listed.model },
        connection: true,
      };
    // A provider whose list is not known now (a dynamic list, an endpoint not fetched yet).
    const owner = [...(this.options.endpoints?.keys() ?? []), ...this.builtinProviders()]
      .filter((provider) => profile.startsWith(`${provider}:`))
      .sort((a, b) => b.length - a.length)[0];
    if (owner && !this.status.get(owner)?.method)
      return { ok: false, code: 'CAPABILITY_DENIED', reason: SIGN_IN(this.providerName(owner)) };
    // A list Pi fetches is empty until its refresh finishes (at server start, or offline).
    if (owner && this.models.getProvider(owner)?.refreshModels && !this.dynamicLoaded.has(owner))
      return {
        ok: false,
        code: 'CAPABILITY_DENIED',
        reason: `the ${this.providerName(owner)} model list is not loaded yet; try again in a moment`,
      };
    return { ok: false, code: 'GRAPH_INVALID', reason: 'no such model profile' };
  }

  resolve(profile: string, mode: 'mock' | 'live'): ModelResolution {
    if (mode === 'mock') {
      return { ok: true, snapshot: { profile, provider: null, modelId: null, auth: 'mock' } };
    }
    const found = this.profileFor(profile);
    if (!found.ok) return found;
    const config = found.config;
    if (config.workerIsolation && process.platform !== 'linux')
      return {
        ok: false,
        code: 'CAPABILITY_DENIED',
        reason: 'Linux worker isolation is unavailable on this OS',
      };
    if (!this.models.getModel(config.provider, config.model)) {
      return {
        ok: false,
        code: 'GRAPH_INVALID',
        reason: `${config.provider} has no model ${config.model}`,
      };
    }
    const method = this.status.get(config.provider)?.method ?? null;
    if (!method) {
      return {
        ok: false,
        code: 'CAPABILITY_DENIED',
        reason: SIGN_IN(this.providerName(config.provider)),
      };
    }
    if (found.connection && this.shadowedLogin(config.provider)) {
      return {
        ok: false,
        code: 'CAPABILITY_DENIED',
        reason:
          'the Codex CLI login is not used while Corral has its own OpenAI sign-in; choose the OpenAI model',
      };
    }
    // A subscription token reaches fewer models than an API key; say so before the run.
    const allowed = method === 'oauth' ? this.options.subscriptionModels?.(config.provider) : null;
    if (
      found.connection &&
      !this.status.get(config.provider)?.models.some((model) => model.id === config.model)
    ) {
      return {
        ok: false,
        code: 'CAPABILITY_DENIED',
        reason: `${config.model} is not available with ${allowed ? 'a subscription sign-in' : `the current ${this.providerName(config.provider)} sign-in`}`,
      };
    }
    if (allowed && !allowed.has(config.model)) {
      return {
        ok: false,
        code: 'CAPABILITY_DENIED',
        reason: `${config.model} is not available with a subscription sign-in; set the profile in .corral/config.json to one of ${[...allowed].join(', ')}`,
      };
    }
    const context = this.contextPolicy(config);
    if (context.errors.length)
      return { ok: false, code: 'CAPABILITY_DENIED', reason: context.errors.join('; ') };
    const endpointHash = this.pin(config.provider, config.model);
    return {
      ok: true,
      snapshot: {
        profile,
        provider: config.provider,
        modelId: config.model,
        contextWindow:
          context.policy?.contextWindow ??
          this.models.getModel(config.provider, config.model)!.contextWindow,
        ...(context.policy ? { contextPolicy: context.policy } : {}),
        cachePolicy: this.cachePolicy(config),
        maxOutputTokens: this.models.getModel(config.provider, config.model)!.maxTokens,
        imageInput: this.models.getModel(config.provider, config.model)!.input.includes('image'),
        ...(endpointHash ? { endpointHash } : {}),
        ...(config.workerIsolation ? { workerIsolation: config.workerIsolation } : {}),
        reasoning: reasoningCapabilities(this.models.getModel(config.provider, config.model)),
        // The run record knows oauth and api_key; a keyless endpoint is recorded as api_key.
        auth: method === 'none' ? 'api_key' : method,
      },
    };
  }

  /** The access token for one request; pi-ai refreshes an expired OAuth token first. */
  modelBroker(snapshot: ModelProfileSnapshot, owner?: AgentStartInput): ModelBroker {
    const model = this.snapshotModel(snapshot);
    if (!model) throw new Error('the pinned sandbox model is unavailable');
    const meter = new ContextMeter();
    return {
      model: snapshot.contextPolicy
        ? { ...model, contextWindow: snapshot.contextPolicy.contextWindow }
        : model,
      streamFn: (selected, context, options) =>
        this.models.streamSimple(selected, context, options),
      withPermit: (permit) => (selected, context, options) =>
        this.managedStream(
          selected,
          context,
          options,
          {
            requestId: permit.logicalRequestId
              ? `${owner?.executionId ?? 'worker'}:${permit.logicalRequestId}`
              : permit.modelCallId,
            retryIndex: permit.retryIndex ?? 0,
            purpose: permit.purpose ?? 'turn',
            revision: owner?.attemptNo ?? 0,
            owner: owner
              ? {
                  kind: 'execution',
                  id: owner.executionId,
                  runId: owner.runId,
                  executionId: owner.executionId,
                  modelCallId: permit.modelCallId,
                  ...(owner.sessionId ? { sessionId: owner.sessionId } : {}),
                }
              : { kind: 'execution', id: permit.modelCallId, modelCallId: permit.modelCallId },
          },
          true,
          snapshot,
          meter,
        ),
    };
  }

  async credentials(model: ModelProfileSnapshot): Promise<string | null> {
    const resolved = this.snapshotModel(model);
    if (!model.provider || !model.modelId) return null;
    // A keyless endpoint gets no key from this computer.
    if (this.options.endpoints?.get(model.provider)?.spec.keyless) return null;
    if (!resolved) throw new Error(`${model.provider} has no model ${model.modelId}`);
    let auth: Awaited<ReturnType<Models['getAuth']>>;
    try {
      auth = await this.models.getAuth(resolved);
    } catch {
      // The provider's message can include request details; keep ours.
      if (sourceAware(this.options.credentials)?.sourceOf(model.provider) === 'codex-cli') {
        // Corral never refreshes a borrowed login; Codex does that itself.
        throw new Error(
          'the Codex CLI login has expired; run codex to sign in again, or sign in to Corral under Settings → Models',
        );
      }
      throw new Error(`sign-in to ${this.providerName(model.provider)} failed; sign in again`);
    } finally {
      void this.refreshStatus(model.provider);
    }
    return auth?.auth.apiKey ?? null;
  }

  /**
   * A team plan for a goal from one request to the first profile's model. Outside any
   * Run: the person asked for it, and it is capped in output tokens and time.
   */
  async draftTeam(
    goal: string,
    operation?: { id: string; signal?: AbortSignal },
  ): Promise<
    | { ok: true; plan: TeamPlan; model: { provider: string; modelId: string } }
    | {
        ok: false;
        code: 'CAPABILITY_DENIED' | 'MODEL_UNAVAILABLE' | 'REQUEST_OUTCOME_UNKNOWN';
        message: string;
      }
  > {
    const profile = this.profiles[0];
    const resolution = profile ? this.resolve(profile.id, 'live') : null;
    if (!resolution?.ok || !resolution.snapshot.provider || !resolution.snapshot.modelId) {
      return {
        ok: false,
        code: 'CAPABILITY_DENIED',
        message: resolution && !resolution.ok ? resolution.reason : 'no model profile',
      };
    }
    const { provider, modelId } = resolution.snapshot;
    const model = this.models.getModel(provider, modelId);
    if (!model) return { ok: false, code: 'CAPABILITY_DENIED', message: 'no such model' };
    const unavailable = (message: string, uncertain = false) =>
      ({
        ok: false,
        code: uncertain ? 'REQUEST_OUTCOME_UNKNOWN' : 'MODEL_UNAVAILABLE',
        message,
      }) as const;
    let text: string;
    const operationId = operation?.id ?? randomUUID();
    try {
      const answer = await this.managedStream(
        resolution.snapshot.contextPolicy
          ? { ...model, contextWindow: resolution.snapshot.contextPolicy.contextWindow }
          : model,
        {
          systemPrompt: DRAFT_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: goal, timestamp: Date.now() }],
        },
        {
          maxTokens: DRAFT_MAX_OUTPUT_TOKENS,
          cacheRetention: resolution.snapshot.cachePolicy?.retention,
          signal: operation?.signal
            ? AbortSignal.any([operation.signal, AbortSignal.timeout(DRAFT_TIMEOUT_MS)])
            : AbortSignal.timeout(DRAFT_TIMEOUT_MS),
        },
        {
          requestId: operationId,
          owner: { kind: 'draft', id: operationId },
          purpose: 'draft',
          revision: 0,
        },
        false,
        resolution.snapshot,
      ).result();
      if (answer.stopReason === 'error' || answer.stopReason === 'aborted') {
        const uncertain =
          answer.stopReason === 'aborted' ||
          providerFailure(answer.errorMessage ?? '').code === 'UNKNOWN';
        return unavailable(
          uncertain
            ? 'The model request outcome is unconfirmed. This operation will not be sent again.'
            : 'The model request failed; generate a new draft or use the local suggestion.',
          uncertain,
        );
      }
      text = answer.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
    } catch {
      return unavailable(
        'The model request outcome is unconfirmed. This operation will not be sent again.',
        true,
      );
    } finally {
      void this.refreshStatus(provider);
    }
    const plan = planFromAnswer(text);
    return plan
      ? { ok: true, plan, model: { provider, modelId } }
      : unavailable("the model's answer was not a usable team plan; use the local suggestion");
  }

  /**
   * minimum chooser reasoning, model/context output allowance, and bounded JSON text.
   * The shared runtime records physical attempts; the caller records only the parsed choice.
   */
  async routeAuto(
    brief: string,
    choice: AutoModelChoice,
    signal?: AbortSignal,
    levels?: readonly AutoRouteLevel[],
    pinned?: ModelProfileSnapshot,
    operation?: { requestId: string; sessionId?: string },
  ): Promise<RouteAnswer> {
    const resolution = pinned
      ? { ok: true as const, snapshot: pinned }
      : this.resolve(choice.modelProfile, 'live');
    const requestId = operation?.requestId ?? randomUUID();
    if (!resolution.ok || !resolution.snapshot.provider || !resolution.snapshot.modelId)
      return { ok: false, reason: 'model_error' };
    let selected: Model<Api> | undefined;
    try {
      selected = this.snapshotModel(resolution.snapshot);
    } catch {
      return { ok: false, reason: 'model_error' };
    }
    const model =
      selected && resolution.snapshot.contextPolicy
        ? { ...selected, contextWindow: resolution.snapshot.contextPolicy.contextWindow }
        : selected;
    if (!model) return { ok: false, reason: 'model_error' };
    const lowest = reasoningCapabilities(model).levels[0];
    const requested = lowest
      ? ({ mode: 'fixed', level: lowest } as const)
      : ({ mode: 'provider_default' } as const);
    const stop = new AbortController();
    const requestSignal = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
    let timedOut = false;
    let limited = false;
    let latest: AssistantMessage | undefined;
    const usage = () => {
      if (this.requests) return this.requests.chooserUsage(requestId);
      const u = latest?.usage;
      return u &&
        (u.input + u.output + u.cacheRead + u.cacheWrite > 0 ||
          u.totalTokens > 0 ||
          ('corralReported' in u && u.corralReported === true))
        ? { inputTokens: u.input + u.cacheRead + u.cacheWrite, outputTokens: u.output }
        : null;
    };
    const failed = (): RouteAnswer => ({
      ok: false,
      reason: limited ? 'output_limit' : timedOut ? 'timeout' : 'model_error',
      usage: usage(),
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startResponseTimeout = () => {
      const current = setTimeout(() => {
        timedOut = true;
        stop.abort();
      }, AUTO_ROUTE_TIMEOUT_MS);
      timer = current;
      return () => clearTimeout(current);
    };
    let off = () => {};
    try {
      if (requestSignal.aborted) return failed();
      const request = reasoningRequest(
        model,
        {
          maxTokens: model.maxTokens,
          cacheRetention: resolution.snapshot.cachePolicy?.retention,
          signal: requestSignal,
        },
        fixedReasoning(requested, 'auto_route'),
      );
      const aborted = new Promise<RouteAnswer>((resolve) => {
        const abort = () => resolve(failed());
        requestSignal.addEventListener('abort', abort, { once: true });
        off = () => requestSignal.removeEventListener('abort', abort);
      });
      const stream = this.managedStream(
        request.model,
        {
          systemPrompt: autoRouterPrompt(levels),
          messages: [{ role: 'user', content: brief, timestamp: Date.now() }],
        },
        request.options,
        {
          requestId,
          owner: {
            kind: 'chooser',
            id: requestId,
            ...(operation?.sessionId ? { sessionId: operation.sessionId } : {}),
          },
          purpose: 'chooser',
          revision: 0,
        },
        false,
        resolution.snapshot,
        undefined,
        startResponseTimeout,
      );
      const consume = async (): Promise<RouteAnswer> => {
        let bytes = 0;
        for await (const event of stream) {
          latest =
            event.type === 'done'
              ? event.message
              : event.type === 'error'
                ? event.error
                : event.partial;
          if (requestSignal.aborted) return failed();
          if (event.type === 'text_delta') bytes += Buffer.byteLength(event.delta);
          if (bytes > AUTO_ROUTE_MAX_RESPONSE_BYTES) {
            limited = true;
            stop.abort();
            return failed();
          }
        }
        if (requestSignal.aborted) return failed();
        latest = await stream.result();
        const responseBytes = latest.content.reduce(
          (total, part) => total + Buffer.byteLength(part.type === 'text' ? part.text : ''),
          0,
        );
        if (responseBytes > AUTO_ROUTE_MAX_RESPONSE_BYTES) {
          limited = true;
          stop.abort();
          return failed();
        }
        if (latest.stopReason === 'aborted' || latest.stopReason === 'error') return failed();
        const text = latest.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
        return { ok: true, text, usage: usage() };
      };
      // Finish promptly even when a dispatched provider ignores cancellation.
      return await Promise.race([consume(), aborted]);
    } catch {
      return failed();
    } finally {
      clearTimeout(timer);
      off();
      void this.refreshStatus(resolution.snapshot.provider);
    }
  }

  /** The profiles in use (what `.corral/config.json` names, or the defaults). */
  profileConfigs(): readonly ProfileConfig[] {
    return this.profiles;
  }

  /**
   * Profiles and endpoints saved from the Models page. Runs already started keep the
   * profile snapshot they started with.
   */
  async reconfigure(
    profiles: readonly ProfileConfig[],
    endpoints: ReadonlyMap<string, Endpoint>,
    configRevision = this.options.configRevision,
  ) {
    const before = this.options.endpoints ?? new Map<string, Endpoint>();
    this.connectionEpoch++;
    this.connectionTests.clear();
    this.profiles = profiles;
    this.options = { ...this.options, endpoints, ...(configRevision ? { configRevision } : {}) };
    this.catalogChanged();
    // A pinned definition whose written part changed refuses its requests from now on.
    for (const [key, entry] of this.pinned) {
      const current = endpoints.get(entry.provider);
      if (!current || writtenPart(current, entry.modelId) !== entry.written)
        this.pinned.delete(key);
    }
    // A new endpoint, a new address or access, or an address with no list yet fetches its list.
    // A fetch in flight for an unchanged address and access goes on; its result is kept.
    const changed = [...endpoints.values()]
      .filter((endpoint) => !sameAccess(before.get(endpoint.providerId), endpoint))
      .map((endpoint) => endpoint.providerId);
    const unlisted = [...endpoints.values()]
      .filter((endpoint) => !endpoint.fetchedAt)
      .map((endpoint) => endpoint.providerId);
    for (const id of [...this.lastFetch.keys()])
      if (changed.includes(id) || !endpoints.has(id)) this.lastFetch.delete(id);
    for (const [id, running] of this.fetches) if (!endpoints.has(id)) running.abort.abort();
    await this.refreshStatus();
    for (const id of new Set([...changed, ...unlisted])) this.fetchInBackground(id);
  }

  /** Endpoints of a configuration with the lists fetched for them (the cache), not yet in use. */
  endpointsFor(configs: Parameters<typeof endpointsFrom>[0]): Map<string, Endpoint> {
    return endpointsFrom(configs, this.options.endpointModels?.cache);
  }

  contextPolicy(
    profile: ProfileConfig,
    endpoints = this.options.endpoints,
    configRevision = this.options.configRevision ?? 'none',
  ) {
    const endpoint = endpoints?.get(profile.provider);
    const configured = endpoint?.contextWindows?.get(profile.model);
    const model = endpoint
      ? endpoint.spec.models.find((model) => model.id === profile.model)
      : this.models.getModel(profile.provider, profile.model);
    // The endpoint's own figure (written or listed), models.dev's, or a default.
    const listed = endpoint?.sources?.get(profile.model)?.contextWindow;
    return resolveProfileContext(
      profile,
      {
        contextWindow: configured ?? model?.contextWindow ?? null,
        source: endpoint
          ? configured !== undefined || listed === 'response'
            ? 'endpoint'
            : listed === 'catalog'
              ? 'catalog'
              : 'fallback'
          : 'catalog',
      },
      configRevision,
      model ? ('maxTokens' in model ? model.maxTokens : model.maxOutput) : FALLBACK_OUTPUT_TOKENS,
    );
  }

  contextPolicies(
    profiles = this.profiles,
    endpoints = this.options.endpoints,
    revision = this.options.configRevision ?? 'none',
  ) {
    return Object.fromEntries(
      profiles.map((profile) => [profile.id, this.contextPolicy(profile, endpoints, revision)]),
    );
  }

  /** Profiles that name a provider neither pi-ai nor the given endpoints know. */
  unknownProviders(profiles: readonly ProfileConfig[], endpoints: ReadonlyMap<string, Endpoint>) {
    return profiles
      .map((p, index) => ({ p, index }))
      .filter(({ p }) => !endpoints.has(p.provider) && !this.isBuiltin(p.provider))
      .map(({ p, index }) => `modelProfiles.${index}.provider: no provider "${p.provider}"`);
  }

  private isBuiltin(providerId: string): boolean {
    return (
      Boolean(this.models.getProvider(providerId)) &&
      !this.options.endpoints?.has(providerId) &&
      !registeredEndpointIds(this.models).has(providerId)
    );
  }

  /**
   * Providers and their models for the profile editor and the connection list; no credentials
   * or status. Endpoint models carry each limit and ability with its source.
   */
  catalog(): CatalogProvider[] {
    const removed = registeredEndpointIds(this.models);
    return this.models
      .getProviders()
      .filter((provider) => this.options.endpoints?.has(provider.id) || !removed.has(provider.id))
      .map((provider) => {
        const endpoint = this.options.endpoints?.get(provider.id);
        return {
          providerId: provider.id,
          name: provider.name,
          endpoint: Boolean(endpoint),
          // A provider with a list it fetches may have none before it is connected.
          dynamic: Boolean(provider.refreshModels),
          methods: this.methods(provider.id),
          models: provider.getModels().map((m) => {
            const limits = endpoint ? limitsOf(endpoint, m.id) : null;
            return {
              id: m.id,
              name: m.name,
              // pi-ai's list prices (USD per million tokens), for estimates only.
              cost: {
                input: m.cost.input,
                output: m.cost.output,
                cacheRead: m.cost.cacheRead,
                cacheWrite: m.cost.cacheWrite,
              },
              ...(limits ? { limits } : {}),
            };
          }),
        };
      })
      .filter((p) => p.models.length > 0 || p.endpoint || p.dynamic)
      .map(({ dynamic: _, ...provider }) => provider)
      .sort((a, b) => Number(b.endpoint) - Number(a.endpoint) || a.name.localeCompare(b.name));
  }

  /**
   * The non-secret definition of the endpoint model behind a snapshot, for its worker: the
   * address, auth, cache and session settings and that one model, as pinned when it was resolved.
   */
  endpointOf(model: ModelProfileSnapshot): EndpointSpec | null {
    return this.endpointSpecOf(model);
  }

  /**
   * Pins one endpoint model's effective definition for the Runs resolved with it; its hash goes
   * into their snapshot. Null for a provider that is not an endpoint.
   */
  private pin(provider: string, modelId: string): string | null {
    const endpoint = this.options.endpoints?.get(provider);
    const spec = endpoint ? endpointModelSpec(endpoint.spec, modelId) : null;
    if (!endpoint || !spec) return null;
    const hash = endpointHash(spec);
    this.pinned.set(`${provider}\u0000${hash}`, {
      provider,
      modelId,
      spec,
      written: writtenPart(endpoint, modelId),
    });
    return hash;
  }

  /**
   * The endpoint definition a snapshot runs with: the one pinned when it was resolved, while what
   * a person wrote for it (address, access, cache and session settings, that model's values) is
   * unchanged. A snapshot pinned before this process started is served only by an identical
   * current definition. Anything else refuses the prepared request.
   */
  private endpointSpecOf(model: ModelProfileSnapshot): EndpointSpec | null {
    if (!model.endpointHash) return null;
    const endpoint = model.provider ? this.options.endpoints?.get(model.provider) : undefined;
    if (endpoint && model.modelId) {
      const pinned = this.pinned.get(`${endpoint.providerId}\u0000${model.endpointHash}`);
      if (pinned?.written === writtenPart(endpoint, model.modelId)) return pinned.spec;
      const own = endpointModelSpec(endpoint.spec, model.modelId);
      if (own && endpointHash(own) === model.endpointHash) return own;
    }
    throw new Error('The endpoint configuration changed after this request was prepared.');
  }

  /** The model a snapshot runs on: an endpoint's pinned definition, else Pi's own model. */
  private snapshotModel(snapshot: ModelProfileSnapshot): Model<Api> | undefined {
    const spec = this.endpointSpecOf(snapshot);
    if (!snapshot.provider || !snapshot.modelId) return undefined;
    return spec
      ? endpointProvider(snapshot.provider, spec).getModels()[0]
      : this.models.getModel(snapshot.provider, snapshot.modelId);
  }

  private methods(providerId: string): { oauth: boolean; apiKey: boolean } {
    const auth = this.models.getProvider(providerId)?.auth;
    return {
      oauth: Boolean(auth?.oauth),
      apiKey: Boolean(auth?.apiKey) && !this.options.endpoints?.get(providerId)?.spec.keyless,
    };
  }

  /**
   * Stores an API key entered under Settings → Models; it is never returned. An endpoint then
   * fetches its model list; a provider with a dynamic list refreshes it.
   */
  async setApiKey(providerId: string, key: string): Promise<void> {
    if (!this.knownProvider(providerId)) {
      throw new RegistryError('not_found', 'no such model provider');
    }
    if (!this.methods(providerId).apiKey) {
      throw new RegistryError('unsupported', 'this provider does not take an API key');
    }
    const endpoint = this.options.endpoints?.get(providerId);
    // A key Pi cannot sign in with on its own (an account ID is missing) is not stored: the page
    // could neither show it as a connection nor remove it.
    if (!endpoint && !(await this.models.getAuth(providerId, { apiKey: key }).catch(() => null))) {
      const needs = KEY_NEEDS[providerId];
      throw new RegistryError(
        'unsupported',
        needs
          ? `${this.providerName(providerId)} needs ${needs.what} besides the API key; set ${needs.env} in the server environment. The key was not saved.`
          : `${this.providerName(providerId)} needs more than an API key here. The key was not saved.`,
      );
    }
    this.connectionEpoch++;
    this.credentialChanged(providerId);
    this.connectionTests.delete(providerId);
    this.cancelLogin(providerId);
    await this.options.credentials.modify(providerId, async () => ({
      type: 'api_key',
      key,
      // An endpoint key is bound to the address it was entered for.
      ...(endpoint ? { env: { [ENDPOINT_ORIGIN]: endpoint.origin } } : {}),
    }));
    this.connectionEpoch++;
    this.credentialChanged(providerId);
    this.connectionTests.delete(providerId);
    await this.refreshStatus(providerId);
    if (endpoint) this.fetchInBackground(providerId);
    else this.connected(providerId);
  }

  /** Test only the saved endpoint metadata route, never a caller-supplied URL or inference. */
  async testEndpoint(providerId: string) {
    const endpoint = this.options.endpoints?.get(providerId);
    if (!endpoint)
      throw new RegistryError('unsupported', 'connection tests require a configured endpoint');
    const epoch = this.connectionEpoch;
    const credential = await this.options.credentials.read(providerId);
    const current = () =>
      epoch === this.connectionEpoch &&
      sameEndpoint(this.options.endpoints?.get(providerId), endpoint);
    if (!current())
      throw new RegistryError('unsupported', 'settings changed; test the connection again');
    const apiKey =
      !endpoint.spec.keyless &&
      credential?.type === 'api_key' &&
      credential.env?.[ENDPOINT_ORIGIN] === endpoint.origin
        ? credential.key
        : undefined;
    const result =
      !endpoint.spec.keyless && !apiKey
        ? { kind: 'authentication' as const, status: null }
        : await probeEndpoint({ baseUrl: endpoint.spec.baseUrl, ...(apiKey ? { apiKey } : {}) });
    if (!current())
      throw new RegistryError('unsupported', 'settings changed; test the connection again');
    const view = {
      ...result,
      checkedAt: new Date(this.options.now?.() ?? Date.now()).toISOString(),
    };
    this.connectionTests.set(providerId, view);
    return view;
  }

  private providerName(providerId: string): string {
    return this.models.getProvider(providerId)?.name ?? providerId;
  }

  private subscription(providerId: string): boolean {
    return Boolean(this.models.getProvider(providerId)?.auth.oauth?.isSubscription);
  }

  /**
   * Connected providers, and those the profiles or endpoints name even when signed out. A
   * provider never connected and never named is offered by the catalog instead.
   */
  authView(): ProviderAuthView[] {
    const now = this.options.now?.() ?? Date.now();
    const layered = sourceAware(this.options.credentials);
    const named = new Set([
      ...this.profiles.map((profile) => profile.provider),
      ...(this.options.endpoints?.keys() ?? []),
    ]);
    const shown = this.statusProviders().filter(
      (providerId) =>
        named.has(providerId) || this.isConnection(providerId) || this.logins.has(providerId),
    );
    return shown.map((providerId) => {
      const status = this.status.get(providerId);
      const login = this.logins.get(providerId);
      const endpoint = this.options.endpoints?.get(providerId);
      return {
        providerId,
        name: this.providerName(providerId),
        signedIn: Boolean(status?.method),
        method: status?.method ?? null,
        methods: this.methods(providerId),
        endpoint: this.options.endpoints?.get(providerId)?.host ?? null,
        endpointChanged: status?.endpointChanged ?? false,
        connectionTest: this.connectionTests.get(providerId) ?? null,
        subscription: status?.method === 'oauth' && this.subscription(providerId),
        expiresAt: status?.expires ? new Date(Math.max(status.expires, now)).toISOString() : null,
        login: login ? { ...login.view } : null,
        source: sourceOf(status, () => layered?.sourceOf(providerId) ?? 'corral'),
        permissionsOk:
          layered?.sourceOf(providerId) !== 'codex-cli' || layered.codexPermissionsOk(),
        modelCount: status && this.isConnection(providerId) ? status.models.length : 0,
        modelFetch: endpoint
          ? (this.lastFetch.get(providerId) ??
            (endpoint.fetchedAt
              ? { kind: 'connected' as const, status: null, fetchedAt: endpoint.fetchedAt }
              : null))
          : null,
      };
    });
  }

  /**
   * Named profiles first, then the models of every connected provider that no named profile
   * already points at. Capabilities are worked out only for those connected models.
   */
  profilesView(): ModelProfileView[] {
    const named = this.profiles.map((profile) => ({
      ...this.profileView(profile),
      source: 'profile' as const,
    }));
    const taken = new Set(this.profiles.map((profile) => profile.id));
    const pointed = new Set(this.profiles.map((p) => `${p.provider}\u0000${p.model}`));
    // The resolver's index decides which provider and model an id means when two pairs share it.
    const index = this.connectionIndex();
    const connection: ModelProfileView[] = [];
    for (const provider of this.statusProviders()) {
      const status = this.status.get(provider);
      if (!status || !this.isConnection(provider) || !this.knownProvider(provider)) continue;
      for (const model of status.models) {
        if (pointed.has(`${provider}\u0000${model.id}`)) continue;
        const id = connectionProfileId(provider, model.id);
        const owner = index.get(id);
        if (taken.has(id) || owner?.provider !== provider || owner.model !== model.id) continue;
        taken.add(id);
        connection.push({
          ...this.profileView({ id, provider, model: model.id }),
          source: 'connection',
        });
      }
    }
    return [...named, ...connection];
  }

  private profileView(profile: ProfileConfig): Omit<ModelProfileView, 'source'> {
    const model = this.models.getModel(profile.provider, profile.model);
    const method = this.status.get(profile.provider)?.method ?? null;
    const context = this.contextPolicy(profile);
    return {
      profileId: profile.id,
      provider: profile.provider,
      providerName: this.providerName(profile.provider),
      modelId: profile.model,
      modelName: model?.name ?? null,
      available: Boolean(model),
      reasoning: model?.reasoning ?? null,
      imageInput: model ? model.input.includes('image') : null,
      reasoningCapabilities: reasoningCapabilities(model),
      contextWindow: context.policy?.contextWindow ?? model?.contextWindow ?? null,
      ...(context.policy ? { contextPolicy: context.policy } : {}),
      maxOutputTokens: model?.maxTokens ?? null,
      method,
      keyConfigured: method !== null,
      subscriptionSupported:
        this.options.subscriptionModels?.(profile.provider)?.has(profile.model) ?? null,
    };
  }

  /**
   * Starts the provider's own sign-in flow (OpenAI: Sign in with ChatGPT). The person opens
   * `authUrl` and finishes in their browser; the flow's callback, or a pasted redirect URL,
   * completes it. Resolves once the sign-in page is known.
   */
  async startLogin(providerId: string): Promise<LoginView> {
    if (!this.knownProvider(providerId)) {
      throw new RegistryError('not_found', 'no such model provider');
    }
    if (!this.methods(providerId).oauth) {
      throw new RegistryError(
        'unsupported',
        `${this.providerName(providerId)} signs in with an API key here`,
      );
    }
    const running = this.logins.get(providerId);
    if (running && running.view.state !== 'failed') return { ...running.view };

    const pending: PendingLogin = {
      view: { state: 'waiting', authUrl: null, userCode: null, error: null },
      abort: new AbortController(),
      manual: null,
    };
    this.logins.set(providerId, pending);
    let announced!: () => void;
    const urlKnown = new Promise<void>((resolve) => {
      announced = resolve;
    });

    void this.models
      .login(
        providerId,
        'oauth',
        {
          signal: pending.abort.signal,
          notify: (event: AuthEvent) => {
            if (event.type === 'auth_url') {
              pending.view.authUrl = event.url;
              announced();
            }
            // A device-code sign-in: the person opens the page and enters the code there.
            if (event.type === 'device_code') {
              pending.view.authUrl = event.verificationUri;
              pending.view.userCode = event.userCode;
              announced();
            }
            if (event.type === 'progress') pending.view.state = 'exchanging';
          },
          prompt: (prompt: AuthPrompt) =>
            new Promise<string>((resolve, reject) => {
              // The provider's own default: the first (browser) way to sign in, and a blank
              // optional field (GitHub Copilot's Enterprise domain means github.com).
              if (prompt.type === 'select' && prompt.options[0]) {
                resolve(prompt.options[0].id);
                return;
              }
              if (prompt.type === 'text') {
                resolve('');
                return;
              }
              if (prompt.type !== 'manual_code') {
                reject(new Error('this sign-in step is not supported here'));
                return;
              }
              pending.manual = resolve;
              prompt.signal?.addEventListener('abort', () => reject(new Error('superseded')));
            }),
        },
        { getDeviceId: () => this.options.getDeviceId(), agentName: 'Corral' },
      )
      .then(async () => {
        this.logins.delete(providerId);
        this.credentialChanged(providerId);
        await this.refreshStatus(providerId);
        this.connected(providerId);
      })
      .catch((error: unknown) => {
        pending.view.state = 'failed';
        pending.view.error = loginError(error);
        announced();
      });

    await Promise.race([urlKnown, new Promise((r) => setTimeout(r, 5000))]);
    return { ...pending.view };
  }

  /** The browser's final redirect URL, when the automatic callback could not be reached. */
  submitRedirect(providerId: string, url: string): boolean {
    const pending = this.logins.get(providerId);
    if (!pending?.manual) return false;
    pending.manual(url);
    pending.manual = null;
    return true;
  }

  cancelLogin(providerId: string) {
    this.logins.get(providerId)?.abort.abort();
    this.logins.delete(providerId);
  }

  async logout(providerId: string) {
    if (!this.knownProvider(providerId)) {
      // A key left for an endpoint the config no longer names can still be removed.
      const stored = await this.options.credentials
        .list()
        .then((list) => list.some((credential) => credential.providerId === providerId))
        .catch(() => false);
      if (!stored) throw new RegistryError('not_found', 'no such model provider');
      this.credentialChanged(providerId);
      await this.models.logout(providerId);
      return;
    }
    this.connectionEpoch++;
    this.credentialChanged(providerId);
    this.connectionTests.delete(providerId);
    this.cancelLogin(providerId);
    this.fetches.get(providerId)?.abort.abort();
    await this.models.logout(providerId);
    this.connectionEpoch++;
    this.credentialChanged(providerId);
    this.connectionTests.delete(providerId);
    await this.refreshStatus(providerId);
  }

  private credentialChanged(providerId: string) {
    this.credentialEpochs.set(providerId, (this.credentialEpochs.get(providerId) ?? 0) + 1);
  }

  private fetchEpoch(providerId: string) {
    return String(this.credentialEpochs.get(providerId) ?? 0);
  }

  private track(work: Promise<unknown>) {
    const tracked: Promise<unknown> = work
      .catch(() => {})
      .finally(() => this.background.delete(tracked));
    this.background.add(tracked);
  }

  /** Settles once every background fetch and refresh started so far has finished. */
  async idle(): Promise<void> {
    while (this.background.size) await Promise.all([...this.background]);
  }

  /** Stops fetches and refreshes in flight; the server is closing. */
  close() {
    this.stopped.abort();
    for (const running of this.fetches.values()) running.abort.abort();
  }

  /**
   * A provider was just connected: one with a dynamic list (Radius) refreshes it through Pi in
   * the background. Pi's static lists need nothing.
   */
  private connected(providerId: string) {
    if (!this.models.getProvider(providerId)?.refreshModels) return;
    this.track(this.refreshDynamic([providerId], true));
  }

  /** At server start: the connected providers with a dynamic list refresh it through Pi. */
  refreshDynamicProviders() {
    const ids = this.builtinProviders().filter(
      (id) => this.status.get(id)?.method && this.models.getProvider(id)?.refreshModels,
    );
    if (ids.length) this.track(this.refreshDynamic(ids, false));
  }

  private async refreshDynamic(providers: string[], force: boolean) {
    if (this.stopped.signal.aborted) return;
    const result = await this.models.refresh({ providers, force, signal: this.stopped.signal });
    for (const id of providers)
      if (!result.aborted && !result.errors.has(id)) this.dynamicLoaded.add(id);
    this.catalogChanged();
    await Promise.all(providers.map((id) => this.refreshStatus(id)));
  }

  /** Throws unless the provider is a configured endpoint: `not_found` when Pi does not know it either. */
  assertEndpoint(providerId: string) {
    if (this.options.endpoints?.has(providerId)) return;
    throw this.isBuiltin(providerId)
      ? new RegistryError('unsupported', 'model lists are fetched for added endpoints only')
      : new RegistryError('not_found', 'no such model provider');
  }

  private fetchInBackground(providerId: string) {
    if (this.stopped.signal.aborted) return;
    this.track(this.refreshEndpointModels(providerId));
  }

  /**
   * Fetches an endpoint's model list from its saved address (features/model-connections.md,
   * 엔드포인트 모델 가져오기). One fetch per endpoint at a time: a caller joins the one in flight.
   * A result that arrives after the endpoint's address or access, or its credential, changed is
   * dropped; other config changes keep it.
   */
  refreshEndpointModels(providerId: string): Promise<EndpointModelsView> {
    const endpoint = this.options.endpoints?.get(providerId);
    if (!endpoint) {
      try {
        this.assertEndpoint(providerId);
      } catch (error) {
        return Promise.reject(error);
      }
      return Promise.reject(new RegistryError('not_found', 'no such model provider'));
    }
    const epoch = this.fetchEpoch(providerId);
    const running = this.fetches.get(providerId);
    if (running && running.epoch === epoch && sameAccess(running.endpoint, endpoint))
      return running.promise;
    running?.abort.abort();
    const abort = new AbortController();
    const entry: ModelFetch = {
      epoch,
      endpoint,
      abort,
      promise: Promise.resolve() as unknown as Promise<EndpointModelsView>,
    };
    entry.promise = this.fetchModels(providerId, endpoint, epoch, abort.signal).finally(() => {
      if (this.fetches.get(providerId) === entry) this.fetches.delete(providerId);
    });
    this.fetches.set(providerId, entry);
    return entry.promise;
  }

  private async fetchModels(
    providerId: string,
    endpoint: Endpoint,
    epoch: string,
    signal: AbortSignal,
  ): Promise<EndpointModelsView> {
    const current = () =>
      !signal.aborted &&
      this.fetchEpoch(providerId) === epoch &&
      sameAccess(this.options.endpoints?.get(providerId), endpoint);
    const late = () =>
      new RegistryError(
        'conflict',
        'settings changed while the models were fetched; refresh again',
      );
    const credential = await this.options.credentials.read(providerId).catch(() => undefined);
    if (!current()) throw late();
    // Only the key entered for this origin; never one entered for another address.
    const apiKey =
      !endpoint.spec.keyless &&
      credential?.type === 'api_key' &&
      credential.env?.[ENDPOINT_ORIGIN] === endpoint.origin
        ? credential.key
        : undefined;
    let result: EndpointFetchResult;
    if (!endpoint.spec.keyless && !apiKey)
      result = { kind: 'authentication', status: null, models: null };
    else {
      const catalog = this.options.endpointModels?.catalog;
      // models.dev holds no user data; a failed refresh keeps the fetch going.
      if (catalog?.view().stale) await catalog.refresh();
      if (!current()) throw late();
      result = await fetchEndpointModels({
        baseUrl: endpoint.spec.baseUrl,
        ...(apiKey ? { apiKey } : {}),
        ...(this.options.endpointModels?.fetch ? { fetch: this.options.endpointModels.fetch } : {}),
        ...(this.options.endpointModels?.timeoutMs
          ? { timeoutMs: this.options.endpointModels.timeoutMs }
          : {}),
        signal,
      });
    }
    if (!current()) throw late();
    const fetchedAt = new Date(this.now()).toISOString();
    // The list joins the endpoint as it is configured now (the same address and access).
    const now = this.options.endpoints?.get(providerId) ?? endpoint;
    if (result.models) this.useFetched(providerId, now, result.models, fetchedAt);
    this.lastFetch.set(providerId, { kind: result.kind, status: result.status, fetchedAt });
    await this.refreshStatus(providerId);
    const status = this.status.get(providerId);
    return {
      kind: result.kind,
      status: result.status,
      fetchedAt,
      modelCount: status?.method ? status.models.length : 0,
    };
  }

  /** Caches a fetched list for its address and puts the endpoint's new definition in use. */
  private useFetched(
    providerId: string,
    endpoint: Endpoint,
    models: NonNullable<EndpointFetchResult['models']>,
    fetchedAt: string,
  ) {
    if (!endpoint.config) return;
    const catalog = this.options.endpointModels?.catalog;
    const entry = {
      fetchedAt,
      models: models.map(({ id, ...response }) => ({
        id,
        response,
        catalog: catalog?.match(id) ?? {},
      })),
    };
    const cache = this.options.endpointModels?.cache;
    try {
      cache?.write(endpoint.spec.baseUrl, entry);
    } catch {
      /* The list is still used until the server stops; the next fetch writes it again. */
    }
    const address = endpointAddress(endpoint.spec.baseUrl);
    const source: EndpointModelSource = {
      read: (baseUrl) =>
        endpointAddress(baseUrl) === address ? entry : (cache?.read(baseUrl) ?? null),
    };
    const rebuilt = endpointsFrom([endpoint.config], source).get(providerId);
    if (!rebuilt) return;
    const endpoints = new Map(this.options.endpoints);
    endpoints.set(providerId, rebuilt);
    this.options = { ...this.options, endpoints };
    registerEndpoints(this.models, new Map([[providerId, rebuilt]]));
    this.catalogChanged();
  }
}

function endpointHash(spec: EndpointSpec | null): string {
  return createHash('sha256').update(canonicalJson(spec)).digest('hex');
}

/**
 * What a person wrote for one endpoint model: the address, access, cache and session settings
 * and the values written for that model. Fetched values and the display name are not part of it.
 */
function writtenPart(endpoint: Endpoint, modelId: string): string {
  const { baseUrl, keyless, cacheRetention, sessionAffinity } = endpoint.spec;
  const entry = endpoint.config
    ? endpoint.config.models?.find((model) => model.id === modelId)
    : endpoint.spec.models.find((model) => model.id === modelId);
  return canonicalJson({
    baseUrl,
    keyless,
    cacheRetention: cacheRetention ?? null,
    sessionAffinity: sessionAffinity ?? null,
    model: entry
      ? Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined))
      : null,
  });
}

/** An endpoint still reached at the same address with the same access. */
function sameAccess(current: Endpoint | undefined, expected: Endpoint) {
  return (
    current !== undefined &&
    current.spec.baseUrl === expected.spec.baseUrl &&
    current.spec.keyless === expected.spec.keyless
  );
}

/** The same configured endpoint, though its definition may have taken a newly fetched list. */
function sameEndpoint(current: Endpoint | undefined, expected: Endpoint) {
  return (
    current !== undefined &&
    (expected.config ? current.config === expected.config : current === expected)
  );
}

function limitsOf(
  endpoint: Endpoint,
  modelId: string,
): CatalogProvider['models'][number]['limits'] {
  const model = endpoint.spec.models.find((candidate) => candidate.id === modelId);
  const sources = endpoint.sources?.get(modelId);
  if (!model || !sources) return undefined;
  const sourced = <T>(value: T, field: ModelValueField) => ({ value, source: sources[field] });
  return {
    contextWindow: sourced(model.contextWindow, 'contextWindow'),
    maxOutput: sourced(model.maxOutput, 'maxOutput'),
    reasoning: sourced(model.reasoning, 'reasoning'),
    imageInput: sourced(model.imageInput ?? false, 'imageInput'),
  };
}

/** Sign-in errors in plain words; never the token endpoint's response body. */
function loginError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (/cancel/i.test(text)) return 'Sign-in was cancelled.';
  if (/port \d+ is in use/i.test(text)) return text.slice(0, 200);
  if (/token request failed/i.test(text)) return 'The provider refused the sign-in. Try again.';
  if (/state mismatch|authorization code|callback/i.test(text)) {
    return 'The sign-in callback did not match. Start again.';
  }
  return 'Sign-in failed. Try again.';
}

/** A credential store that knows where each sign-in came from (the layered store). */
interface SourceAware {
  sourceOf(providerId: string): 'corral' | 'codex-cli' | null;
  codexPermissionsOk(): boolean;
}

function sourceAware(store: unknown): SourceAware | undefined {
  const candidate = store as Partial<SourceAware> | undefined;
  return typeof candidate?.sourceOf === 'function' &&
    typeof candidate.codexPermissionsOk === 'function'
    ? (candidate as SourceAware)
    : undefined;
}

function sourceOf(
  status: { method: AuthMethod | null; stored: boolean } | undefined,
  stored: () => 'corral' | 'codex-cli' | null,
): ProviderAuthView['source'] {
  if (!status?.method || status.method === 'none') return null;
  return status.stored ? (stored() ?? 'corral') : 'environment';
}
