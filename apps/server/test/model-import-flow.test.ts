import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScriptedAgentAdapter } from '@corral/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { type CorralServer, startCorralServer } from '../src/index.ts';
import { ModelCatalogService, parseCatalog } from '../src/models/catalog-service.ts';
import { fakeOpenAI } from '../src/testing.ts';

const servers: CorralServer[] = [];
const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'corral-model-import-'));
  dirs.push(dir);
  return dir;
};
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
async function start() {
  const workspace = temp();
  const configDir = temp();
  const fake = fakeOpenAI({ configDir });
  const token = 'test-import-bootstrap-token-1234567890';
  const server = await startCorralServer({
    workspace,
    live: fake.live,
    port: 0,
    bootstrapToken: token,
    agents: new ScriptedAgentAdapter({ turns: 1 }),
  });
  servers.push(server);
  const login = await fetch(`${server.url}/api/v1/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: server.url },
    body: JSON.stringify({ token }),
  });
  const headers = {
    'content-type': 'application/json',
    origin: server.url,
    cookie: login.headers.get('set-cookie')?.split(';')[0] ?? '',
    'x-corral-csrf': login.headers.get('x-corral-csrf') ?? '',
  };
  async function request(path: string, body?: unknown) {
    const response = await fetch(`${server.url}/api/v1${path}`, {
      headers,
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  }
  return { workspace, configDir, request };
}

describe('import through the authenticated model settings API', () => {
  it('previews chosen file, explicitly copies key, saves atomically and reads profiles back', async () => {
    const { workspace, configDir, request } = await start();
    const path = join(temp(), 'models.json');
    const secret = 'test-private-import-secret';
    writeFileSync(
      path,
      JSON.stringify({
        providers: {
          local: {
            api: 'openai-completions',
            baseUrl: 'http://127.0.0.1:12345/v1',
            apiKey: secret,
            models: [{ id: 'local-model', reasoning: true }],
          },
        },
      }),
    );
    const preview = await request('/model-imports/preview', { source: 'pi', path });
    expect(preview.status).toBe(200);
    expect(JSON.stringify(preview.body)).not.toContain(secret);
    expect(preview.body.candidates[0]).toMatchObject({
      supported: true,
      hasKey: true,
      change: 'add',
    });
    const saved = await request('/model-imports/commit', {
      previewId: preview.body.previewId,
      revision: preview.body.revision,
      selected: [{ id: '0', copyKey: true }],
    });
    expect(saved.status).toBe(200);
    expect(saved.body.keyFailures).toEqual([]);
    expect(JSON.stringify(saved.body)).not.toContain(secret);
    const config = await request('/model-config');
    expect(config.body.modelProfiles).toEqual(saved.body.modelProfiles);
    expect(readFileSync(join(workspace, '.corral', 'config.json'), 'utf8')).not.toContain(secret);
    const credentials = JSON.parse(readFileSync(join(configDir, 'credentials.json'), 'utf8'));
    const provider = preview.body.candidates[0].provider;
    expect(credentials.credentials[provider]).toMatchObject({
      type: 'api_key',
      key: secret,
      env: { CORRAL_ENDPOINT_ORIGIN: 'http://127.0.0.1:12345' },
    });
    const profiles = await request('/model-profiles');
    expect(profiles.body.find((p: { provider: string }) => p.provider === provider)).toMatchObject({
      available: true,
      reasoning: false,
    });
    expect(
      (
        await request('/model-imports/commit', {
          previewId: preview.body.previewId,
          revision: preview.body.revision,
          selected: [{ id: '0', copyKey: true }],
        })
      ).status,
    ).toBe(409);
  });

  it('imports built-in Codex model into the existing reasoning capability path', async () => {
    const { request } = await start();
    const path = join(temp(), 'config.toml');
    writeFileSync(
      path,
      'model = "gpt-test-a"\nmodel_provider = "openai"\nmodel_reasoning_effort = "high"',
    );
    const preview = await request('/model-imports/preview', { source: 'codex', path });
    expect(preview.body.candidates[0].supported).toBe(true);
    const saved = await request('/model-imports/commit', {
      previewId: preview.body.previewId,
      revision: preview.body.revision,
      selected: [{ id: '0', copyKey: false }],
    });
    expect(saved.status).toBe(200);
    const profiles = await request('/model-profiles');
    expect(
      profiles.body.find(
        (p: { profileId: string }) => p.profileId === preview.body.candidates[0].profileId,
      ).reasoningCapabilities,
    ).toEqual(
      profiles.body.find((p: { profileId: string }) => p.profileId === 'model-a')
        .reasoningCapabilities,
    );
  });
});
describe('stale configuration and untrusted metadata', () => {
  it('refuses revision conflict and unsupported selection without changing config or credentials', async () => {
    const { workspace, request } = await start();
    const unreadable = await request('/model-imports/preview', {
      source: 'pi',
      path: join(workspace, 'does-not-exist.json'),
    });
    expect(unreadable.body.error).toMatchObject({ code: 'SCHEMA_INVALID' });
    expect(unreadable.body.error.message).not.toContain(workspace);
    const path = join(temp(), 'opencode.json');
    writeFileSync(path, JSON.stringify({ model: 'openai/gpt-test-a' }));
    const first = await request('/model-imports/preview', { source: 'opencode', path });
    const second = await request('/model-imports/preview', { source: 'opencode', path });
    expect(
      (
        await request('/model-imports/commit', {
          previewId: first.body.previewId,
          revision: first.body.revision,
          selected: [{ id: '0', copyKey: false }],
        })
      ).status,
    ).toBe(200);
    const before = readFileSync(join(workspace, '.corral', 'config.json'), 'utf8');
    expect(
      (
        await request('/model-imports/commit', {
          previewId: second.body.previewId,
          revision: second.body.revision,
          selected: [{ id: '0', copyKey: false }],
        })
      ).status,
    ).toBe(409);
    expect(readFileSync(join(workspace, '.corral', 'config.json'), 'utf8')).toBe(before);
    writeFileSync(
      path,
      JSON.stringify({ model: 'claude-unknown', env: { ANTHROPIC_AUTH_TOKEN: 'never-copy' } }),
    );
    const unsupported = await request('/model-imports/preview', { source: 'claude-code', path });
    expect(unsupported.body.candidates[0].supported).toBe(false);
    expect(
      (
        await request('/model-imports/commit', {
          previewId: unsupported.body.previewId,
          revision: unsupported.body.revision,
          selected: [{ id: '0', copyKey: false }],
        })
      ).status,
    ).toBe(400);
  });
  it('retains verified metadata on refresh failure, restart and stale age without capability fields', async () => {
    let fail = false;
    let now = 100000000;
    const text = JSON.stringify({
      openai: {
        models: {
          m: {
            name: 'Example',
            reasoning: true,
            cost: { input: 1, output: 2 },
            limit: { context: 32000 },
          },
        },
      },
    });
    const file = join(temp(), 'catalog.json');
    const request: typeof fetch = async () => {
      if (fail) throw new Error('private request detail');
      return new Response(text);
    };
    const catalog = new ModelCatalogService(file, request, () => now);
    const fresh = await catalog.refresh();
    expect(fresh.hash).toHaveLength(64);
    expect(fresh.models[0]).toMatchObject({ contextWindow: 32000, inputCost: 1 });
    expect(fresh.models[0]).not.toHaveProperty('reasoning');
    fail = true;
    now += 86400001;
    const stale = await catalog.refresh();
    expect(stale).toMatchObject({ stale: true, hash: fresh.hash });
    expect(stale.error).not.toContain('private request detail');
    expect(new ModelCatalogService(file, request, () => now).view().models).toEqual(fresh.models);
    expect(() => parseCatalog('{"evil":{"models":{}}}')).toThrow();
  });
});
