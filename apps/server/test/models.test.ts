import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpSseTransport, RestCorralRepository } from '@corral/client';
import type { RunEvent } from '@corral/contracts';
import { waitForProjection } from '@corral/core';
import { linearCorral, ScriptedAgentAdapter } from '@corral/testkit';
import { startCompatibleEndpoint } from '@corral/testkit/endpoint';
import { afterEach, describe, expect, it } from 'vitest';
import { type CorralServer, startCorralServer } from '../src/index.ts';
import { assertOutsideWorkspace } from '../src/models/index.ts';
import { FAKE_PROFILES, FAKE_REDIRECT_BAD, FAKE_REDIRECT_OK, fakeOpenAI } from '../src/testing.ts';

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

function makeFake(options: { env?: Record<string, string>; reasoningApi?: boolean } = {}) {
  const made = fakeOpenAI({ ...options, configDir: temp('config') });
  return { ...made, respond: () => made.answerWith('Live answer.') };
}

async function start(
  fake: ReturnType<typeof makeFake>,
  profiles: { id: string; provider: string; model: string }[] = FAKE_PROFILES,
  extra: Record<string, unknown> = {},
  workspace = temp('workspace'),
) {
  await mkdir(join(workspace, '.corral'), { recursive: true });
  writeFileSync(
    join(workspace, '.corral', 'config.json'),
    JSON.stringify({
      schemaVersion: '0.1',
      modelProfiles: profiles,
      ...extra,
    }),
  );
  const server = await startCorralServer({
    workspace,
    port: 0,
    bootstrapToken: TOKEN,
    agents: new ScriptedAgentAdapter({ turns: 1 }),
    live: fake.live,
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
    // Record every answer for the leak checks; an event stream never ends, so not those.
    if (!response.headers.get('content-type')?.includes('text/event-stream')) {
      responses.push(await response.clone().text());
    }
    return response;
  };
  const json = async (path: string, init?: RequestInit) => {
    const response = await call(`${server.url}/api/v1${path}`, init);
    return { status: response.status, body: await response.json() };
  };
  return { server, call, json, responses, workspace };
}

async function signIn(json: Awaited<ReturnType<typeof start>>['json']) {
  const started = await json('/model-auth/openai/login', { method: 'POST' });
  expect(started.status).toBe(202);
  await json('/model-auth/openai/login/callback', {
    method: 'POST',
    body: JSON.stringify({ url: FAKE_REDIRECT_OK }),
  });
  for (let i = 0; i < 100; i++) {
    const [openai] = (await json('/model-auth')).body;
    if (openai.signedIn) return openai;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('sign-in did not finish');
}

async function liveRun(context: Awaited<ReturnType<typeof start>>) {
  const repo = new RestCorralRepository({ baseUrl: context.server.url, fetch: context.call });
  const saved = await repo.save({
    definition: linearCorral(['writer']),
    layout: { nodes: {}, viewport: { x: 0, y: 0, zoom: 1 } },
    expectedDefinitionRevision: null,
  });
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

describe('model sign-in and profiles (C-058, ADR-019)', () => {
  it('[TC-SEC-002-H] signs in through the provider flow and shows status, never tokens', async () => {
    const fake = makeFake();
    const context = await start(fake);
    const before = await context.json('/model-auth');
    expect(before.body).toEqual([
      expect.objectContaining({ providerId: 'openai', signedIn: false, method: null, login: null }),
    ]);

    const started = await context.json('/model-auth/openai/login', { method: 'POST' });
    expect(started.body).toEqual({
      state: 'waiting',
      authUrl: 'https://auth.example.test/authorize?state=s1',
      error: null,
    });
    const openai = await signIn(context.json);
    expect(openai).toMatchObject({ method: 'oauth', subscription: true, login: null });
    expect(Date.parse(openai.expiresAt)).toBeGreaterThan(Date.now());
    expect(fake.seen.agentNames).toEqual(['Corral']);
    expect(fake.seen.deviceIds).toEqual(['00000000-0000-4000-8000-000000000001']);

    const profiles = await context.json('/model-profiles');
    expect(profiles.body).toEqual([
      expect.objectContaining({
        profileId: 'model-a',
        modelId: 'gpt-test-a',
        modelName: 'Test A',
        available: true,
        reasoning: true,
        contextWindow: 1000,
        maxOutputTokens: 500,
        method: 'oauth',
        keyConfigured: true,
      }),
      expect.objectContaining({ profileId: 'model-b', modelId: 'gpt-test-b' }),
    ]);

    // The credential lives in the user's config dir, private to them, outside the workspace.
    const file = join(fake.configDir, 'credentials.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf-8')).toContain('access-1-secret');
    expect(() => assertOutsideWorkspace(join(context.workspace, 'x'), context.workspace)).toThrow();
    expect(context.responses.join('\n')).not.toMatch(/secret/);
  });

  it('[TC-SEC-002-N] a failed sign-in says so plainly, without the provider response body', async () => {
    const context = await start(makeFake());
    await context.json('/model-auth/openai/login', { method: 'POST' });
    await context.json('/model-auth/openai/login/callback', {
      method: 'POST',
      body: JSON.stringify({ url: FAKE_REDIRECT_BAD }),
    });
    let login = null;
    for (let i = 0; i < 100 && login?.state !== 'failed'; i++) {
      login = (await context.json('/model-auth')).body[0].login;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(login).toEqual({
      state: 'failed',
      authUrl: 'https://auth.example.test/authorize?state=s1',
      error: 'The provider refused the sign-in. Try again.',
    });
    expect(context.responses.join('\n')).not.toContain('leaked-body');
  });

  it('refuses a live run before sign-in and runs it after, pinning the model', async () => {
    const fake = makeFake();
    fake.respond();
    const context = await start(fake);
    const refused = await liveRun(context);
    expect(refused.runId).toBeNull();
    expect(refused.receipt.error?.code).toBe('CAPABILITY_DENIED');
    expect(refused.receipt.error?.message).toContain('Settings → Models');

    await signIn(context.json);
    const { transport, runId } = await liveRun(context);
    const events: RunEvent[] = [];
    transport.subscribe(runId ?? '', 0, { onEvent: (e) => events.push(e) });
    const final = await waitForProjection(transport, runId ?? '', (p) => p.status !== 'running');
    expect(final.status).toBe('succeeded');
    // The list comes from its own stream; let it catch up with the final projection.
    while (events.length < final.lastSeq) await new Promise((r) => setTimeout(r, 10));
    const startedEvent = events.find((e) => e.type === 'run.started');
    expect(startedEvent?.type === 'run.started' && startedEvent.payload.modelProfiles).toEqual([
      {
        profile: 'model-a',
        provider: 'openai',
        modelId: 'gpt-test-a',
        auth: 'oauth',
        reasoning: { levels: [], providerDefault: false },
      },
    ]);
    // The worker received the access token per request, and no event carries it.
    expect(fake.seen.tokens.length).toBeGreaterThan(0);
    expect(fake.seen.tokens.every((t) => t === 'access-1-secret')).toBe(true);
    expect(JSON.stringify(events)).not.toContain('secret');
  });

  it('refreshes an expired token before the request, and keeps the refresh token on the host', async () => {
    const fake = makeFake();
    fake.respond();
    const context = await start(fake);
    await signIn(context.json);
    await fake.credentials.modify('openai', async (current) =>
      current?.type === 'oauth' ? { ...current, expires: Date.now() - 1000 } : current,
    );
    const { transport, runId } = await liveRun(context);
    const final = await waitForProjection(transport, runId ?? '', (p) => p.status !== 'running');
    expect(final.status).toBe('succeeded');
    expect(fake.seen.refreshes).toBe(1);
    expect(fake.seen.tokens[0]).toBe('access-2-secret');
    expect(fake.seen.tokens).not.toContain('refresh-2-secret');
  });

  it('signs out: the credential is removed and live runs are refused again', async () => {
    const fake = makeFake();
    const context = await start(fake);
    await signIn(context.json);
    const out = await context.json('/model-auth/openai', { method: 'DELETE' });
    expect(out.status).toBe(200);
    expect(out.body[0]).toMatchObject({ signedIn: false, method: null });
    expect(readFileSync(join(fake.configDir, 'credentials.json'), 'utf-8')).not.toContain('access');
    expect((await liveRun(context)).receipt.error?.code).toBe('CAPABILITY_DENIED');
  });

  it('refuses, before the run, a model the subscription sign-in cannot use', async () => {
    const fake = makeFake();
    const context = await start(fake, [
      { id: 'model-a', provider: 'openai', model: 'gpt-test-a' },
      { id: 'model-b', provider: 'openai', model: 'gpt-test-b-api-only' },
    ]);
    await signIn(context.json);
    const profiles = (await context.json('/model-profiles')).body;
    expect(
      profiles.map((p: { subscriptionSupported: boolean | null }) => p.subscriptionSupported),
    ).toEqual([true, false]);
    const repo = new RestCorralRepository({ baseUrl: context.server.url, fetch: context.call });
    const definition = linearCorral(['writer']);
    for (const role of definition.roles) role.modelProfile = 'model-b';
    const saved = await repo.save({
      definition,
      layout: { nodes: {}, viewport: { x: 0, y: 0, zoom: 1 } },
      expectedDefinitionRevision: null,
    });
    if (!saved.ok) throw new Error(saved.message);
    const transport = new HttpSseTransport({ baseUrl: context.server.url, fetch: context.call });
    const { runId, receipt } = await transport.startRun({
      schemaVersion: '0.1',
      commandId: 'cmd_api_only',
      corralId: saved.record.corralId,
      definitionRevision: 1,
      mode: 'live',
    });
    expect(runId).toBeNull();
    expect(receipt.error?.code).toBe('CAPABILITY_DENIED');
    expect(receipt.error?.message).toContain(
      'gpt-test-b-api-only is not available with a subscription sign-in',
    );
    expect(receipt.error?.message).toContain('gpt-test-a');
  });

  it('accepts an API key from the server environment and never shows it', async () => {
    const context = await start(makeFake({ env: { OPENAI_API_KEY: 'sk-env-key-secret' } }));
    const [openai] = (await context.json('/model-auth')).body;
    expect(openai).toMatchObject({ signedIn: true, method: 'api_key', subscription: false });
    expect(context.responses.join('\n')).not.toContain('sk-env-key-secret');
  });
});

describe('API keys and OpenAI-compatible endpoints (CR-005)', () => {
  const setKey = (json: Awaited<ReturnType<typeof start>>['json'], provider: string, key: string) =>
    json(`/model-auth/${provider}/api-key`, { method: 'PUT', body: JSON.stringify({ key }) });

  async function finish(context: Awaited<ReturnType<typeof start>>) {
    const { transport, runId, receipt } = await liveRun(context);
    if (!runId) return { status: 'refused', message: receipt.error?.message ?? '' };
    const final = await waitForProjection(transport, runId, (p) => p.status !== 'running');
    return { status: final.status, message: '' };
  }

  const endpointConfig = (baseUrl: string, access: 'api_key' | 'none') => ({
    modelProviders: [
      {
        id: 'local',
        name: 'Local server',
        baseUrl,
        access,
        models: [{ id: 'llama3.2', contextWindow: 8000, maxOutput: 512 }],
      },
    ],
  });
  const LOCAL_PROFILES = [{ id: 'model-a', provider: 'local', model: 'llama3.2' }];

  function scriptEndpoint(endpoint: Awaited<ReturnType<typeof startCompatibleEndpoint>>) {
    endpoint.setReply((body) => {
      const written = [...JSON.stringify(body).matchAll(/artv_[a-f0-9]{32}/g)].at(-1)?.[0];
      if (!written)
        return { toolCall: { name: 'write_artifact', args: { text: 'Local answer.' } } };
      return { toolCall: { name: 'submit_result', args: { artifactVersionIds: [written] } } };
    });
  }

  it('[TC-SEC-002-H] an API key entered in Settings is used for live runs and never shown', async () => {
    const fake = makeFake();
    fake.respond();
    const context = await start(fake);
    const saved = await setKey(context.json, 'openai', 'sk-entered-key-secret');
    expect(saved.status).toBe(200);
    expect(saved.body[0]).toMatchObject({ signedIn: true, method: 'api_key', source: 'corral' });
    expect((await finish(context)).status).toBe('succeeded');
    expect(fake.seen.tokens.every((t) => t === 'sk-entered-key-secret')).toBe(true);
    expect(context.responses.join('\n')).not.toContain('sk-entered-key-secret');
    const file = join(fake.configDir, 'credentials.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);

    const removed = await context.json('/model-auth/openai', { method: 'DELETE' });
    expect(removed.body[0]).toMatchObject({ signedIn: false, method: null });
    expect(readFileSync(file, 'utf-8')).not.toContain('sk-entered-key-secret');
    expect((await finish(context)).status).toBe('refused');
  });

  it('[TC-SEC-002-N] refuses an empty or oversized key, a provider no profile uses, and Anthropic subscription sign-in', async () => {
    const context = await start(makeFake(), [
      ...FAKE_PROFILES,
      { id: 'claude', provider: 'anthropic', model: 'claude-test' },
    ]);
    expect((await setKey(context.json, 'openai', '')).status).toBe(400);
    expect((await setKey(context.json, 'openai', 'x'.repeat(2000))).status).toBe(400);
    expect((await setKey(context.json, 'nobody', 'sk-x')).status).toBe(404);
    const login = await context.json('/model-auth/anthropic/login', { method: 'POST' });
    expect(login.status).toBe(501);
    expect(login.body.error).toMatchObject({ code: 'COMMAND_NOT_SUPPORTED' });
    expect(login.body.error.message).toMatch(/API key/);
    const anthropic = (await context.json('/model-auth')).body.find(
      (p: { providerId: string }) => p.providerId === 'anthropic',
    );
    expect(anthropic).toMatchObject({ methods: { oauth: false, apiKey: true } });
  });

  it('[TC-SEC-002-H] a keyless local endpoint runs without a key; a keyed one gets the entered key', async () => {
    const endpoint = await startCompatibleEndpoint();
    try {
      scriptEndpoint(endpoint);
      const keyless = await start(
        makeFake(),
        LOCAL_PROFILES,
        endpointConfig(endpoint.baseUrl, 'none'),
      );
      const [local] = (await keyless.json('/model-auth')).body;
      expect(local).toMatchObject({
        providerId: 'local',
        name: 'Local server',
        signedIn: true,
        method: 'none',
        endpoint: new URL(endpoint.baseUrl).host,
        methods: { oauth: false, apiKey: false },
      });
      expect((await finish(keyless)).status).toBe('succeeded');
      expect(endpoint.authorizations.every((a) => a === 'Bearer no-key')).toBe(true);

      const before = endpoint.authorizations.length;
      const keyed = await start(
        makeFake(),
        LOCAL_PROFILES,
        endpointConfig(endpoint.baseUrl, 'api_key'),
      );
      expect((await finish(keyed)).status).toBe('refused');
      expect(endpoint.authorizations.length).toBe(before);
      await setKey(keyed.json, 'local', 'sk-local-secret');
      expect((await finish(keyed)).status).toBe('succeeded');
      expect(
        endpoint.authorizations.slice(before).every((a) => a === 'Bearer sk-local-secret'),
      ).toBe(true);
      expect(keyed.responses.join('\n')).not.toContain('sk-local-secret');
    } finally {
      await endpoint.close();
    }
  });

  it('[TC-SEC-002-N] a key stays with the address it was entered for: a config pointing elsewhere does not get it', async () => {
    const first = await startCompatibleEndpoint();
    const second = await startCompatibleEndpoint();
    try {
      scriptEndpoint(first);
      scriptEndpoint(second);
      const fake = makeFake();
      const workspace = temp('workspace');
      const context = await start(
        fake,
        LOCAL_PROFILES,
        endpointConfig(first.baseUrl, 'api_key'),
        workspace,
      );
      await setKey(context.json, 'local', 'sk-bound-secret');
      await context.server.close();
      servers.splice(servers.indexOf(context.server), 1);
      // The same config directory (same stored key), but the workspace now names another host.
      const moved = await start(
        fake,
        LOCAL_PROFILES,
        endpointConfig(second.baseUrl, 'api_key'),
        workspace,
      );
      const [local] = (await moved.json('/model-auth')).body;
      expect(local).toMatchObject({ signedIn: false, endpointChanged: true });
      const result = await finish(moved);
      expect(result.status).toBe('refused');
      expect(second.authorizations).toEqual([]);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it('[TC-SEC-002-N] an endpoint may not take the name of a built-in provider', async () => {
    const clash = endpointConfig('https://x.test/v1', 'api_key');
    const provider = { ...clash.modelProviders[0], id: 'openai' };
    await expect(start(makeFake(), FAKE_PROFILES, { modelProviders: [provider] })).rejects.toThrow(
      /modelProviders/,
    );
  });
});

describe('team drafts from a goal (CR-006)', () => {
  const PLAN = {
    name: 'Help desk vendors',
    pattern: 'research_write_review',
    brief: 'Compare three help desk vendors.',
    criteria: ['Name the source behind each main claim.'],
    roles: [
      { slot: 'researcher', name: 'Analyst', duty: 'Collect pricing and limits.' },
      { slot: 'writer', name: 'Author', duty: 'Write the comparison.' },
      { slot: 'reviewer', name: 'Critic', duty: 'Check each claim.' },
    ],
    reviewRounds: 2,
    finalApproval: true,
  };
  const draft = (json: Awaited<ReturnType<typeof start>>['json'], goal: string) =>
    json('/team-drafts', { method: 'POST', body: JSON.stringify({ goal }) });

  it('[TC-UX-003-H] asks the first profile’s model once, with an output cap, and returns the checked plan', async () => {
    const fake = makeFake();
    const context = await start(fake);
    await signIn(context.json);
    fake.replyText(`Here is the team:\n\`\`\`json\n${JSON.stringify(PLAN)}\n\`\`\``);
    const answer = await draft(context.json, 'Compare three help desk vendors.');
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      plan: PLAN,
      model: { provider: 'openai', modelId: 'gpt-test-a' },
    });
    expect(fake.seen.hostRequests).toHaveLength(1);
    expect(fake.seen.hostRequests[0]?.maxTokens).toBe(1500);
    expect(fake.seen.hostRequests[0]?.text).toContain('Compare three help desk vendors.');
    expect(context.responses.join('\n')).not.toContain('secret');
  });

  it('[TC-UX-003-N] an answer that does not fit is refused without its text; no sign-in, no live models and long goals are refused', async () => {
    const fake = makeFake();
    const context = await start(fake);
    expect((await draft(context.json, 'Compare vendors.')).status).toBe(403);
    await signIn(context.json);
    for (const reply of [
      'I cannot help with that, but here is a poem: roses-are-red',
      JSON.stringify({ ...PLAN, roles: PLAN.roles.slice(0, 1) }),
      JSON.stringify({ ...PLAN, tools: ['shell'] }),
    ]) {
      fake.replyText(reply);
      const answer = await draft(context.json, 'Compare vendors.');
      expect(answer.status).toBe(502);
      expect(answer.body.error.code).toBe('MODEL_UNAVAILABLE');
      expect(JSON.stringify(answer.body)).not.toContain('roses-are-red');
      expect(JSON.stringify(answer.body)).not.toContain('shell');
    }
    expect((await draft(context.json, '')).status).toBe(400);
    expect((await draft(context.json, 'x'.repeat(2001))).status).toBe(400);

    const workspace = temp('workspace');
    const server = await startCorralServer({
      workspace,
      port: 0,
      bootstrapToken: TOKEN,
      agents: new ScriptedAgentAdapter({ turns: 1 }),
    });
    servers.push(server);
    const session = await fetch(`${server.url}/api/v1/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: server.url },
      body: JSON.stringify({ token: TOKEN }),
    });
    const noLive = await fetch(`${server.url}/api/v1/team-drafts`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: server.url,
        cookie: (session.headers.get('set-cookie') ?? '').split(';')[0] ?? '',
        'x-corral-csrf': session.headers.get('x-corral-csrf') ?? '',
      },
      body: JSON.stringify({ goal: 'Compare vendors.' }),
    });
    expect(noLive.status).toBe(501);
  });
});

describe('editing profiles and endpoints from the Models page (CR-008)', () => {
  const configOf = (workspace: string) =>
    JSON.parse(readFileSync(join(workspace, '.corral', 'config.json'), 'utf-8'));

  it('[TC-SEC-002-H] lists the catalog without credentials, and saving changes only the two model keys', async () => {
    const fake = makeFake();
    fake.respond();
    const context = await start(fake, FAKE_PROFILES, { hardCaps: { maxModelCalls: 50 } });
    await signIn(context.json);
    const catalog = (await context.json('/model-catalog')).body as {
      providerId: string;
      models: { id: string }[];
      methods: { oauth: boolean; apiKey: boolean };
    }[];
    const openai = catalog.find((p) => p.providerId === 'openai');
    expect(openai?.models.map((m) => m.id)).toContain('gpt-test-b');
    expect(openai?.methods).toEqual({ oauth: true, apiKey: true });
    // List prices per million tokens, for the run cost estimate (roadmap 15).
    expect(openai?.models[0]).toMatchObject({
      cost: {
        input: expect.any(Number),
        output: expect.any(Number),
        cacheRead: expect.any(Number),
        cacheWrite: expect.any(Number),
      },
    });
    expect(catalog.find((p) => p.providerId === 'anthropic')?.methods.oauth).toBe(false);

    const current = await context.json('/model-config');
    expect(current.body).toMatchObject({
      modelProfiles: FAKE_PROFILES,
      modelProviders: [],
      usingDefaults: false,
    });
    const saved = await context.json('/model-config', {
      method: 'PUT',
      body: JSON.stringify({
        revision: current.body.revision,
        modelProfiles: [
          { id: 'model-a', provider: 'openai', model: 'gpt-test-b' },
          { id: 'model-b', provider: 'openai', model: 'gpt-test-a' },
        ],
        modelProviders: [],
      }),
    });
    expect(saved.status).toBe(200);
    expect(saved.body.revision).not.toBe(current.body.revision);
    const file = configOf(context.workspace);
    expect(file.hardCaps).toEqual({ maxModelCalls: 50 });
    expect(file.modelProfiles[0]).toEqual({
      id: 'model-a',
      provider: 'openai',
      model: 'gpt-test-b',
    });
    // The running server uses the new profile for the next run.
    const profiles = (await context.json('/model-profiles')).body;
    expect(profiles[0]).toMatchObject({ profileId: 'model-a', modelId: 'gpt-test-b' });
    const { transport, runId } = await liveRun(context);
    const events: RunEvent[] = [];
    transport.subscribe(runId ?? '', 0, { onEvent: (e) => events.push(e) });
    await waitForProjection(transport, runId ?? '', (p) => p.status !== 'running');
    while (!events.some((e) => e.type === 'run.started'))
      await new Promise((r) => setTimeout(r, 10));
    const started = events.find((e) => e.type === 'run.started');
    expect(started?.type === 'run.started' && started.payload.modelProfiles[0]?.modelId).toBe(
      'gpt-test-b',
    );
    expect(context.responses.join('\n')).not.toContain('secret');
  });

  it('[TC-SEC-002-N] refuses an unknown provider, a built-in name, plain http elsewhere, a key and a stale revision; the file stays', async () => {
    const context = await start(makeFake());
    const { revision } = (await context.json('/model-config')).body;
    const before = readFileSync(join(context.workspace, '.corral', 'config.json'), 'utf-8');
    const endpoint = (patch: Record<string, unknown>) => ({
      id: 'local',
      name: 'Local',
      baseUrl: 'http://127.0.0.1:11434/v1',
      access: 'none',
      models: [{ id: 'llama3.2' }],
      ...patch,
    });
    const attempts: [number, Record<string, unknown>][] = [
      [400, { modelProfiles: [{ id: 'a', provider: 'nobody', model: 'm' }], modelProviders: [] }],
      [400, { modelProfiles: FAKE_PROFILES, modelProviders: [endpoint({ id: 'openai' })] }],
      [
        400,
        {
          modelProfiles: FAKE_PROFILES,
          modelProviders: [endpoint({ baseUrl: 'http://10.0.0.5/v1' })],
        },
      ],
      [400, { modelProfiles: FAKE_PROFILES, modelProviders: [endpoint({ apiKey: 'sk-x' })] }],
    ];
    for (const [status, body] of attempts) {
      const answer = await context.json('/model-config', {
        method: 'PUT',
        body: JSON.stringify({ revision, ...body }),
      });
      expect(answer.status, JSON.stringify(body)).toBe(status);
      expect(JSON.stringify(answer.body)).not.toContain('sk-x');
    }
    const stale = await context.json('/model-config', {
      method: 'PUT',
      body: JSON.stringify({ revision: 'old', modelProfiles: FAKE_PROFILES, modelProviders: [] }),
    });
    expect(stale.status).toBe(409);
    expect(readFileSync(join(context.workspace, '.corral', 'config.json'), 'utf-8')).toBe(before);
  });
});

describe('auto sessions (CR-024)', () => {
  async function autoSession(context: Awaited<ReturnType<typeof start>>) {
    const created = await context.json('/sessions', {
      method: 'POST',
      body: JSON.stringify({ projectId: 'default', title: 'Quick question' }),
    });
    expect(created.status).toBe(201);
    return created.body.session.sessionId as string;
  }
  const autoStart = (context: Awaited<ReturnType<typeof start>>, body: Record<string, unknown>) =>
    context.json('/runs/auto', {
      method: 'POST',
      body: JSON.stringify({ schemaVersion: '0.1', mode: 'live', ...body }),
    });

  it('[TC-AUTO-003-H] asks the chosen model once with a cap, starts the chosen template, and a resend asks nothing', async () => {
    const fake = makeFake();
    const context = await start(fake);
    await signIn(context.json);
    const sessionId = await autoSession(context);
    fake.answerWith('Live answer.', {
      hostReply: '{"template":"single","reason":"A short question."}',
    });
    const body = {
      commandId: 'cmd_auto_live',
      sessionId,
      brief: 'What does CR-024 change?',
      choice: { modelProfile: 'model-b' },
    };
    const started = await autoStart(context, body);
    expect(started.status).toBe(201);
    expect(started.body.autoRoute).toMatchObject({
      template: 'single',
      source: 'model',
      reason: 'A short question.',
      modelProfile: 'model-b',
    });
    expect(fake.seen.hostRequests).toHaveLength(1);
    expect(fake.seen.hostRequests[0]?.maxTokens).toBe(256);
    expect(fake.seen.hostRequests[0]?.text).toContain('What does CR-024 change?');
    const transport = new HttpSseTransport({ baseUrl: context.server.url, fetch: context.call });
    const done = await waitForProjection(
      transport,
      started.body.runId,
      (p) => p.status === 'succeeded' || p.status === 'failed',
    );
    expect(done.status).toBe('succeeded');
    const runs = await transport.listRuns();
    expect(runs.find((r) => r.runId === started.body.runId)?.sessionId).toBe(sessionId);
    // The session records which template the request ran with.
    const entry = await context.json(`/sessions/${sessionId}/entries`, {
      method: 'POST',
      body: JSON.stringify({
        intent: 'next',
        text: 'What does CR-024 change?',
        state: 'started',
        runId: started.body.runId,
        commandId: 'cmd_auto_live',
        auto: { template: 'single', source: 'model' },
      }),
    });
    expect(entry.status).toBeLessThan(300);
    expect(entry.body.session.entries[0].auto).toEqual({ template: 'single', source: 'model' });

    const again = await autoStart(context, body);
    expect(again.status).toBe(200);
    expect(again.body.runId).toBe(started.body.runId);
    expect(again.body.autoRoute).toEqual(started.body.autoRoute);
    expect(fake.seen.hostRequests).toHaveLength(1);
  });

  it('[TC-AUTO-005-H] the start model picks the reasoning level and every role runs it', async () => {
    const fake = makeFake({ reasoningApi: true });
    const context = await start(fake);
    await signIn(context.json);
    const sessionId = await autoSession(context);
    fake.answerWith('Live answer.', {
      hostReply: '{"template":"single","reason":"Short.","reasoning":"high"}',
    });
    const started = await autoStart(context, {
      commandId: 'cmd_auto_route',
      sessionId,
      brief: 'Explain the change.',
      choice: { modelProfile: 'model-a', reasoning: { mode: 'route' } },
    });
    expect(started.status).toBe(201);
    expect(started.body.autoRoute).toMatchObject({
      reasoning: { mode: 'route' },
      reasoningChoice: { level: 'high', source: 'model' },
    });
    const roles = context.server.coordinator.getRunSnapshot(started.body.runId)?.definition.roles;
    expect(roles?.map((r) => r.reasoning)).toEqual([{ mode: 'fixed', level: 'high' }]);
    const entry = await context.json(`/sessions/${sessionId}/entries`, {
      method: 'POST',
      body: JSON.stringify({
        intent: 'next',
        text: 'Explain the change.',
        state: 'started',
        runId: started.body.runId,
        auto: { template: 'single', source: 'model', reasoning: 'high' },
      }),
    });
    expect(entry.status).toBeLessThan(300);
  });

  it('[TC-AUTO-005-N] a model with no reasoning levels cannot choose per request; no model is asked', async () => {
    const fake = makeFake();
    const context = await start(fake);
    await signIn(context.json);
    const sessionId = await autoSession(context);
    const refused = await autoStart(context, {
      commandId: 'cmd_auto_route_no',
      sessionId,
      brief: 'Explain the change.',
      choice: { modelProfile: 'model-a', reasoning: { mode: 'route' } },
    });
    expect(refused.body.runId).toBeNull();
    expect(refused.body.receipt.error.code).toBe('CAPABILITY_DENIED');
    expect(fake.seen.hostRequests).toHaveLength(0);
  });

  it('[TC-AUTO-003-N] an unusable answer falls back to single; no sign-in or a missing session asks no model', async () => {
    const fake = makeFake();
    const context = await start(fake);
    const sessionId = await autoSession(context);
    const signedOut = await autoStart(context, {
      commandId: 'cmd_auto_out',
      sessionId,
      brief: 'Hello',
      choice: { modelProfile: 'model-a' },
    });
    expect(signedOut.body.runId).toBeNull();
    expect(fake.seen.hostRequests).toHaveLength(0);

    await signIn(context.json);
    const missing = await autoStart(context, {
      commandId: 'cmd_auto_missing',
      sessionId: 'session_missing',
      brief: 'Hello',
      choice: { modelProfile: 'model-a' },
    });
    expect(missing.status).toBe(404);
    expect(fake.seen.hostRequests).toHaveLength(0);

    fake.answerWith('Live answer.', { hostReply: 'A poem team: roses-are-red' });
    const fallback = await autoStart(context, {
      commandId: 'cmd_auto_bad',
      sessionId,
      brief: 'Hello',
      choice: { modelProfile: 'model-a' },
    });
    expect(fallback.body.autoRoute).toMatchObject({
      template: 'single',
      source: 'fallback',
      fallback: 'invalid_answer',
    });
    expect(context.responses.join('\n')).not.toContain('roses-are-red');
    expect(context.responses.join('\n')).not.toContain('secret');

    // Simulated runs on this server choose by the local rule and call no model.
    const transport = new HttpSseTransport({ baseUrl: context.server.url, fetch: context.call });
    await waitForProjection(transport, fallback.body.runId, (p) =>
      ['succeeded', 'failed'].includes(p.status),
    );
    const before = fake.seen.hostRequests.length;
    const simulated = await autoStart(context, {
      commandId: 'cmd_auto_mock',
      sessionId,
      brief: 'Compare three vendors',
      mode: 'mock',
      choice: { modelProfile: 'model-a' },
    });
    expect(simulated.body.autoRoute).toMatchObject({
      template: 'research_write_review',
      source: 'local',
    });
    expect(fake.seen.hostRequests).toHaveLength(before);
  });
});
