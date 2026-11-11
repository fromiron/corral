import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpSseTransport, RestCorralRepository } from '@corral/client';
import { Identifier, type RunEvent } from '@corral/contracts';
import { parseWorkspaceConfig, waitForProjection } from '@corral/core';
import { linearCorral, ScriptedAgentAdapter } from '@corral/testkit';
import {
  createFauxCore,
  createModels,
  createProvider,
  envApiKeyAuth,
  InMemoryCredentialStore,
  type Model,
  type OAuthAuth,
} from '@earendil-works/pi-ai';
import { cloudflareAIGatewayProvider } from '@earendil-works/pi-ai/providers/cloudflare-ai-gateway';
import { cloudflareWorkersAIProvider } from '@earendil-works/pi-ai/providers/cloudflare-workers-ai';
import { afterEach, describe, expect, it } from 'vitest';
import type { LiveModels } from '../src/app.ts';
import { type CorralServer, startCorralServer } from '../src/index.ts';
import { connectionProfileId } from '../src/models/connection-models.ts';
import { FileCredentialStore, LayeredCredentialStore } from '../src/models/index.ts';
import { ModelRegistry, type ProfileConfig } from '../src/models/registry.ts';
import { FAKE_CODEX_ACCESS, FAKE_PROFILES, FAKE_REDIRECT_OK, fakeOpenAI } from '../src/testing.ts';

const TOKEN = 'test-bootstrap-token-0123456789abcdef';
const servers: CorralServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = (name: string) => {
  const dir = mkdtempSync(join(tmpdir(), `corral-${name}-`));
  dirs.push(dir);
  return dir;
};

/** GitHub Copilot as Pi has it: a device-code subscription sign-in and a per-account model list. */
function addCopilot(live: LiveModels) {
  const seen = { refreshes: 0, prompts: [] as string[] };
  let approve!: () => void;
  const approved = new Promise<void>((resolve) => {
    approve = resolve;
  });
  const oauth: OAuthAuth = {
    name: 'GitHub Copilot',
    isSubscription: true,
    async login(interaction) {
      seen.prompts.push(
        await interaction.prompt({
          type: 'text',
          message: 'GitHub Enterprise URL/domain (blank for github.com)',
        }),
      );
      interaction.notify({
        type: 'device_code',
        userCode: 'ABCD-1234',
        verificationUri: 'https://github.example.test/login/device',
      });
      await approved;
      return {
        type: 'oauth',
        access: 'copilot-access-secret',
        refresh: 'copilot-refresh-secret',
        expires: Date.now() + 3_600_000,
        availableModelIds: ['copilot-a', 'vendor/copilot-b'],
      };
    },
    async refresh(credential) {
      seen.refreshes++;
      return credential;
    },
    async toAuth(credential) {
      return { apiKey: credential.access };
    },
  };
  const faux = createFauxCore({
    provider: 'github-copilot',
    models: [
      { id: 'copilot-a', name: 'Copilot A', reasoning: false },
      { id: 'vendor/copilot-b', name: 'Copilot B' },
      { id: 'copilot-hidden', name: 'Not in this account' },
    ],
  });
  live.models.setProvider(
    createProvider({
      id: 'github-copilot',
      name: 'GitHub Copilot',
      auth: { apiKey: envApiKeyAuth('GitHub Copilot token', ['COPILOT_GITHUB_TOKEN']), oauth },
      models: faux.models,
      filterModels: (models, credential) => {
        const ids = credential?.type === 'oauth' ? credential.availableModelIds : undefined;
        return Array.isArray(ids) ? models.filter((model) => ids.includes(model.id)) : models;
      },
      api: { stream: faux.stream, streamSimple: faux.streamSimple },
    }),
  );
  return { seen, approve };
}

/** A provider whose list Pi refreshes from the network (like Radius). */
function addDynamic(live: LiveModels) {
  const calls = { fetches: 0 };
  const faux = createFauxCore({ provider: 'dynamo', models: [{ id: 'base-model' }] });
  live.models.setProvider(
    createProvider({
      id: 'dynamo',
      name: 'Dynamo',
      auth: { apiKey: envApiKeyAuth('Dynamo key', ['DYNAMO_API_KEY']) },
      models: faux.models,
      fetchModels: async () => {
        calls.fetches++;
        return [{ ...(faux.models[0] as Model<string>), id: `fetched-${calls.fetches}` }];
      },
      api: { stream: faux.stream, streamSimple: faux.streamSimple },
    }),
  );
  return calls;
}

