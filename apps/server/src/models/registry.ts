import type { ModelProfileSnapshot } from '@corral/contracts';
import type { ModelResolution, ModelResolver } from '@corral/core';
import type { AuthEvent, AuthPrompt, CredentialStore, Models } from '@earendil-works/pi-ai';

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

export interface ProviderAuthView {
  providerId: string;
  name: string;
  signedIn: boolean;
  method: 'oauth' | 'api_key' | null;
  /** Subscription access (no per-request price is known). */
  subscription: boolean;
  /** When the current access token stops working; refreshed before requests. */
  expiresAt: string | null;
  login: LoginView | null;
  /** Where the sign-in comes from: Corral's own, or the Codex CLI login read only (CR-004). */
  source: 'corral' | 'codex-cli' | null;
  /** False when the borrowed Codex login file is readable by other users. */
  permissionsOk: boolean;
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
  contextWindow: number | null;
  maxOutputTokens: number | null;
  method: 'oauth' | 'api_key' | null;
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
}

interface PendingLogin {
  view: LoginView;
  abort: AbortController;
  manual: ((value: string) => void) | null;
}

export class ModelRegistry implements ModelResolver {
  private readonly status = new Map<
    string,
    { method: 'oauth' | 'api_key' | null; expires: number | null }
  >();
  private readonly logins = new Map<string, PendingLogin>();

  private readonly models: Models;
  private readonly profiles: readonly ProfileConfig[];
  private readonly options: RegistryOptions;

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
      this.status.set(providerId, {
        method: check?.type ?? null,
        expires: stored?.type === 'oauth' ? stored.expires : null,
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
      snapshot: { profile, provider: config.provider, modelId: config.model, auth: method },
    };
  }

  /** The access token for one request; pi-ai refreshes an expired OAuth token first. */
  async credentials(model: ModelProfileSnapshot): Promise<string | null> {
    if (!model.provider || !model.modelId) return null;
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
        subscription: status?.method === 'oauth' && this.subscription(providerId),
        expiresAt: status?.expires ? new Date(Math.max(status.expires, now)).toISOString() : null,
        login: login ? { ...login.view } : null,
        source: status?.method ? (layered?.sourceOf(providerId) ?? 'corral') : null,
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
    if (!this.providers().includes(providerId)) throw new Error('no profile uses this provider');
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
