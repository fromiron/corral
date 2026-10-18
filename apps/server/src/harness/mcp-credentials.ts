import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, type McpChallenge, type RegisteredMcpServer } from '@corral/contracts';
import {
  adaptOAuthProvider,
  authorizeMcp,
  McpOAuthProvider,
  type McpOAuthState,
  MemoryOAuthStateStore,
  OAuthCallbackServer,
  parseWwwAuthenticate,
} from '@earendil-works/pi-mcp/oauth';

type HttpServer = Extract<RegisteredMcpServer, { transport: 'http' }>;
type Check = () => Promise<void>;
interface Saved {
  version: 1;
  binding: string;
  bearer?: string;
  oauth?: McpOAuthState;
  redirectUrl?: string;
}
interface Login {
  key: string;
  state: 'pending' | 'ready' | 'failed' | 'cancelled';
  controller: AbortController;
  close(): Promise<void>;
}
const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const signIn = () => new Error('Sign in to the configured MCP server again.');
function withinScope(actual: string | undefined, allowed: string) {
  const configured = new Set(allowed.split(/\s+/));
  return actual
    ?.split(/\s+/)
    .filter(Boolean)
    .every((scope) => configured.has(scope));
}

/** Only private authentication material lives here; project revisions contain references. */
export class McpCredentials {
  private readonly directory: string;
  private readonly fetch: typeof fetch;
  private readonly newId: () => string;
  private readonly generations = new Map<string, number>();
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly logins = new Map<string, Login>();
  private disposed = false;

  constructor(options: { directory: string; fetch?: typeof fetch; newId?: () => string }) {
    this.directory = options.directory;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.newId = options.newId ?? randomUUID;
  }

