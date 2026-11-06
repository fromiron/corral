import { createHash, randomUUID } from 'node:crypto';
import {
  ContextMeter,
  type EndpointSpec,
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
  fixedReasoning,
  type ModelResolution,
  type ModelResolver,
  type RouteAnswer,
  resolveProfileContext,
  SPEC_HARD_CAPS,
} from '@corral/core';
import { accountModelStream, withSessionAffinityOptions } from '@corral/pi-runtime-port';
import type {
  AssistantMessage,
  AuthEvent,
  AuthPrompt,
  CredentialStore,
  Models,
} from '@earendil-works/pi-ai';
import { probeEndpoint } from './endpoint-probe.ts';
import { ENDPOINT_ORIGIN, type Endpoint } from './endpoints.ts';
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
 * Providers whose subscription OAuth Corral does not start: Anthropic does not allow third-party
 * apps to use subscription credentials. They take an API key instead.
 */
const NO_SUBSCRIPTION_OAUTH = new Set(['anthropic']);

/** How a provider is reached: `none` is a keyless local endpoint. */
export type AuthMethod = 'oauth' | 'api_key' | 'none';

/** A sign-in request the registry cannot serve; `code` picks the HTTP answer. */
export class RegistryError extends Error {
  readonly code: 'not_found' | 'unsupported';
  constructor(code: 'not_found' | 'unsupported', message: string) {
    super(message);
    this.code = code;
  }
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
  }[];
}

export interface LoginView {
  state: 'waiting' | 'exchanging' | 'failed';
  /** The provider's sign-in page; opening it is the person's own step. */
  authUrl: string | null;
  error: string | null;
}

