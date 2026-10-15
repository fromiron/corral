import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpSseTransport, RestCorralRepository } from '@corral/client';
import type { RunEvent } from '@corral/contracts';
import { waitForProjection } from '@corral/core';
import { linearCorral, ScriptedAgentAdapter } from '@corral/testkit';
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

function makeFake(options: { env?: Record<string, string> } = {}) {
  const made = fakeOpenAI({ ...options, configDir: temp('config') });
  return { ...made, respond: () => made.answerWith('Live answer.') };
}

async function start(fake: ReturnType<typeof makeFake>, profiles = FAKE_PROFILES) {
  const workspace = temp('workspace');
  await mkdir(join(workspace, '.corral'));
  writeFileSync(
    join(workspace, '.corral', 'config.json'),
    JSON.stringify({
      schemaVersion: '0.1',
      modelProfiles: profiles,
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
      { profile: 'model-a', provider: 'openai', modelId: 'gpt-test-a', auth: 'oauth' },
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