  private identity(projectId: string, server: HttpServer) {
    if (server.auth.kind === 'none') throw signIn();
    return {
      key: digest({ projectId, serverId: server.id, credentialRef: server.auth.credentialRef }),
      binding: digest({ url: server.url, auth: server.auth }),
    };
  }
  private load(key: string, binding: string): Saved | undefined {
    const file = join(this.directory, `${key}.json`);
    if (!existsSync(file)) return;
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.size > 256 * 1024) throw new Error();
      const value = JSON.parse(readFileSync(file, 'utf8')) as Saved;
      if (value.version !== 1 || typeof value.binding !== 'string') throw new Error();
      if (value.binding !== binding) return;
      if (
        value.oauth?.tokens &&
        (typeof value.oauth.tokens.access_token !== 'string' ||
          typeof value.oauth.tokens.token_type !== 'string' ||
          (value.oauth.tokens.refresh_token !== undefined &&
            typeof value.oauth.tokens.refresh_token !== 'string'))
      )
        throw new Error();
      if (value.bearer !== undefined && typeof value.bearer !== 'string') throw new Error();
      return value;
    } catch {
      throw new Error('The saved MCP sign-in cannot be read; sign in again.');
    }
  }
  private save(key: string, value: Saved) {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (!lstatSync(this.directory).isDirectory()) throw signIn();
    chmodSync(this.directory, 0o700);
    const file = join(this.directory, `${key}.json`);
    const temporary = `${file}.${this.newId()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
      renameSync(temporary, file);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  private guard(key: string, check: Check) {
    const generation = this.generations.get(key) ?? 0;
    // Awaiting the guard yields again; credential publication needs this synchronous fence.
    const current = () => {
      if (this.disposed || generation !== (this.generations.get(key) ?? 0)) throw signIn();
    };
    return Object.assign(
      async () => {
        current();
        await check();
        current();
      },
      { current },
    );
  }
  private oauthState(server: HttpServer, state: McpOAuthState): McpOAuthState {
    if (server.auth.kind !== 'oauth' || state.serverUrl !== new URL(server.url).href)
      throw signIn();
    if (state.tokens && !withinScope(state.tokens.scope, server.auth.scope)) throw signIn();
    const { codeVerifier: _verifier, oauthState: _state, ...saved } = state;
    return saved;
  }

  status(projectId: string, server: RegisteredMcpServer) {
    if (server.transport === 'stdio' || server.auth.kind === 'none')
      return { state: 'not_required' as const, kind: 'none' as const };
    const { key, binding } = this.identity(projectId, server);
    const saved = this.load(key, binding);
    const ready = server.auth.kind === 'bearer' ? !!saved?.bearer : !!saved?.oauth?.tokens;
    return {
      state: ready ? ('ready' as const) : ('missing' as const),
      kind: server.auth.kind,
      ...(saved?.oauth?.tokensExpireAt ? { expiresAt: saved.oauth.tokensExpireAt } : {}),
    };
  }

  async saveBearer(projectId: string, server: HttpServer, token: string, check: Check) {
    if (
      server.auth.kind !== 'bearer' ||
      !token ||
      token.length > 16000 ||
      /[\s\p{Cc}]/u.test(token)
    )
      throw signIn();
    const { key, binding } = this.identity(projectId, server);
    const initial = this.guard(key, check);
    await initial();
    initial.current();
    const deleting = this.delete(projectId, server);
    const guard = this.guard(key, check);
    await deleting;
    await guard();
    guard.current();
    this.save(key, { version: 1, binding, bearer: token });
  }

  async startOAuth(projectId: string, server: HttpServer, check: Check) {
    if (server.auth.kind !== 'oauth') throw signIn();
    const { key, binding } = this.identity(projectId, server);
    const initial = this.guard(key, check);
    await initial();
    initial.current();
    // A new login supersedes pending callbacks and refresh writes for this reference.
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
    const guard = this.guard(key, check);
    for (const [id, login] of [...this.logins])
      if (login.key === key && login.state === 'pending') await this.cancelOAuth(id);
    for (const [id, login] of this.logins) if (login.state !== 'pending') this.logins.delete(id);
    if (this.logins.size >= 16) throw new Error('Too many MCP sign-ins are pending.');
    await guard();
    const callback = await OAuthCallbackServer.listen({ timeoutMs: 5 * 60_000 });
    const controller = new AbortController();
    const loginId = `mcp_login_${this.newId()}`;
    let closing: Promise<void> | undefined;
    const login: Login = {
      key,
      state: 'pending',
      controller,
      close: () => (closing ??= callback.close()),
    };
    this.logins.set(loginId, login);
    const store = new MemoryOAuthStateStore();
    let url: string | undefined;
    const provider = new McpOAuthProvider({
      serverUrl: server.url,
      redirectUrl: callback.redirectUrl,
      clientId: server.auth.clientId,
      clientMetadata: { client_name: 'Corral', scope: server.auth.scope },
      store,
      onRedirect: (target) => {
        url = target.href;
      },
    });
    try {
      const state = await provider.state();
      const incoming = callback.waitForCallback(state);
      // Closing the listener during discovery must not create an unhandled rejection.
      void incoming.catch(() => {});
      const options = {
        serverUrl: server.url,
        scope: server.auth.scope,
        fetch: this.fetch,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
      };
      await authorizeMcp(provider, { ...options, skipRefresh: true });
      await guard();
      if (!url) throw signIn();
      void (async () => {
        try {
          const result = await incoming;
          await guard();
          const authorized = await authorizeMcp(provider, {
            ...options,
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
            authorizationCode: result.code,
            ...(result.iss ? { iss: result.iss } : {}),
          });
          await guard();
          const oauth = store.load();
          if (authorized !== 'AUTHORIZED' || !oauth?.tokens || login.state !== 'pending')
            throw signIn();
          guard.current();
          this.save(key, {
            version: 1,
            binding,
            redirectUrl: callback.redirectUrl,
            oauth: this.oauthState(server, oauth),
          });
          login.state = 'ready';
        } catch {
          if (login.state === 'pending') login.state = 'failed';
        } finally {
          await login.close();
        }
      })();
      return { loginId, url };
    } catch {
      login.state = 'failed';
      controller.abort();
      await login.close();
      throw signIn();
    }
  }
  loginStatus(loginId: string) {
    const login = this.logins.get(loginId);
    if (!login) throw new Error('MCP sign-in not found.');
    return { state: login.state };
  }
  async cancelOAuth(loginId: string) {
    const login = this.logins.get(loginId);
    if (login?.state !== 'pending') return;
    login.state = 'cancelled';
    login.controller.abort();
    await login.close();
  }
  async delete(projectId: string, server: HttpServer) {
    const { key } = this.identity(projectId, server);
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
    rmSync(join(this.directory, `${key}.json`), { force: true });
    for (const [id, login] of [...this.logins]) if (login.key === key) await this.cancelOAuth(id);
  }

  async authorization(
    projectId: string,
    server: HttpServer,
    check: Check,
    challenge?: McpChallenge,
  ): Promise<string | undefined> {
    await check();
    if (server.auth.kind === 'none') return;
    const { key, binding } = this.identity(projectId, server);
    const guard = this.guard(key, check);
    const previous = this.chains.get(key) ?? Promise.resolve();
    const request = previous
      .catch(() => {})
      .then(async () => {
        await guard();
        const saved = this.load(key, binding);
        if (server.auth.kind === 'bearer') {
          if (!saved?.bearer || challenge) throw signIn();
          guard.current();
          return saved.bearer;
        }
        if (server.auth.kind !== 'oauth' || !saved?.oauth?.tokens || !saved.redirectUrl)
          throw signIn();
        const provider = new McpOAuthProvider({
          serverUrl: server.url,
          redirectUrl: saved.redirectUrl,
          clientId: server.auth.clientId,
          clientMetadata: { client_name: 'Corral', scope: server.auth.scope },
          store: {
            load: () => this.load(key, binding)?.oauth,
            save: async (state) => {
              await guard();
              guard.current();
              this.save(key, {
                version: 1,
                binding,
                redirectUrl: saved.redirectUrl,
                oauth: this.oauthState(server, state),
              });
            },
          },
          onRedirect: () => {
            throw signIn();
          },
        });
        const auth = adaptOAuthProvider(provider);
        if (challenge) {
          const parsed = parseWwwAuthenticate(challenge.wwwAuthenticate ?? null);
          if (
            parsed.error === 'insufficient_scope' ||
            (parsed.scope && !withinScope(parsed.scope, server.auth.scope))
          )
            throw signIn();
          const signal = AbortSignal.timeout(30_000);
          if (!auth.onUnauthorized) throw signIn();
          await auth.onUnauthorized({
            serverUrl: new URL(server.url),
            response: new Response(null, {
              status: challenge.status,
              headers: challenge.wwwAuthenticate
                ? { 'www-authenticate': challenge.wwwAuthenticate }
                : {},
            }),
            token: challenge.rejectedToken,
            fetch: (input, init) =>
              this.fetch(input, {
                ...init,
                signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal,
              }),
          });
        }
        await guard();
        const token = await auth.token();
        if (!token) throw signIn();
        guard.current();
        return token;
      });
    this.chains.set(key, request);
    try {
      return await request;
    } finally {
      if (this.chains.get(key) === request) this.chains.delete(key);
    }
  }
  async dispose() {
    this.disposed = true;
    await Promise.all([...this.logins.keys()].map((id) => this.cancelOAuth(id)));
  }
}
