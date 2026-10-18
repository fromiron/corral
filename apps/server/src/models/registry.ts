import {
  type EndpointSpec,
  modelReasoningCapabilities as reasoningCapabilities,
} from '@corral/adapter-pi';
import type {
  AutoModelChoice,
  AutoRouteLevel,
  ModelProfileSnapshot,
  ReasoningCapabilities,
  TeamPlan,
} from '@corral/contracts';
import {
  AUTO_ROUTE_MAX_OUTPUT_TOKENS,
  AUTO_ROUTE_TIMEOUT_MS,
  autoRouterPrompt,
  type ModelResolution,
  type ModelResolver,
  type RouteAnswer,
} from '@corral/core';
import type { AuthEvent, AuthPrompt, CredentialStore, Models } from '@earendil-works/pi-ai';
import { ENDPOINT_ORIGIN, type Endpoint } from './endpoints.ts';
import {
  DRAFT_MAX_OUTPUT_TOKENS,
  DRAFT_SYSTEM_PROMPT,
  DRAFT_TIMEOUT_MS,
  planFromAnswer,
} from './team-draft.ts';

// Model profiles and sign-in for the local server (C-058, ADR-019). Profiles name a provider
// and model; credentials stay in pi-ai's credential store on this computer. Views and errors
// carry status and expiry only: no token, key or callback URL ever leaves through them.

export interface ProfileConfig {
  id: string;
  provider: string;
  model: string;
}

/**
 * Two OpenAI profiles, used when the workspace config names none (CR-001). Both are in pi-ai's
 * ChatGPT-account catalog: a ChatGPT sign-in refuses models outside it (live smoke, P3).
 */
export const DEFAULT_PROFILES: readonly ProfileConfig[] = [
  { id: 'model-a', provider: 'openai', model: 'gpt-6-luna' },
  { id: 'model-b', provider: 'openai', model: 'gpt-6.1-sol' },
];

/**
 * Providers whose subscription OAuth Corral does not start: Anthropic does not allow third-party
 * apps to use subscription credentials (CR-001 §2). They take an API key instead.
 */
const NO_SUBSCRIPTION_OAUTH = new Set(['anthropic']);

/** How a provider is reached: `none` is a keyless local endpoint (CR-005). */
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
  /** Ways this provider can be signed in to here (CR-005). */
  methods: { oauth: boolean; apiKey: boolean };
  /** host[:port] of an OpenAI-compatible endpoint; null for pi-ai's own providers. */
  endpoint: string | null;
  /** A key was entered for another address than the one the workspace names now. */
  endpointChanged: boolean;
  /** Subscription access (no per-request price is known). */
  subscription: boolean;
  /** When the current access token stops working; refreshed before requests. */
  expiresAt: string | null;
  login: LoginView | null;
  /**
   * Where the sign-in comes from: Corral's own store, the Codex CLI login read only (CR-004),
   * or a key in the server environment (which the page cannot remove).
   */
  source: 'corral' | 'codex-cli' | 'environment' | null;
  /** False when the borrowed Codex login file is readable by other users. */
  permissionsOk: boolean;
}

export interface CatalogProvider {
  providerId: string;
  name: string;
  /** An OpenAI-compatible endpoint from the workspace config (CR-005). */
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
  reasoningCapabilities: ReasoningCapabilities;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  method: AuthMethod | null;
  keyConfigured: boolean;
  /** Whether a subscription sign-in may use this model; null when no list is known. */
  subscriptionSupported: boolean | null;
}

export interface RegistryOptions {
  credentials: CredentialStore;
  getDeviceId(): string;
  now?: () => number;
  /** Models a subscription sign-in may call, per provider; null when no list is known. */
  subscriptionModels?: (providerId: string) => ReadonlySet<string> | null;
  /** OpenAI-compatible endpoints from the workspace config (CR-005), already registered. */
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

  private readonly models: Models;
  private profiles: readonly ProfileConfig[];
  private options: RegistryOptions;

