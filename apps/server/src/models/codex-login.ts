import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  Credential,
  CredentialInfo,
  CredentialStore,
  OAuthCredential,
} from '@earendil-works/pi-ai';
import { DEFAULT_PROFILES, type ProfileConfig } from './registry.ts';

// CR-004: reuse the Codex CLI login, read only. Its access token works with pi-ai's
// `openai-codex` provider (same OAuth client). Corral never refreshes it: a refresh may rotate
// the refresh token and break Codex's own login. Corral never writes or deletes the file.

/** The provider a Codex CLI login signs in to. */
export const CODEX_PROVIDER = 'openai-codex';

export function codexAuthPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return join(env.CODEX_HOME || join(home, '.codex'), 'auth.json');
}

export type CodexLogin =
  | { state: 'missing' }
  | { state: 'unreadable' }
  | { state: 'found'; credential: OAuthCredential; permissionsOk: boolean };

/** Expiry (ms) from a JWT's `exp` claim; no signature check: display and expiry only. */
function jwtExpiry(token: string): number | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      exp?: unknown;
    };
    return typeof claims.exp === 'number' ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

export function readCodexLogin(path: string): CodexLogin {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { state: 'missing' };
  }
  try {
    const parsed = JSON.parse(text) as {
      tokens?: { access_token?: unknown; account_id?: unknown } | null;
    };
    const access = parsed.tokens?.access_token;
    const expires = typeof access === 'string' ? jwtExpiry(access) : null;
    if (typeof access !== 'string' || !access || expires === null) return { state: 'unreadable' };
    const mode = statSync(path).mode & 0o777;
    return {
      state: 'found',
      permissionsOk: process.platform === 'win32' || (mode & 0o077) === 0,
      credential: {
        type: 'oauth',
        access,
        // Never handed on: refreshing is Codex's job (CR-004 §2).
        refresh: '',
        expires,
        ...(typeof parsed.tokens?.account_id === 'string'
          ? { accountId: parsed.tokens.account_id }
          : {}),
      },
    };
  } catch {
    return { state: 'unreadable' };
  }
}

/**
 * Corral's own credential store first; for `openai-codex` without an own sign-in, the Codex CLI
 * login read fresh from its file each time (Codex may have refreshed it meanwhile).
 */
export class LayeredCredentialStore implements CredentialStore {
  private readonly own: CredentialStore;
  private readonly codexPath: string;
  private readonly codexProvider: string;

  /** `codexProvider` is the provider the Codex login serves; tests point it at a fake. */
  constructor(own: CredentialStore, codexPath: string, codexProvider = CODEX_PROVIDER) {
    this.own = own;
    this.codexPath = codexPath;
    this.codexProvider = codexProvider;
  }

  private codex(providerId: string): OAuthCredential | undefined {
    if (providerId !== this.codexProvider) return undefined;
    const login = readCodexLogin(this.codexPath);
    return login.state === 'found' ? login.credential : undefined;
  }

  /** Whether Corral's own store held a credential for the provider when last read. */
  private readonly ownCache = new Map<string, boolean>();
  private hasOwn(providerId: string): boolean {
    return this.ownCache.get(providerId) === true;
  }

  /** Where a provider's credential comes from right now. */
  sourceOf(providerId: string): 'corral' | 'codex-cli' | null {
    if (this.hasOwn(providerId)) return 'corral';
    return this.codex(providerId) ? 'codex-cli' : null;
  }

  /** Permissions of the Codex file, when it is the source (CR-004 §5). */
  codexPermissionsOk(): boolean {
    const login = readCodexLogin(this.codexPath);
    return login.state !== 'found' || login.permissionsOk;
  }

  async read(providerId: string): Promise<Credential | undefined> {
    const own = await this.own.read(providerId);
    this.ownCache.set(providerId, own !== undefined);
    return own ?? this.codex(providerId);
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const own = await this.own.list();
    for (const info of own) this.ownCache.set(info.providerId, true);
    const codex = this.codex(this.codexProvider);
    return codex && !own.some((c) => c.providerId === this.codexProvider)
      ? [...own, { providerId: this.codexProvider, type: 'oauth' }]
      : own;
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    const own = await this.own.read(providerId);
    const codex = own === undefined ? this.codex(providerId) : undefined;
    // A borrowed Codex login is never refreshed or replaced here (CR-004 §2).
    if (codex) return codex;
    const next = await this.own.modify(providerId, fn);
    this.ownCache.set(providerId, next !== undefined);
    return next;
  }

  async delete(providerId: string): Promise<void> {
    // Signing out removes Corral's own sign-in only; the Codex file is Codex's.
    await this.own.delete(providerId);
    this.ownCache.set(providerId, false);
  }
}

/** CR-004 §4: the two default profiles, on the provider the available sign-in works with. */
export function defaultProfilesFor({
  ownOpenAI,
  codexLogin,
}: {
  ownOpenAI: boolean;
  codexLogin: boolean;
}): ProfileConfig[] {
  const provider = !ownOpenAI && codexLogin ? CODEX_PROVIDER : 'openai';
  return DEFAULT_PROFILES.map((p) => ({ ...p, provider }));
}
