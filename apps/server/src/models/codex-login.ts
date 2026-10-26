import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  Credential,
  CredentialInfo,
  CredentialStore,
  OAuthCredential,
} from '@earendil-works/pi-ai';
import { privatePermissions } from '../private-files.ts';
import type { VaultCredentialOwner } from './credential-store.ts';
import { DEFAULT_PROFILES, type ProfileConfig } from './registry.ts';

// reuse the Codex CLI login, read only. Its access token works with pi-ai's
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

function loadCodexLogin(path: string): CodexLogin {
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
    return {
      state: 'found',
      permissionsOk: false,
      credential: {
        type: 'oauth',
        access,
        // Never handed on: refreshing is Codex's job.
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

export function readCodexLogin(path: string): CodexLogin {
  const login = loadCodexLogin(path);
  return login.state === 'found'
    ? { ...login, permissionsOk: privatePermissions(path) === true }
    : login;
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
    // Token resolution stays read-only and does not spawn ACL inspection per SDK read.
    // The public sign-in status below separately verifies permissions on each request.
    const login = loadCodexLogin(this.codexPath);
    return login.state === 'found' ? login.credential : undefined;
  }

  /** Whether Corral's own store held a credential for the provider when last read. */
  private readonly ownCache = new Map<string, boolean>();
  private hasOwn(providerId: string): boolean {
    return this.ownCache.get(providerId) === true;
  }

  private vaultOwner(): VaultCredentialOwner {
    const owner = this.own as CredentialStore & Partial<VaultCredentialOwner>;
    if (
      !owner.readOwnForVault ||
      !owner.applyForVault ||
      !owner.receiptForVault ||
      !owner.fingerprintForVault
    )
      throw new Error('This credential store does not support recoverable vault operations.');
    return owner as CredentialStore & VaultCredentialOwner;
  }
  readOwnForVault() {
    return this.vaultOwner().readOwnForVault();
  }
  fingerprintForVault(value: unknown) {
    return this.vaultOwner().fingerprintForVault(value);
  }
  receiptForVault(operationId: string) {
    return this.vaultOwner().receiptForVault(operationId);
  }
  async applyForVault(input: Parameters<VaultCredentialOwner['applyForVault']>[0]) {
    const owner = this.vaultOwner();
    const previous = await owner.readOwnForVault();
    if (
      !previous[this.codexProvider] &&
      input.credentials[this.codexProvider] &&
      this.codex(this.codexProvider)
    )
      throw new Error('Borrowed Codex login cannot be replaced by vault import.');
    const receipt = await owner.applyForVault(input);
    for (const id of new Set([...Object.keys(previous), ...Object.keys(input.credentials)]))
      this.ownCache.set(id, Boolean(input.credentials[id]));
    return receipt;
  }

  /** Where a provider's credential comes from right now. */
  sourceOf(providerId: string): 'corral' | 'codex-cli' | null {
    if (this.hasOwn(providerId)) return 'corral';
    return this.codex(providerId) ? 'codex-cli' : null;
  }

  /** Permissions of the Codex file, when it is the source. */
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
    // A borrowed Codex login is never refreshed or replaced here.
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

/** the two default profiles, on the provider the available sign-in works with. */
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