async function start(
  live: LiveModels,
  config: Record<string, unknown> = { modelProfiles: FAKE_PROFILES },
  workspace = temp('workspace'),
) {
  await mkdir(join(workspace, '.corral'), { recursive: true });
  writeFileSync(
    join(workspace, '.corral', 'config.json'),
    JSON.stringify({ schemaVersion: '0.1', ...config }),
  );
  const server = await startCorralServer({
    workspace,
    port: 0,
    bootstrapToken: TOKEN,
    agents: new ScriptedAgentAdapter({ turns: 1 }),
    live,
  });
  servers.push(server);
  const login = await fetch(`${server.url}/api/v1/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: server.url },
    body: JSON.stringify({ token: TOKEN }),
  });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const responses: string[] = [];
  const call: typeof fetch = async (input, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set('cookie', cookie);
    headers.set('x-corral-csrf', login.headers.get('x-corral-csrf') ?? '');
    headers.set('origin', server.url);
    if (init.body) headers.set('content-type', 'application/json');
    const response = await fetch(input, { ...init, headers });
    if (!response.headers.get('content-type')?.includes('text/event-stream'))
      responses.push(await response.clone().text());
    return response;
  };
  const json = async (path: string, init?: RequestInit) => {
    const response = await call(`${server.url}/api/v1${path}`, init);
    return { status: response.status, body: await response.json() };
  };
  return { server, call, json, responses, workspace };
}
type Context = Awaited<ReturnType<typeof start>>;

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('condition not reached');
}

const providerOf = (context: Context, providerId: string) =>
  context
    .json('/model-auth')
    .then(
      (answer) =>
        (answer.body as { providerId: string }[]).find((p) => p.providerId === providerId) as
          | Record<string, unknown>
          | undefined,
    );

async function signInCopilot(context: Context, copilot: ReturnType<typeof addCopilot>) {
  const started = await context.json('/model-auth/github-copilot/login', { method: 'POST' });
  expect(started.status).toBe(202);
  expect(started.body).toEqual({
    state: 'waiting',
    authUrl: 'https://github.example.test/login/device',
    userCode: 'ABCD-1234',
    error: null,
  });
  copilot.approve();
  return until(
    () => providerOf(context, 'github-copilot'),
    (view) => view?.signedIn === true,
  );
}

async function startRun(context: Context, modelProfile: string) {
  const repo = new RestCorralRepository({ baseUrl: context.server.url, fetch: context.call });
  const definition = linearCorral(['writer']);
  for (const role of definition.roles) role.modelProfile = modelProfile;
  const saved = await repo.save({ definition, expectedDefinitionRevision: null });
  if (!saved.ok) throw new Error(saved.message);
  const transport = new HttpSseTransport({ baseUrl: context.server.url, fetch: context.call });
  const result = await transport.startRun({
    schemaVersion: '0.1',
    commandId: `cmd_${Math.random().toString(36).slice(2)}`,
    corralId: saved.record.corralId,
    definitionRevision: 1,
    mode: 'live',
  });
  return { transport, ...result };
}

describe('connection model ids', () => {
  it('uses provider:model when that is an Identifier, else a sanitized id with a hash of the original', () => {
    expect(connectionProfileId('openai', 'gpt-6-luna')).toBe('openai:gpt-6-luna');
    const slashed = connectionProfileId('router', 'vendor/name');
    expect(slashed).toMatch(/^router:vendor_name\.[a-f0-9]{8}$/);
    expect(slashed).not.toBe(connectionProfileId('router', 'vendor_name'));
    expect(connectionProfileId('router', 'vendor/name')).toBe(slashed);
    const long = connectionProfileId('router', `org/${'m'.repeat(300)}`);
    expect(long.length).toBeLessThanOrEqual(120);
    expect(long).toMatch(/\.[a-f0-9]{8}$/);
    for (const id of [slashed, long, connectionProfileId('local', 'llama3.2:latest')])
      expect(Identifier.safeParse(id).success, id).toBe(true);
  });
});

describe('connecting any provider Pi knows', () => {
  it('a Copilot sign-in in a workspace with two OpenAI profiles lists its models and starts a run with one, the config untouched', async () => {
    const fake = fakeOpenAI({ configDir: temp('config') });
    const copilot = addCopilot(fake.live);
    const context = await start(fake.live);
    const configPath = join(context.workspace, '.corral', 'config.json');
    const before = readFileSync(configPath, 'utf8');
    expect(await providerOf(context, 'github-copilot')).toBeUndefined();
    const view = await signInCopilot(context, copilot);
    expect(copilot.seen.prompts).toEqual(['']);
    expect(view).toMatchObject({
      method: 'oauth',
      subscription: true,
      modelCount: 2,
      modelFetch: null,
      login: null,
    });
    const profiles = (await context.json('/model-profiles')).body as Record<string, unknown>[];
    expect(profiles.map((p) => [p.profileId, p.source])).toEqual([
      ['model-a', 'profile'],
      ['model-b', 'profile'],
      ['github-copilot:copilot-a', 'connection'],
      [connectionProfileId('github-copilot', 'vendor/copilot-b'), 'connection'],
    ]);
    expect(profiles[2]).toMatchObject({
      provider: 'github-copilot',
      providerName: 'GitHub Copilot',
      modelId: 'copilot-a',
      modelName: 'Copilot A',
      available: true,
      method: 'oauth',
      keyConfigured: true,
    });
    expect(readFileSync(configPath, 'utf8')).toBe(before);

    const { runId, receipt, transport } = await startRun(context, 'github-copilot:copilot-a');
    expect(receipt.error).toBeUndefined();
    const events: RunEvent[] = [];
    transport.subscribe(runId ?? '', 0, { onEvent: (e) => events.push(e) });
    await waitForProjection(transport, runId ?? '', (p) => p.status !== 'running');
    await until(
      async () => events,
      (list) => list.some((e) => e.type === 'run.started'),
    );
    const started = events.find((e) => e.type === 'run.started');
    expect(started?.type === 'run.started' && started.payload.modelProfiles[0]).toMatchObject({
      profile: 'github-copilot:copilot-a',
      provider: 'github-copilot',
      modelId: 'copilot-a',
      auth: 'oauth',
    });
    expect(context.responses.join('\n')).not.toMatch(/copilot-(access|refresh)-secret/);
  });

  it('a subscription sign-in lists only the models it can call; an API key lists the API models', async () => {
    const fake = fakeOpenAI({ configDir: temp('config') });
    const context = await start(fake.live, {
      modelProfiles: [{ id: 'model-a', provider: 'openai', model: 'gpt-test-a' }],
    });
    await context.json('/model-auth/openai/login', { method: 'POST' });
    await context.json('/model-auth/openai/login/callback', {
      method: 'POST',
      body: JSON.stringify({ url: FAKE_REDIRECT_OK }),
    });
    await until(
      () => providerOf(context, 'openai'),
      (view) => view?.signedIn === true,
    );
    const ids = async () =>
      ((await context.json('/model-profiles')).body as { profileId: string }[]).map(
        (p) => p.profileId,
      );
    // model-a already names gpt-test-a, so the connection lists it only as model-a.
    expect(await ids()).toEqual(['model-a', 'openai:gpt-test-b']);
    expect((await providerOf(context, 'openai'))?.modelCount).toBe(2);
    await context.json('/model-auth/openai', { method: 'DELETE' });
    await context.json('/model-auth/openai/api-key', {
      method: 'PUT',
      body: JSON.stringify({ key: 'sk-fixture-openai' }),
    });
    expect(await ids()).toEqual(['model-a', 'openai:gpt-test-b', 'openai:gpt-test-b-api-only']);
  });

  it('signing out keeps the chosen id: requests are refused with a sign-in reason, then run again after signing in', async () => {
    const fake = fakeOpenAI({ configDir: temp('config') });
    const copilot = addCopilot(fake.live);
    const context = await start(fake.live);
    const chosen = connectionProfileId('github-copilot', 'vendor/copilot-b');
    const before = await startRun(context, chosen);
    expect(before.runId).toBeNull();
    expect(before.receipt.error?.code).toBe('CAPABILITY_DENIED');
    expect(before.receipt.error?.message).toContain('sign in to GitHub Copilot');
    await signInCopilot(context, copilot);
    expect((await startRun(context, chosen)).receipt.error).toBeUndefined();
    const out = await context.json('/model-auth/github-copilot', { method: 'DELETE' });
    expect(out.status).toBe(200);
    const listed = (await context.json('/model-profiles')).body as { profileId: string }[];
    expect(listed.map((p) => p.profileId)).not.toContain(chosen);
    const refused = await startRun(context, chosen);
    expect(refused.receipt.error?.code).toBe('CAPABILITY_DENIED');
    expect(refused.receipt.error?.message).toContain('sign in to GitHub Copilot');
    expect(refused.receipt.error?.message).not.toContain('no such model profile');
    // An id no provider can own is still an unknown profile.
    expect((await startRun(context, 'nobody:model')).receipt.error?.message).toContain(
      'no such model profile',
    );
  });

  it('the same provider and model keep the same id after a restart', async () => {
    const fake = fakeOpenAI({ configDir: temp('config') });
    const copilot = addCopilot(fake.live);
    const workspace = temp('workspace');
    const first = await start(fake.live, { modelProfiles: FAKE_PROFILES }, workspace);
    await signInCopilot(first, copilot);
    const ids = async (context: Context) =>
      ((await context.json('/model-profiles')).body as { profileId: string; source: string }[])
        .filter((p) => p.source === 'connection')
        .map((p) => p.profileId);
    const before = await ids(first);
    await first.server.close();
    servers.splice(servers.indexOf(first.server), 1);
    const again = await start(fake.live, { modelProfiles: FAKE_PROFILES }, workspace);
    expect(await ids(again)).toEqual(before);
    expect(before).toContain(connectionProfileId('github-copilot', 'vendor/copilot-b'));
  });

  it('a named profile with the same id wins over the connection model', async () => {
    const fake = fakeOpenAI({ configDir: temp('config') });
    const copilot = addCopilot(fake.live);
    const context = await start(fake.live, {
      modelProfiles: [{ id: 'github-copilot:copilot-a', provider: 'openai', model: 'gpt-test-a' }],
    });
    await signInCopilot(context, copilot);
    const profiles = (await context.json('/model-profiles')).body as Record<string, unknown>[];
    const same = profiles.filter((p) => p.profileId === 'github-copilot:copilot-a');
    expect(same).toEqual([
      expect.objectContaining({ source: 'profile', provider: 'openai', modelId: 'gpt-test-a' }),
    ]);
  });

  it('login, key and sign-out answer TARGET_NOT_FOUND for a provider Pi does not know', async () => {
    const fake = fakeOpenAI({ configDir: temp('config') });
    const context = await start(fake.live);
    for (const [path, init] of [
      ['/model-auth/nobody/login', { method: 'POST' }],
      ['/model-auth/nobody/api-key', { method: 'PUT', body: JSON.stringify({ key: 'sk-x' }) }],
      ['/model-auth/nobody', { method: 'DELETE' }],
      ['/model-auth/nobody/models/refresh', { method: 'POST', body: '{"revision":"x"}' }],
    ] as const) {
      const answer = await context.json(path, init);
      expect(answer.status, path).toBe(404);
      expect(answer.body.error.code).toBe('TARGET_NOT_FOUND');
    }
  });

  it('a key for a provider that needs more than the key is refused and not stored; the reason names what is missing', async () => {
    const fake = fakeOpenAI({ configDir: temp('config') });
    fake.live.models.setProvider(cloudflareWorkersAIProvider());
    fake.live.models.setProvider(cloudflareAIGatewayProvider());
    const context = await start(fake.live);
    for (const [id, missing] of [
      ['cloudflare-workers-ai', /account ID/],
      ['cloudflare-ai-gateway', /AI Gateway ID/],
    ] as const) {
      const answer = await context.json(`/model-auth/${id}/api-key`, {
        method: 'PUT',
        body: JSON.stringify({ key: 'cf-fixture-secret' }),
      });
      expect(answer.status, id).toBe(501);
      expect(answer.body.error.code).toBe('COMMAND_NOT_SUPPORTED');
      expect(answer.body.error.message).toMatch(missing);
      expect(await fake.credentials.read(id)).toBeUndefined();
      expect(await providerOf(context, id)).toBeUndefined();
    }
    expect(context.responses.join('\n')).not.toContain('cf-fixture-secret');
  });

  it('Anthropic offers the sign-in methods Pi gives it, like every other provider', async () => {
    const fake = fakeOpenAI({ configDir: temp('config') });
    const context = await start(fake.live);
    const catalog = (await context.json('/model-catalog')).body as {
      providerId: string;
      methods: unknown;
    }[];
    expect(catalog.find((p) => p.providerId === 'anthropic')?.methods).toEqual({
      oauth: true,
      apiKey: true,
    });
    // The subscription sign-in starts like any provider's and its models are listed.
    const login = await context.json('/model-auth/anthropic/login', { method: 'POST' });
    expect(login.status).toBe(202);
    expect(login.body).toMatchObject({ state: 'waiting', authUrl: expect.any(String) });
    await context.json('/model-auth/anthropic/login/callback', {
      method: 'POST',
      body: JSON.stringify({ url: FAKE_REDIRECT_OK }),
    });
    const signedIn = await until(
      () => providerOf(context, 'anthropic'),
      (view) => view?.signedIn === true,
    );
    expect(signedIn).toMatchObject({ method: 'oauth', subscription: true, modelCount: 1 });
    const ids = async () =>
      ((await context.json('/model-profiles')).body as { profileId: string }[]).map(
        (p) => p.profileId,
      );
    expect(await ids()).toContain('anthropic:claude-test');
    // A pasted subscription token is a key like any other: it connects and lists the models.
    await context.json('/model-auth/anthropic', { method: 'DELETE' });
    expect(await ids()).not.toContain('anthropic:claude-test');
    const pasted = await context.json('/model-auth/anthropic/api-key', {
      method: 'PUT',
      body: JSON.stringify({ key: 'sk-ant-oat01-fixture-secret' }),
    });
    expect(pasted.status).toBe(200);
    expect(await providerOf(context, 'anthropic')).toMatchObject({
      signedIn: true,
      method: 'api_key',
    });
    expect(await ids()).toContain('anthropic:claude-test');
    expect(context.responses.join('\n')).not.toMatch(/sk-ant-oat01|anthropic-(access|refresh)/);
  });

  it('checking status never refreshes an OAuth token', async () => {
    const fake = fakeOpenAI({ configDir: temp('config') });
    const copilot = addCopilot(fake.live);
    const context = await start(fake.live);
    await signInCopilot(context, copilot);
    await fake.credentials.modify('github-copilot', async (current) =>
      current?.type === 'oauth' ? { ...current, expires: Date.now() - 1000 } : current,
    );
    for (let i = 0; i < 3; i++) {
      await context.json('/model-auth');
      await context.json('/model-profiles');
    }
    expect(copilot.seen.refreshes).toBe(0);
  });

  it('a provider with a dynamic list is refreshed right after connecting and at server start', async () => {
    const fake = fakeOpenAI({ configDir: temp('config') });
    const dynamic = addDynamic(fake.live);
    const workspace = temp('workspace');
    const context = await start(fake.live, { modelProfiles: FAKE_PROFILES }, workspace);
    expect(dynamic.fetches).toBe(0);
    await context.json('/model-auth/dynamo/api-key', {
      method: 'PUT',
      body: JSON.stringify({ key: 'dynamo-fixture-key' }),
    });
    const connected = await until(
      async () => (await context.json('/model-profiles')).body as { modelId: string }[],
      (list) => list.some((p) => p.modelId === 'fetched-1'),
    );
    expect(connected.map((p) => p.modelId)).toEqual(
      expect.arrayContaining(['base-model', 'fetched-1']),
    );
    await context.server.close();
    servers.splice(servers.indexOf(context.server), 1);
    const again = await start(fake.live, { modelProfiles: FAKE_PROFILES }, workspace);
    await until(
      async () => (await again.json('/model-profiles')).body as { modelId: string }[],
      (list) => list.some((p) => p.modelId === 'fetched-2'),
    );
    expect(dynamic.fetches).toBe(2);
  });
});

describe('the borrowed Codex CLI login', () => {
  /** OpenAI and Codex as Pi has them, with a Codex CLI login on disk and Corral's own store. */
  async function withCodexLogin(profiles: ProfileConfig[] = []) {
    const dir = temp('codex');
    const codexPath = join(dir, 'auth.json');
    writeFileSync(
      codexPath,
      JSON.stringify({ tokens: { access_token: FAKE_CODEX_ACCESS, account_id: 'acct-test' } }),
      { mode: 0o600 },
    );
    const own = new FileCredentialStore(join(dir, 'own'));
    const credentials = new LayeredCredentialStore(own, codexPath);
    const models = createModels({
      credentials,
      authContext: { env: async () => undefined, fileExists: async () => false },
    });
    for (const [id, name] of [
      ['openai', 'OpenAI'],
      ['openai-codex', 'OpenAI Codex (legacy)'],
    ] as const) {
      const faux = createFauxCore({
        provider: id,
        models: [{ id: 'gpt-x' }, { id: 'gpt-y' }],
      });
      models.setProvider(
        createProvider({
          id,
          name,
          auth: {
            apiKey: envApiKeyAuth(`${name} API key`, []),
            oauth: {
              name,
              isSubscription: true,
              async login() {
                throw new Error('not in this test');
              },
              async refresh(credential) {
                return credential;
              },
              async toAuth(credential) {
                return { apiKey: credential.access };
              },
            },
          },
          models: faux.models,
          api: { stream: faux.stream, streamSimple: faux.streamSimple },
        }),
      );
    }
    const registry = new ModelRegistry(models, profiles, {
      credentials,
      getDeviceId: () => 'device',
    });
    await registry.refreshStatus();
    const signInToOpenAI = async () => {
      await own.modify('openai', async () => ({
        type: 'oauth',
        access: 'openai-access-secret',
        refresh: 'openai-refresh-secret',
        expires: Date.now() + 3_600_000,
      }));
      await registry.refreshStatus();
    };
    return { registry, signInToOpenAI };
  }
  const connections = (registry: ModelRegistry) =>
    registry
      .profilesView()
      .filter((view) => view.source === 'connection')
      .map((view) => view.profileId);

  it('is a connection only while Corral has no OpenAI sign-in of its own; the same models are not listed twice', async () => {
    const { registry, signInToOpenAI } = await withCodexLogin();
    expect(connections(registry)).toEqual(['openai-codex:gpt-x', 'openai-codex:gpt-y']);
    expect(registry.authView().map((view) => [view.providerId, view.source])).toEqual([
      ['openai-codex', 'codex-cli'],
    ]);
    await signInToOpenAI();
    expect(connections(registry)).toEqual(['openai:gpt-x', 'openai:gpt-y']);
    expect(registry.authView().map((view) => [view.providerId, view.source])).toEqual([
      ['openai', 'corral'],
    ]);
    // The list and a stored choice agree: the borrowed login's model is not offered now.
    const stored = registry.resolve('openai-codex:gpt-x', 'live');
    expect(stored).toMatchObject({ ok: false, code: 'CAPABILITY_DENIED' });
    expect(stored.ok ? '' : stored.reason).toMatch(/OpenAI sign-in/);
    expect(JSON.stringify([registry.authView(), registry.profilesView()])).not.toMatch(
      /secret|FAKE|acct-test/,
    );
  });

  it('a profile that names openai-codex still runs on the borrowed login', async () => {
    const { registry, signInToOpenAI } = await withCodexLogin([
      { id: 'codex', provider: 'openai-codex', model: 'gpt-x' },
    ]);
    await signInToOpenAI();
    expect(registry.resolve('codex', 'live')).toMatchObject({
      ok: true,
      snapshot: { provider: 'openai-codex', modelId: 'gpt-x', auth: 'oauth' },
    });
    expect(registry.profilesView().map((view) => view.profileId)).toEqual([
      'codex',
      'openai:gpt-x',
      'openai:gpt-y',
    ]);
    // Shown as the provider the profile uses; it lists no models of its own.
    expect(registry.authView().find((view) => view.providerId === 'openai-codex')).toMatchObject({
      signedIn: true,
      source: 'codex-cli',
      modelCount: 0,
    });
  });
});

describe('a provider whose list Pi fetches', () => {
  it('a stored choice says the list is not loaded yet until the refresh finishes', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const credentials = new InMemoryCredentialStore();
    const models = createModels({
      credentials,
      authContext: { env: async () => undefined, fileExists: async () => false },
    });
    const faux = createFauxCore({ provider: 'dynamo', models: [{ id: 'base-model' }] });
    models.setProvider(
      createProvider({
        id: 'dynamo',
        name: 'Dynamo',
        auth: { apiKey: envApiKeyAuth('Dynamo key', ['DYNAMO_API_KEY']) },
        models: faux.models,
        fetchModels: async () => {
          await held;
          return [{ ...(faux.models[0] as Model<string>), id: 'fetched' }];
        },
        api: { stream: faux.stream, streamSimple: faux.streamSimple },
      }),
    );
    await credentials.modify('dynamo', async () => ({ type: 'api_key', key: 'dynamo-key' }));
    const registry = new ModelRegistry(models, [], { credentials, getDeviceId: () => 'device' });
    await registry.refreshStatus();
    registry.refreshDynamicProviders();
    const early = registry.resolve('dynamo:fetched', 'live');
    expect(early).toMatchObject({ ok: false, code: 'CAPABILITY_DENIED' });
    expect(early.ok ? '' : early.reason).toMatch(/Dynamo model list is not loaded yet/);
    release();
    await registry.idle();
    expect(registry.resolve('dynamo:fetched', 'live').ok).toBe(true);
    // Once the list is loaded, a model it does not have is an unknown profile.
    expect(registry.resolve('dynamo:gone', 'live')).toMatchObject({
      ok: false,
      reason: 'no such model profile',
    });
  });
});

describe('profile limits', () => {
  it('25 profiles are saved and read back', async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      id: `profile-${i}`,
      provider: 'openai',
      model: 'gpt-test-a',
    }));
    expect(parseWorkspaceConfig({ schemaVersion: '0.1', modelProfiles: many }).ok).toBe(true);
    const fake = fakeOpenAI({ configDir: temp('config') });
    const context = await start(fake.live);
    const { revision } = (await context.json('/model-config')).body;
    const saved = await context.json('/model-config', {
      method: 'PUT',
      body: JSON.stringify({ revision, modelProfiles: many, modelProviders: [] }),
    });
    expect(saved.status).toBe(200);
    expect((await context.json('/model-config')).body.modelProfiles).toHaveLength(25);
    expect(
      ((await context.json('/model-profiles')).body as { source: string }[]).filter(
        (p) => p.source === 'profile',
      ),
    ).toHaveLength(25);
  });
});

describe('endpoint models over HTTP', () => {
  const ROUTER = {
    id: 'router',
    name: 'Router',
    baseUrl: 'https://router.example.test/v1',
    access: 'api_key',
  };

  it('saving an address and a key lists the endpoint models; refresh checks the revision', async () => {
    const seen: { url: string; authorization: string | null }[] = [];
    const fake = fakeOpenAI({
      configDir: temp('config'),
      fetch: async (input, init) => {
        const url = String(input);
        seen.push({ url, authorization: new Headers(init?.headers).get('authorization') });
        if (url === 'https://router.example.test/v1/models')
          return new Response(
            JSON.stringify({
              data: [
                { id: 'vendor/alpha', context_length: 100000, supported_parameters: ['reasoning'] },
                { id: 'beta' },
              ],
            }),
          );
        throw new Error('offline');
      },
    });
    const context = await start(fake.live, {
      modelProfiles: FAKE_PROFILES,
      modelProviders: [ROUTER],
    });
    expect(seen).toEqual([]);
    const { revision } = (await context.json('/model-config')).body;
    const saved = await context.json('/model-auth/router/api-key', {
      method: 'PUT',
      body: JSON.stringify({ key: 'fixture-router-key', revision }),
    });
    expect(saved.status).toBe(200);
    const router = await until(
      () => providerOf(context, 'router'),
      (view) => (view?.modelFetch as { kind?: string } | null)?.kind === 'connected',
    );
    expect(router).toMatchObject({ modelCount: 2, signedIn: true });
    const profiles = (await context.json('/model-profiles')).body as Record<string, unknown>[];
    expect(profiles.filter((p) => p.provider === 'router')).toEqual([
      expect.objectContaining({
        profileId: connectionProfileId('router', 'vendor/alpha'),
        source: 'connection',
        contextWindow: 100000,
        reasoningCapabilities: expect.objectContaining({ levels: ['low', 'medium', 'high'] }),
      }),
      expect.objectContaining({ profileId: 'router:beta', source: 'connection' }),
    ]);
    const file = JSON.parse(
      readFileSync(join(context.workspace, '.corral', 'config.json'), 'utf8'),
    );
    expect(file.modelProviders[0].models ?? []).toEqual([]);
    // models.dev was tried once (offline here); the endpoint got exactly one GET with its key.
    expect(seen.filter((r) => r.url.startsWith('https://router'))).toEqual([
      { url: 'https://router.example.test/v1/models', authorization: 'Bearer fixture-router-key' },
    ]);
    expect(seen.filter((r) => r.url.includes('models.dev'))).toHaveLength(1);

    const refresh = (body: unknown) =>
      context.json('/model-auth/router/models/refresh', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    expect((await refresh({ revision: 'stale' })).status).toBe(409);
    const refreshed = await refresh({ revision });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body).toEqual({
      kind: 'connected',
      status: 200,
      fetchedAt: expect.any(String),
      modelCount: 2,
    });
    const builtin = await context.json('/model-auth/openai/models/refresh', {
      method: 'POST',
      body: JSON.stringify({ revision }),
    });
    expect(builtin.status).toBe(501);
    expect(context.responses.join('\n')).not.toContain('fixture-router-key');
    const catalog = (await context.json('/model-catalog')).body as {
      providerId: string;
      models: { id: string; limits?: unknown }[];
    }[];
    expect(catalog.find((p) => p.providerId === 'router')?.models[0]).toMatchObject({
      id: 'vendor/alpha',
      limits: {
        contextWindow: { value: 100000, source: 'response' },
        reasoning: { value: true, source: 'response' },
      },
    });
  });

  it('signing out removes a key left for an endpoint the config no longer has', async () => {
    const fake = fakeOpenAI({ configDir: temp('config') });
    const context = await start(fake.live, {
      modelProfiles: FAKE_PROFILES,
      modelProviders: [ROUTER],
    });
    await context.json('/model-auth/router/api-key', {
      method: 'PUT',
      body: JSON.stringify({ key: 'fixture-router-key' }),
    });
    expect(await fake.credentials.read('router')).toBeDefined();
    const { revision } = (await context.json('/model-config')).body;
    const saved = await context.json('/model-config', {
      method: 'PUT',
      body: JSON.stringify({ revision, modelProfiles: FAKE_PROFILES, modelProviders: [] }),
    });
    expect(saved.status).toBe(200);
    const removed = await context.json('/model-auth/router', { method: 'DELETE' });
    expect(removed.status).toBe(200);
    expect(await fake.credentials.read('router')).toBeUndefined();
    // Neither a known provider nor a stored key: still not found.
    const again = await context.json('/model-auth/router', { method: 'DELETE' });
    expect(again.status).toBe(404);
    expect(again.body.error.code).toBe('TARGET_NOT_FOUND');
    expect(context.responses.join('\n')).not.toContain('fixture-router-key');
  });

  it('saving the reasoning judgment settings while the models are fetched keeps the fetched list', async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const arrived = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const fake = fakeOpenAI({
      configDir: temp('config'),
      fetch: async (input) => {
        if (String(input) !== 'https://router.example.test/v1/models') throw new Error('offline');
        entered();
        await released;
        return new Response(JSON.stringify({ data: [{ id: 'alpha' }] }));
      },
    });
    const context = await start(fake.live, {
      modelProfiles: FAKE_PROFILES,
      modelProviders: [ROUTER],
    });
    await context.json('/model-auth/router/api-key', {
      method: 'PUT',
      body: JSON.stringify({ key: 'fixture-router-key' }),
    });
    await arrived;
    const { revision } = (await context.json('/effort-routing')).body;
    const saved = await context.json('/effort-routing', {
      method: 'PUT',
      body: JSON.stringify({ settings: { mode: 'off' }, revision }),
    });
    expect(saved.status).toBe(200);
    expect(saved.body.revision).not.toBe(revision);
    release();
    const router = await until(
      () => providerOf(context, 'router'),
      (view) => (view?.modelFetch as { kind?: string } | null)?.kind === 'connected',
    );
    expect(router).toMatchObject({ modelCount: 1 });
  });
});