  constructor(models: Models, profiles: readonly ProfileConfig[], options: RegistryOptions) {
    this.models = models;
    this.profiles = profiles;
    this.options = options;
  }

  private providers(): string[] {
    return [...new Set(this.profiles.map((p) => p.provider))];
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
    return {
      ok: true,
      snapshot: {
        profile,
        provider: config.provider,
        modelId: config.model,
        reasoning: reasoningCapabilities(this.models.getModel(config.provider, config.model)),
        // The run record knows oauth and api_key; a keyless endpoint is recorded as api_key.
        auth: method === 'none' ? 'api_key' : method,
      },
    };
  }

  /** The access token for one request; pi-ai refreshes an expired OAuth token first. */
  async credentials(model: ModelProfileSnapshot): Promise<string | null> {
    if (!model.provider || !model.modelId) return null;
    // A keyless endpoint gets no key from this computer (CR-005 §4).
    if (this.options.endpoints?.get(model.provider)?.spec.keyless) return null;
    const resolved = this.models.getModel(model.provider, model.modelId);
    if (!resolved) throw new Error(`${model.provider} has no model ${model.modelId}`);
    let auth: Awaited<ReturnType<Models['getAuth']>>;
    try {
      auth = await this.models.getAuth(resolved);
    } catch {
      // The provider's message can include request details; keep ours.
      if (sourceAware(this.options.credentials)?.sourceOf(model.provider) === 'codex-cli') {
        // Corral never refreshes a borrowed login (CR-004); Codex does that itself.
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
   * A team plan for a goal from one request to the first profile's model (CR-006). Outside any
   * Run: the person asked for it, and it is capped in output tokens and time.
   */
  async draftTeam(
    goal: string,
  ): Promise<
    | { ok: true; plan: TeamPlan; model: { provider: string; modelId: string } }
    | { ok: false; code: 'CAPABILITY_DENIED' | 'MODEL_UNAVAILABLE'; message: string }
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
    const unavailable = (message: string) =>
      ({ ok: false, code: 'MODEL_UNAVAILABLE', message }) as const;
    let text: string;
    try {
      const answer = await this.models
        .streamSimple(
          model,
          {
            systemPrompt: DRAFT_SYSTEM_PROMPT,
            messages: [{ role: 'user', content: goal, timestamp: Date.now() }],
          },
          { maxTokens: DRAFT_MAX_OUTPUT_TOKENS, signal: AbortSignal.timeout(DRAFT_TIMEOUT_MS) },
        )
        .result();
      if (answer.stopReason === 'error' || answer.stopReason === 'aborted') {
        return unavailable('the model request failed; try again or use the local suggestion');
      }
      text = answer.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
    } catch {
      return unavailable('the model request failed; try again or use the local suggestion');
    } finally {
      void this.refreshStatus();
    }
    const plan = planFromAnswer(text);
    return plan
      ? { ok: true, plan, model: { provider, modelId } }
      : unavailable("the model's answer was not a usable team plan; use the local suggestion");
  }

  /**
   * The auto choice for a session request (CR-024): one capped request to the session's model.
   * The caller checks the profile first and records only the parsed choice, never this text.
   */
  async routeAuto(
    brief: string,
    choice: AutoModelChoice,
    signal?: AbortSignal,
    levels?: readonly AutoRouteLevel[],
  ): Promise<RouteAnswer> {
    const resolution = this.resolve(choice.modelProfile, 'live');
    if (!resolution.ok || !resolution.snapshot.provider || !resolution.snapshot.modelId)
      return { ok: false, reason: 'model_error' };
    const model = this.models.getModel(resolution.snapshot.provider, resolution.snapshot.modelId);
    if (!model) return { ok: false, reason: 'model_error' };
    const policy = choice.reasoning;
    // auto and route start from the medium baseline (CR-021); the provider's default sends
    // nothing.
    const level =
      policy?.mode === 'auto' || policy?.mode === 'route'
        ? 'medium'
        : policy?.mode === 'fixed'
          ? policy.level
          : null;
    const reasoning =
      level === 'minimal' ||
      level === 'low' ||
      level === 'medium' ||
      level === 'high' ||
      level === 'xhigh'
        ? level
        : undefined;
    const timeout = AbortSignal.timeout(AUTO_ROUTE_TIMEOUT_MS);
    try {
      const answer = await this.models
        .streamSimple(
          model,
          {
            systemPrompt: autoRouterPrompt(levels),
            messages: [{ role: 'user', content: brief, timestamp: Date.now() }],
          },
          {
            maxTokens: AUTO_ROUTE_MAX_OUTPUT_TOKENS,
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
            ...(reasoning ? { reasoning } : {}),
          },
        )
        .result();
      const usage = answer.usage
        ? { inputTokens: answer.usage.input, outputTokens: answer.usage.output }
        : null;
      if (answer.stopReason === 'aborted')
        return { ok: false, reason: timeout.aborted ? 'timeout' : 'model_error' };
      if (answer.stopReason === 'error') return { ok: false, reason: 'model_error' };
      const text = answer.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
      return { ok: true, text, usage };
    } catch {
      return { ok: false, reason: timeout.aborted ? 'timeout' : 'model_error' };
    } finally {
      void this.refreshStatus();
    }
  }

  /** The profiles in use (what `.corral/config.json` names, or the defaults). */
  profileConfigs(): readonly ProfileConfig[] {
    return this.profiles;
  }

  /**
   * Profiles and endpoints saved from the Models page (CR-008). Runs already started keep the
   * profile snapshot they started with.
   */
  async reconfigure(profiles: readonly ProfileConfig[], endpoints: ReadonlyMap<string, Endpoint>) {
    this.profiles = profiles;
    this.options = { ...this.options, endpoints };
    await this.refreshStatus();
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

  /** Providers and their models for the profile editor (CR-008); no credentials or status. */
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
          // pi-ai's list prices (USD per million tokens), for estimates only (roadmap 15).
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

  /** The non-secret definition of the endpoint behind a model, for its worker (CR-005). */
  endpointOf(model: ModelProfileSnapshot): EndpointSpec | null {
    return (model.provider && this.options.endpoints?.get(model.provider)?.spec) || null;
  }

  private methods(providerId: string): { oauth: boolean; apiKey: boolean } {
    const auth = this.models.getProvider(providerId)?.auth;
    return {
      oauth: Boolean(auth?.oauth) && !NO_SUBSCRIPTION_OAUTH.has(providerId),
      apiKey: Boolean(auth?.apiKey) && !this.options.endpoints?.get(providerId)?.spec.keyless,
    };
  }

  /** Stores an API key entered under Settings → Models; it is never returned (CR-005). */
  async setApiKey(providerId: string, key: string): Promise<void> {
    if (!this.providers().includes(providerId)) {
      throw new RegistryError('not_found', 'no model profile uses this provider');
    }
    if (!this.methods(providerId).apiKey) {
      throw new RegistryError('unsupported', 'this provider does not take an API key');
    }
    const endpoint = this.options.endpoints?.get(providerId);
    this.cancelLogin(providerId);
    await this.options.credentials.modify(providerId, async () => ({
      type: 'api_key',
      key,
      // An endpoint key is bound to the address it was entered for.
      ...(endpoint ? { env: { [ENDPOINT_ORIGIN]: endpoint.origin } } : {}),
    }));
    await this.refreshStatus();
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
      return {
        profileId: profile.id,
        provider: profile.provider,
        providerName: this.providerName(profile.provider),
        modelId: profile.model,
        modelName: model?.name ?? null,
        available: Boolean(model),
        reasoning: model?.reasoning ?? null,
        reasoningCapabilities: reasoningCapabilities(model),
        contextWindow: model?.contextWindow ?? null,
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
    this.cancelLogin(providerId);
    await this.models.logout(providerId);
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

/** A credential store that knows where each sign-in came from (the CR-004 layered store). */
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