export interface ModelProfileView {
  profileId: string;
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
  maxOutputTokensPerCall?: number;
  credentials: CredentialStore;
  getDeviceId(): string;
  now?: () => number;
  /** Models a subscription sign-in may call, per provider; null when no list is known. */
  subscriptionModels?: (providerId: string) => ReadonlySet<string> | null;
  /** OpenAI-compatible endpoints from the workspace config, already registered. */
  endpoints?: ReadonlyMap<string, Endpoint>;
}

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
    }
  >();
  private readonly logins = new Map<string, PendingLogin>();

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
          if (snapshot) this.assertEndpointSnapshot(snapshot);
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

  private readonly models: Models;
  private profiles: readonly ProfileConfig[];
  private options: RegistryOptions;

  constructor(models: Models, profiles: readonly ProfileConfig[], options: RegistryOptions) {
    this.models = models;
    this.profiles = profiles;
    this.options = options;
  }

  private providers(): string[] {
    return [
      ...new Set([
        ...this.profiles.map((p) => p.provider),
        ...(this.options.endpoints?.keys() ?? []),
      ]),
    ];
  }

  /** Re-reads sign-in status; the resolver answers from this (run start is synchronous). */
  async refreshStatus(): Promise<void> {
    for (const providerId of this.providers()) {
      const check = await this.models.checkAuth(providerId).catch(() => undefined);
      const stored = await this.options.credentials.read(providerId).catch(() => undefined);
      const endpoint = this.options.endpoints?.get(providerId);
      this.status.set(providerId, {
        method: endpoint?.spec.keyless && check ? 'none' : (check?.type ?? null),
        expires: stored?.type === 'oauth' ? stored.expires : null,
        stored: stored !== undefined,
        endpointChanged: Boolean(
          endpoint &&
            stored?.type === 'api_key' &&
            stored.env?.[ENDPOINT_ORIGIN] !== endpoint.origin,
        ),
      });
    }
  }

  resolve(profile: string, mode: 'mock' | 'live'): ModelResolution {
    if (mode === 'mock') {
      return { ok: true, snapshot: { profile, provider: null, modelId: null, auth: 'mock' } };
    }
    const config = this.profiles.find((p) => p.id === profile);
    if (!config) return { ok: false, code: 'GRAPH_INVALID', reason: 'no such model profile' };
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
        reason: `sign in to ${this.providerName(config.provider)} under Settings → Models`,
      };
    }
    // A subscription token reaches fewer models than an API key; say so before the run.
    const allowed = method === 'oauth' ? this.options.subscriptionModels?.(config.provider) : null;
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
        ...(this.options.endpoints?.get(config.provider)
          ? {
              endpointHash: createHash('sha256')
                .update(canonicalJson(this.options.endpoints.get(config.provider)!.spec))
                .digest('hex'),
            }
          : {}),
        ...(config.workerIsolation ? { workerIsolation: config.workerIsolation } : {}),
        reasoning: reasoningCapabilities(this.models.getModel(config.provider, config.model)),
        // The run record knows oauth and api_key; a keyless endpoint is recorded as api_key.
        auth: method === 'none' ? 'api_key' : method,
      },
    };
  }

  /** The access token for one request; pi-ai refreshes an expired OAuth token first. */
  modelBroker(snapshot: ModelProfileSnapshot, owner?: AgentStartInput): ModelBroker {
    this.assertEndpointSnapshot(snapshot);
    const model =
      snapshot.provider && snapshot.modelId
        ? this.models.getModel(snapshot.provider, snapshot.modelId)
        : undefined;
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
    this.assertEndpointSnapshot(model);
    if (!model.provider || !model.modelId) return null;
    // A keyless endpoint gets no key from this computer.
    if (this.options.endpoints?.get(model.provider)?.spec.keyless) return null;
    const resolved = this.models.getModel(model.provider, model.modelId);
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
      void this.refreshStatus();
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
      void this.refreshStatus();
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
    const selected = this.models.getModel(
      resolution.snapshot.provider,
      resolution.snapshot.modelId,
    );
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
      void this.refreshStatus();
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
    this.connectionEpoch++;
    this.connectionTests.clear();
    this.profiles = profiles;
    this.options = { ...this.options, endpoints, ...(configRevision ? { configRevision } : {}) };
    await this.refreshStatus();
  }

  setConfigRevision(configRevision: string) {
    this.connectionEpoch++;
    this.connectionTests.clear();
    this.options = { ...this.options, configRevision };
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
    return resolveProfileContext(
      profile,
      {
        contextWindow: configured ?? model?.contextWindow ?? null,
        source: endpoint ? (configured !== undefined ? 'endpoint' : 'fallback') : 'catalog',
      },
      configRevision,
      model
        ? 'maxTokens' in model
          ? model.maxTokens
          : model.maxOutput
        : (this.options.maxOutputTokensPerCall ?? SPEC_HARD_CAPS.maxOutputTokensPerCall),
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
    return Boolean(this.models.getProvider(providerId)) && !this.options.endpoints?.has(providerId);
  }

  /** Providers and their models for the profile editor; no credentials or status. */
  catalog(): CatalogProvider[] {
    return this.models
      .getProviders()
      .map((provider) => ({
        providerId: provider.id,
        name: provider.name,
        endpoint: this.options.endpoints?.has(provider.id) ?? false,
        methods: this.methods(provider.id),
        models: provider.getModels().map((m) => ({
          id: m.id,
          name: m.name,
          // pi-ai's list prices (USD per million tokens), for estimates only.
          cost: {
            input: m.cost.input,
            output: m.cost.output,
            cacheRead: m.cost.cacheRead,
            cacheWrite: m.cost.cacheWrite,
          },
        })),
      }))
      .filter((p) => p.models.length > 0)
      .sort((a, b) => Number(b.endpoint) - Number(a.endpoint) || a.name.localeCompare(b.name));
  }

  /** The non-secret definition of the endpoint behind a model, for its worker. */
  endpointOf(model: ModelProfileSnapshot): EndpointSpec | null {
    this.assertEndpointSnapshot(model);
    return (model.provider && this.options.endpoints?.get(model.provider)?.spec) || null;
  }

  private assertEndpointSnapshot(model: ModelProfileSnapshot) {
    if (!model.endpointHash) return;
    const endpoint = model.provider && this.options.endpoints?.get(model.provider)?.spec;
    if (
      !endpoint ||
      createHash('sha256').update(canonicalJson(endpoint)).digest('hex') !== model.endpointHash
    )
      throw new Error('The endpoint configuration changed after this request was prepared.');
  }

  private methods(providerId: string): { oauth: boolean; apiKey: boolean } {
    const auth = this.models.getProvider(providerId)?.auth;
    return {
      oauth: Boolean(auth?.oauth) && !NO_SUBSCRIPTION_OAUTH.has(providerId),
      apiKey: Boolean(auth?.apiKey) && !this.options.endpoints?.get(providerId)?.spec.keyless,
    };
  }

  /** Stores an API key entered under Settings → Models; it is never returned. */
  async setApiKey(providerId: string, key: string): Promise<void> {
    if (!this.providers().includes(providerId)) {
      throw new RegistryError('not_found', 'no model profile uses this provider');
    }
    if (!this.methods(providerId).apiKey) {
      throw new RegistryError('unsupported', 'this provider does not take an API key');
    }
    const endpoint = this.options.endpoints?.get(providerId);
    this.connectionEpoch++;
    this.connectionTests.delete(providerId);
    this.cancelLogin(providerId);
    await this.options.credentials.modify(providerId, async () => ({
      type: 'api_key',
      key,
      // An endpoint key is bound to the address it was entered for.
      ...(endpoint ? { env: { [ENDPOINT_ORIGIN]: endpoint.origin } } : {}),
    }));
    this.connectionEpoch++;
    this.connectionTests.delete(providerId);
    await this.refreshStatus();
  }

  /** Test only the saved endpoint metadata route, never a caller-supplied URL or inference. */
  async testEndpoint(providerId: string) {
    const endpoint = this.options.endpoints?.get(providerId);
    if (!endpoint)
      throw new RegistryError('unsupported', 'connection tests require a configured endpoint');
    const epoch = this.connectionEpoch;
    const credential = await this.options.credentials.read(providerId);
    const current = () =>
      epoch === this.connectionEpoch && this.options.endpoints?.get(providerId) === endpoint;
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

  authView(): ProviderAuthView[] {
    const now = this.options.now?.() ?? Date.now();
    const layered = sourceAware(this.options.credentials);
    return this.providers().map((providerId) => {
      const status = this.status.get(providerId);
      const login = this.logins.get(providerId);
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
      };
    });
  }

  profilesView(): ModelProfileView[] {
    return this.profiles.map((profile) => {
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
    });
  }

  /**
   * Starts the provider's own sign-in flow (OpenAI: Sign in with ChatGPT). The person opens
   * `authUrl` and finishes in their browser; the flow's callback, or a pasted redirect URL,
   * completes it. Resolves once the sign-in page is known.
   */
  async startLogin(providerId: string): Promise<LoginView> {
    if (!this.providers().includes(providerId)) {
      throw new RegistryError('not_found', 'no model profile uses this provider');
    }
    if (!this.methods(providerId).oauth) {
      throw new RegistryError(
        'unsupported',
        NO_SUBSCRIPTION_OAUTH.has(providerId)
          ? `${this.providerName(providerId)} subscription sign-in is not supported; enter an API key`
          : `${this.providerName(providerId)} signs in with an API key here`,
      );
    }
    const running = this.logins.get(providerId);
    if (running && running.view.state !== 'failed') return { ...running.view };

    const pending: PendingLogin = {
      view: { state: 'waiting', authUrl: null, error: null },
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
            if (event.type === 'progress') pending.view.state = 'exchanging';
          },
          prompt: (prompt: AuthPrompt) =>
            new Promise<string>((resolve, reject) => {
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
        await this.refreshStatus();
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
    this.connectionEpoch++;
    this.connectionTests.delete(providerId);
    this.cancelLogin(providerId);
    await this.models.logout(providerId);
    this.connectionEpoch++;
    this.connectionTests.delete(providerId);
    await this.refreshStatus();
  }
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
