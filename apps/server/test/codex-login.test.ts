import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { afterEach, describe, expect, it } from 'vitest';
import {
  codexAuthPath,
  defaultProfilesFor,
  FileCredentialStore,
  LayeredCredentialStore,
  ModelRegistry,
  readCodexLogin,
} from '../src/models/index.ts';

// CR-004: the Codex CLI login, read only.

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'corral-codex-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = (claims: Record<string, unknown>) => `${b64({ alg: 'none' })}.${b64(claims)}.sig`;
const EXP = Math.floor(Date.UTC(2026, 9, 20) / 1000);

function codexFile(dir: string, tokens: Record<string, unknown> | null, mode = 0o600) {
  const path = join(dir, 'auth.json');
  writeFileSync(
    path,
    JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens, last_refresh: 'x' }),
    { mode },
  );
  chmodSync(path, mode);
  return path;
}

const goodTokens = () => ({
  id_token: 'id-secret',
  access_token: jwt({ exp: EXP, 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1' } }),
  refresh_token: 'refresh-secret',
  account_id: 'acct-1',
});

describe('Codex CLI login source (CR-004)', () => {
  it('[TC-SEC-002-H] reads the access token as an oauth credential that expires with the token', () => {
    const path = codexFile(temp(), goodTokens());
    const login = readCodexLogin(path);
    expect(login.state).toBe('found');
    if (login.state !== 'found') return;
    expect(login.credential.type).toBe('oauth');
    expect(login.credential.access).toBe(goodTokens().access_token);
    expect(login.credential.expires).toBe(EXP * 1000);
    // The refresh token is never handed on: refreshing could rotate it and break Codex.
    expect(login.credential.refresh).toBe('');
    expect(login.permissionsOk).toBe(true);
  });

  it('[TC-SEC-002-N] a missing, broken or tokenless file is no login; loose permissions are reported', () => {
    const dir = temp();
    expect(readCodexLogin(join(dir, 'none.json')).state).toBe('missing');
    writeFileSync(join(dir, 'broken.json'), '{nope');
    expect(readCodexLogin(join(dir, 'broken.json')).state).toBe('unreadable');
    expect(readCodexLogin(codexFile(temp(), null)).state).toBe('unreadable');
    const loose = readCodexLogin(codexFile(temp(), goodTokens(), 0o644));
    expect(loose.state === 'found' && loose.permissionsOk).toBe(false);
  });

  it('[TC-SEC-002-H] CODEX_HOME moves the file; otherwise it is ~/.codex/auth.json', () => {
    expect(codexAuthPath({ CODEX_HOME: '/x/codex' }, '/home/u')).toBe('/x/codex/auth.json');
    expect(codexAuthPath({}, '/home/u')).toBe('/home/u/.codex/auth.json');
  });
});

describe('layered credential store (CR-004)', () => {
  it('[TC-SEC-002-H] Corral’s own sign-in wins; without it openai-codex reads the Codex login', async () => {
    const own = new FileCredentialStore(temp());
    const path = codexFile(temp(), goodTokens());
    const store = new LayeredCredentialStore(own, path);
    expect((await store.read('openai-codex'))?.type).toBe('oauth');
    expect(store.sourceOf('openai-codex')).toBe('codex-cli');
    expect(await store.read('openai')).toBeUndefined();
    await own.modify('openai-codex', async () => ({
      type: 'oauth',
      access: 'own',
      refresh: 'own-r',
      expires: 1,
    }));
    expect((await store.read('openai-codex')) as { access: string }).toMatchObject({
      access: 'own',
    });
    expect(store.sourceOf('openai-codex')).toBe('corral');
  });

  it('[TC-SEC-002-N] never refreshes, rewrites or deletes the Codex file', async () => {
    const path = codexFile(temp(), goodTokens());
    const before = readFileSync(path, 'utf8');
    const mtime = statSync(path).mtimeMs;
    const store = new LayeredCredentialStore(new FileCredentialStore(temp()), path);
    let called = false;
    const result = await store.modify('openai-codex', async () => {
      called = true;
      return { type: 'oauth', access: 'new', refresh: 'new', expires: 2 };
    });
    expect(called).toBe(false);
    expect(result?.type === 'oauth' && result.access).toBe(goodTokens().access_token);
    await store.delete('openai-codex');
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(statSync(path).mtimeMs).toBe(mtime);
  });
});

describe('default profiles (CR-004)', () => {
  it('[TC-SEC-002-H] use Corral’s own OpenAI sign-in first, then the Codex login, else ask to sign in', () => {
    expect(
      defaultProfilesFor({ ownOpenAI: true, codexLogin: true }).map((p) => p.provider),
    ).toEqual(['openai', 'openai']);
    expect(
      defaultProfilesFor({ ownOpenAI: false, codexLogin: true }).map((p) => p.provider),
    ).toEqual(['openai-codex', 'openai-codex']);
    expect(
      defaultProfilesFor({ ownOpenAI: false, codexLogin: false }).map((p) => p.provider),
    ).toEqual(['openai', 'openai']);
    expect(defaultProfilesFor({ ownOpenAI: false, codexLogin: true }).map((p) => p.model)).toEqual([
      'gpt-6-luna',
      'gpt-6.1-sol',
    ]);
  });
});

describe('Models view of a borrowed login (CR-004)', () => {
  const registryFor = (store: LayeredCredentialStore) =>
    new ModelRegistry(
      builtinModels({ credentials: store }),
      defaultProfilesFor({ ownOpenAI: false, codexLogin: true }),
      { credentials: store, getDeviceId: () => 'device', now: () => Date.UTC(2026, 9, 16) },
    );

  it('[TC-SEC-002-H] says the sign-in is the Codex CLI login, with its expiry, and lets live runs start', async () => {
    const store = new LayeredCredentialStore(
      new FileCredentialStore(temp()),
      codexFile(temp(), goodTokens()),
    );
    const registry = registryFor(store);
    await registry.refreshStatus();
    const view = registry.authView();
    expect(view).toEqual([
      expect.objectContaining({
        providerId: 'openai-codex',
        signedIn: true,
        method: 'oauth',
        source: 'codex-cli',
        permissionsOk: true,
        expiresAt: new Date(EXP * 1000).toISOString(),
      }),
    ]);
    const text = JSON.stringify(view);
    for (const secret of ['id-secret', 'refresh-secret', goodTokens().access_token, 'auth.json']) {
      expect(text).not.toContain(secret);
    }
    expect(registry.resolve('model-a', 'live').ok).toBe(true);
  });

  it('[TC-SEC-002-N] a world-readable Codex file is flagged; no file means not signed in', async () => {
    const loose = registryFor(
      new LayeredCredentialStore(
        new FileCredentialStore(temp()),
        codexFile(temp(), goodTokens(), 0o644),
      ),
    );
    await loose.refreshStatus();
    expect(loose.authView()[0]).toMatchObject({ source: 'codex-cli', permissionsOk: false });
    const none = registryFor(
      new LayeredCredentialStore(new FileCredentialStore(temp()), join(temp(), 'auth.json')),
    );
    await none.refreshStatus();
    expect(none.authView()[0]).toMatchObject({
      signedIn: false,
      source: null,
      permissionsOk: true,
    });
    expect(none.resolve('model-a', 'live').ok).toBe(false);
  });
});
