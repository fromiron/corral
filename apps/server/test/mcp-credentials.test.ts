import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RegisteredMcpServer } from '@corral/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { McpCredentials } from '../src/harness/mcp-credentials.ts';
import { oauthFixture } from './fixtures/mcp-oauth.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const current = async () => {};
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'corral-mcp-auth-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const fixture = await oauthFixture();
  cleanup.push(fixture.close);
  const credentials = new McpCredentials({ directory: join(root, 'private') });
  cleanup.push(() => credentials.dispose());
  const server: Extract<RegisteredMcpServer, { transport: 'http' }> = {
    id: 'docs',
    name: 'Docs',
    transport: 'http',
    url: fixture.url,
    timeoutMs: 5000,
    exposure: 'direct',
    auth: { kind: 'oauth', credentialRef: 'docs-login', scope: 'docs:read' },
  };
  return { root, fixture, credentials, server };
}
async function login(ctx: Awaited<ReturnType<typeof setup>>, check = current) {
  const result = await ctx.credentials.startOAuth('p', ctx.server, check);
  await fetch(result.url);
  await expect.poll(() => ctx.credentials.loginStatus(result.loginId).state).toBe('ready');
  return result;
}
describe('TC-HAR-016 MCP credentials', () => {
  it('uses real PKCE, stores private credentials outside configuration, and returns only status', async () => {
    const ctx = await setup();
    await login(ctx);
    expect(ctx.fixture.exchanges).toBe(1);
    expect(ctx.credentials.status('p', ctx.server)).toMatchObject({
      state: 'ready',
      kind: 'oauth',
    });
    expect(JSON.stringify(ctx.credentials.status('p', ctx.server))).not.toContain('fixture-access');
    expect(await ctx.credentials.authorization('p', ctx.server, current)).toBe('fixture-access-0');
    const directory = join(ctx.root, 'private');
    const path = join(directory, readdirSync(directory)[0]!);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const content = readFileSync(path, 'utf8');
    expect(content).toContain('fixture-refresh-0');
    expect(content).not.toContain('codeVerifier');
    expect(content).not.toContain('oauthState');
    expect(ctx.credentials.status('other-project', ctx.server).state).toBe('missing');
    expect(
      ctx.credentials.status('p', { ...ctx.server, url: `${ctx.server.url}/other` }).state,
    ).toBe('missing');
    expect(
      ctx.credentials.status('p', {
        ...ctx.server,
        auth: { kind: 'oauth', credentialRef: 'docs-login', scope: 'docs:write' },
      }).state,
    ).toBe('missing');
  });
  it('shares concurrent refresh and refuses scope expansion', async () => {
    const ctx = await setup();
    await login(ctx);
    const challenge = {
      status: 401 as const,
      wwwAuthenticate: 'Bearer error="invalid_token"',
      rejectedToken: 'fixture-access-0',
    };
    expect(
      await Promise.all(
        [1, 2, 3].map(() => ctx.credentials.authorization('p', ctx.server, current, challenge)),
      ),
    ).toEqual(Array(3).fill('fixture-access-1'));
    expect(ctx.fixture.refreshes).toBe(1);
    await expect(
      ctx.credentials.authorization('p', ctx.server, current, {
        ...challenge,
        wwwAuthenticate: 'Bearer error="insufficient_scope", scope="docs:write"',
      }),
    ).rejects.toThrow(/sign in|scope/i);
    expect(ctx.fixture.refreshes).toBe(1);
  });
  it('cancels pending login and never commits a grant after trust is revoked', async () => {
    const ctx = await setup();
    const pending = await ctx.credentials.startOAuth('p', ctx.server, current);
    await ctx.credentials.cancelOAuth(pending.loginId);
    expect(ctx.credentials.loginStatus(pending.loginId).state).toBe('cancelled');
    expect(ctx.credentials.status('p', ctx.server).state).toBe('missing');
    let trusted = true;
    const second = await ctx.credentials.startOAuth('p', ctx.server, async () => {
      if (!trusted) throw new Error('revoked');
    });
    trusted = false;
    await fetch(second.url);
    await expect.poll(() => ctx.credentials.loginStatus(second.loginId).state).toBe('failed');
    expect(ctx.credentials.status('p', ctx.server).state).toBe('missing');
  });
  it('does not resurrect credentials when logout races a refresh', async () => {
    const ctx = await setup();
    await login(ctx);
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    ctx.fixture.delayRefresh(async () => {
      entered();
      await hold;
    });
    const refreshing = ctx.credentials.authorization('p', ctx.server, current, {
      status: 401,
      rejectedToken: 'fixture-access-0',
    });
    const result = refreshing.catch(() => 'refused');
    await started;
    await ctx.credentials.delete('p', ctx.server);
    release();
    expect(await result).toBe('refused');
    expect(ctx.credentials.status('p', ctx.server).state).toBe('missing');
  });
  it('cannot write refresh credentials after logout wins the guard continuation gap', async () => {
    const ctx = await setup();
    await login(ctx);
    const credentials = new McpCredentials({ directory: join(ctx.root, 'private') });
    cleanup.push(() => credentials.dispose());
    let logout: Promise<void> | undefined;
    const check = async () => {
      if (ctx.fixture.refreshes > 0 && !logout) {
        queueMicrotask(() =>
          queueMicrotask(() => {
            logout = credentials.delete('p', ctx.server);
          }),
        );
      }
    };
    const outcome = await credentials
      .authorization('p', ctx.server, check, { status: 401, rejectedToken: 'fixture-access-0' })
      .catch(() => 'refused');
    await logout;
    expect(outcome).toBe('refused');
    expect(credentials.status('p', ctx.server).state).toBe('missing');
  });
  it('rejects over-broad grants and separates bearer credentials by exact binding', async () => {
    const ctx = await setup();
    ctx.fixture.scope('docs:read docs:write');
    const pending = await ctx.credentials.startOAuth('p', ctx.server, current);
    await fetch(pending.url);
    await expect.poll(() => ctx.credentials.loginStatus(pending.loginId).state).toBe('failed');
    expect(ctx.credentials.status('p', ctx.server).state).toBe('missing');
    const bearer = { ...ctx.server, auth: { kind: 'bearer' as const, credentialRef: 'manual' } };
    await ctx.credentials.saveBearer('p', bearer, 'fixture-manual-token', current);
    expect(await ctx.credentials.authorization('p', bearer, current)).toBe('fixture-manual-token');
    await expect(
      ctx.credentials.authorization('p', { ...bearer, url: `${bearer.url}/other` }, current),
    ).rejects.toThrow(/sign in/i);
    await expect(
      ctx.credentials.authorization('p', bearer, async () => {
        throw new Error('revoked');
      }),
    ).rejects.toThrow('revoked');
  });
});
