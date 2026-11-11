import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { endpointProvider, modelReasoningCapabilities } from '@corral/adapter-pi';
import { type ModelProviderConfig, parseWorkspaceConfig } from '@corral/core';
import { type Credential, type CredentialStore, createModels } from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it } from 'vitest';
import { ModelCatalogService } from '../src/models/catalog-service.ts';
import { connectionProfileId } from '../src/models/connection-models.ts';
import {
  ENDPOINT_MODEL_LIMITS,
  EndpointModelCache,
  fetchEndpointModels,
} from '../src/models/endpoint-models.ts';
import { ENDPOINT_ORIGIN, endpointsFrom, registerEndpoints } from '../src/models/endpoints.ts';
import { ModelRegistry } from '../src/models/registry.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'corral-endpoint-models-'));
  dirs.push(dir);
  return dir;
};

class MemoryStore implements CredentialStore {
  readonly values = new Map<string, Credential>();
  async read(providerId: string) {
    return this.values.get(providerId);
  }
  async list() {
    return [...this.values].map(([providerId, c]) => ({ providerId, type: c.type }));
  }
  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ) {
    const next = await fn(this.values.get(providerId));
    if (next) this.values.set(providerId, next);
    return next;
  }
  async delete(providerId: string) {
    this.values.delete(providerId);
  }
}

/** Every request the server would send; nothing reaches a real network. */
function network() {
  const seen: { url: string; authorization: string | null; redirect: string | undefined }[] = [];
  let handler: (url: string, init: RequestInit) => Response | Promise<Response> = () =>
    new Response('{}', { status: 404 });
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    seen.push({
      url,
      authorization: new Headers(init.headers).get('authorization'),
      redirect: init.redirect,
    });
    return handler(url, init);
  };
  /** The next request waits until `release` is called (or its signal aborts it). */
  const hold = () => {
    let release!: (response: Response) => void;
    let entered!: () => void;
    const arrived = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const previous = handler;
    handler = (_url, init) =>
      new Promise<Response>((resolve, reject) => {
        handler = previous;
        release = resolve;
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        entered();
      });
    return { arrived, release: (response: Response) => release(response) };
  };
  return {
    fetch,
    seen,
    hold,
    answer(next: typeof handler) {
      handler = next;
    },
  };
}

const list = (models: unknown[], extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ object: 'list', data: models, ...extra }), {
    headers: { 'content-type': 'application/json' },
  });

describe('fetching an endpoint model list', () => {
  it('reads only the listed fields and sends one GET to the saved address with the key', async () => {
    const net = network();
    net.answer(() =>
      list([
        {
          id: 'vendor/alpha',
          context_length: 200000,
          context_window: 150000,
          top_provider: { max_completion_tokens: 32000 },
          supported_parameters: ['tools', 'reasoning'],
          architecture: { input_modalities: ['text', 'image'] },
          pricing: { prompt: 'private-pricing-detail' },
          owned_by: 'private-owner',
        },
        { id: 'beta', max_output_tokens: 4000, supported_parameters: ['tools'] },
        { id: 'beta', context_length: 1 },
        { id: '' },
        { id: 7 },
        { id: 'x'.repeat(201) },
      ]),
    );
    const result = await fetchEndpointModels({
      baseUrl: 'https://router.example.test/v1/',
      apiKey: 'fixture-endpoint-key',
      fetch: net.fetch,
    });
    expect(result).toEqual({
      kind: 'connected',
      status: 200,
      models: [
        {
          id: 'vendor/alpha',
          contextWindow: 150000,
          maxOutput: 32000,
          reasoning: true,
          imageInput: true,
        },
        { id: 'beta', maxOutput: 4000, reasoning: false },
      ],
    });
    expect(net.seen).toEqual([
      {
        url: 'https://router.example.test/v1/models',
        authorization: 'Bearer fixture-endpoint-key',
        redirect: 'manual',
      },
    ]);
  });

  it('does not follow a redirect and names failures like the connection check', async () => {
    const net = network();
    net.answer(
      () => new Response(null, { status: 302, headers: { location: 'https://sink.test/models' } }),
    );
    const base = { baseUrl: 'https://router.example.test/v1', apiKey: 'k', fetch: net.fetch };
    expect(await fetchEndpointModels(base)).toEqual({
      kind: 'redirect',
      status: 302,
      models: null,
    });
    expect(net.seen.map((r) => r.url)).toEqual(['https://router.example.test/v1/models']);
    for (const [status, kind] of [
      [401, 'authentication'],
      [403, 'authentication'],
      [429, 'rateLimit'],
      [503, 'server'],
      [404, 'unsupported'],
    ] as const) {
      net.answer(() => new Response('private provider body', { status }));
      expect(await fetchEndpointModels(base)).toEqual({ kind, status, models: null });
    }
    net.answer(() => {
      throw new Error('private network detail');
    });
    expect(await fetchEndpointModels(base)).toEqual({
      kind: 'connection',
      status: null,
      models: null,
    });
  });

  it('fails on a response over 2 MiB, over 2,000 models, non-JSON, or after 10 seconds', async () => {
    const net = network();
    const base = { baseUrl: 'https://router.example.test/v1', fetch: net.fetch };
    expect(ENDPOINT_MODEL_LIMITS).toEqual({
      timeoutMs: 10_000,
      maxBytes: 2 * 1024 * 1024,
      maxModels: 2_000,
    });
    const filler = 'x'.repeat(ENDPOINT_MODEL_LIMITS.maxBytes);
    net.answer(() => list([{ id: 'a' }], { filler }));
    expect(await fetchEndpointModels(base)).toMatchObject({ kind: 'unsupported', models: null });
    // A streamed body without a declared length is cut off at the same limit.
    net.answer(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(`{"data":[{"id":"a"}],"x":"${filler}`));
              controller.enqueue(new TextEncoder().encode('"}'));
              controller.close();
            },
          }),
        ),
    );
    expect(await fetchEndpointModels(base)).toMatchObject({ kind: 'unsupported', models: null });
    net.answer(() =>
      list(
        Array.from({ length: ENDPOINT_MODEL_LIMITS.maxModels + 1 }, (_, i) => ({ id: `m${i}` })),
      ),
    );
    expect(await fetchEndpointModels(base)).toMatchObject({ kind: 'unsupported', models: null });
    net.answer(() =>
      list(Array.from({ length: ENDPOINT_MODEL_LIMITS.maxModels }, (_, i) => ({ id: `m${i}` }))),
    );
    expect((await fetchEndpointModels(base)).models).toHaveLength(2000);
    net.answer(() => new Response('<html>not json</html>'));
    expect(await fetchEndpointModels(base)).toMatchObject({ kind: 'unsupported', models: null });
    net.answer(() => new Response(JSON.stringify({ data: 'nope' })));
    expect(await fetchEndpointModels(base)).toMatchObject({ kind: 'unsupported', models: null });
    net.hold();
    expect(await fetchEndpointModels({ ...base, timeoutMs: 20 })).toEqual({
      kind: 'connection',
      status: null,
      models: null,
    });
  });
});

describe('models.dev values for endpoint models', () => {
  const catalogText = JSON.stringify({
    openrouter: {
      models: {
        'vendor/thinker': {
          name: 'Thinker',
          reasoning: true,
          modalities: { input: ['text', 'image'] },
          limit: { context: 200000, output: 32000 },
        },
      },
    },
    vendor: {
      models: {
        thinker: {
          name: 'Thinker',
          reasoning: false,
          modalities: { input: ['text', 'image'] },
          limit: { context: 128000, output: 64000 },
        },
        seer: {
          name: 'Seer',
          reasoning: true,
          modalities: { input: ['text', 'image'] },
          limit: { context: 90000, output: 9000 },
        },
      },
    },
  });

  it('matches the exact id or the id without its vendor prefix; the smallest limit and only shared abilities win', async () => {
    const catalog = new ModelCatalogService(
      join(temp(), 'catalog.json'),
      async () => new Response(catalogText),
      () => 1_000_000,
    );
    await catalog.refresh();
    expect(catalog.match('vendor/thinker')).toEqual({
      contextWindow: 128000,
      maxOutput: 32000,
      reasoning: false,
      imageInput: true,
    });
    expect(catalog.match('other/seer')).toEqual({
      contextWindow: 90000,
      maxOutput: 9000,
      reasoning: true,
      imageInput: true,
    });
    expect(catalog.match('thinker/vendor')).toEqual({});
    expect(catalog.match('seer-2')).toEqual({});
    // The metadata view itself still carries no capability fields.
    expect(catalog.view().models[0]).not.toHaveProperty('reasoning');
  });
});

describe('the registry fetches, caches and applies endpoint lists', () => {
  const ROUTER: ModelProviderConfig = {
    id: 'router',
    name: 'Router',
    baseUrl: 'https://router.example.test/v1',
    access: 'api_key',
    models: [],
  };

  function setup(
    options: {
      configs?: ModelProviderConfig[];
      configDir?: string;
      net?: ReturnType<typeof network>;
      catalog?: ModelCatalogService | null;
    } = {},
  ) {
    const configDir = options.configDir ?? temp();
    const net = options.net ?? network();
    const credentials = new MemoryStore();
    const cache = new EndpointModelCache(join(configDir, 'endpoint-models-v1.json'));
    const models = createModels({
      credentials,
      authContext: { env: async () => undefined, fileExists: async () => false },
    });
    const endpoints = endpointsFrom(options.configs ?? [ROUTER], cache);
    registerEndpoints(models, endpoints);
    const registry = new ModelRegistry(models, [], {
      credentials,
      getDeviceId: () => 'device',
      endpoints,
      configRevision: 'rev-1',
      endpointModels: { cache, catalog: options.catalog ?? null, fetch: net.fetch },
      now: () => Date.UTC(2026, 10, 11),
    });
    return { registry, net, credentials, cache, models, configDir };
  }

  const key = (
    store: MemoryStore,
    value: string,
    origin = 'https://router.example.test',
    provider = 'router',
  ) =>
    store.values.set(provider, { type: 'api_key', key: value, env: { [ENDPOINT_ORIGIN]: origin } });

  it('an endpoint saved with only an address and key lists the fetched models; the config keeps no models', async () => {
    const { registry, net, credentials, configDir } = setup();
    net.answer(() =>
      list([
        { id: 'vendor/alpha', context_length: 100000, supported_parameters: ['reasoning'] },
        { id: 'beta', private: 'private-response-marker' },
      ]),
    );
    await registry.refreshStatus();
    await registry.setApiKey('router', 'fixture-router-key');
    await registry.idle();
    expect(net.seen).toEqual([
      {
        url: 'https://router.example.test/v1/models',
        authorization: 'Bearer fixture-router-key',
        redirect: 'manual',
      },
    ]);
    const views = registry.profilesView();
    expect(views.map((view) => [view.profileId, view.source, view.contextWindow])).toEqual([
      [expect.stringMatching(/^router:vendor_alpha\.[a-f0-9]{8}$/), 'connection', 100000],
      ['router:beta', 'connection', 32000],
    ]);
    expect(views[0]!.reasoningCapabilities.levels).toEqual(['low', 'medium', 'high']);
    expect(views[1]!.reasoningCapabilities.levels).toEqual([]);
    expect(registry.authView()[0]).toMatchObject({
      providerId: 'router',
      modelCount: 2,
      modelFetch: { kind: 'connected', status: 200, fetchedAt: '2026-11-11T00:00:00.000Z' },
    });
    expect(credentials.values.get('router')).toMatchObject({ key: 'fixture-router-key' });
    // The cache is in the user's config directory and holds no key and no raw response.
    const cached = readFileSync(join(configDir, 'endpoint-models-v1.json'), 'utf8');
    expect(cached).toContain('vendor/alpha');
    expect(cached).toContain('https://router.example.test');
    expect(cached).not.toMatch(/fixture-router-key|private-response-marker|private/);
  });

  it('a 401 leaves the list empty and says authentication; a corrected key fetches again', async () => {
    const { registry, net } = setup();
    net.answer((_url, init) =>
      new Headers(init.headers).get('authorization') === 'Bearer good-key'
        ? list([{ id: 'alpha' }])
        : new Response('private provider body', { status: 401 }),
    );
    await registry.setApiKey('router', 'bad-key');
    await registry.idle();
    expect(registry.authView()[0]).toMatchObject({
      modelCount: 0,
      modelFetch: { kind: 'authentication', status: 401 },
    });
    expect(registry.profilesView()).toEqual([]);
    await registry.setApiKey('router', 'good-key');
    await registry.idle();
    expect(registry.profilesView().map((view) => view.profileId)).toEqual(['router:alpha']);
    expect(JSON.stringify(registry.authView())).not.toContain('private provider body');
  });

  it('an oversized response or a redirect keeps the previous list', async () => {
    const { registry, net, credentials } = setup();
    key(credentials, 'k');
    await registry.refreshStatus();
    net.answer(() => list([{ id: 'alpha' }]));
    expect(await registry.refreshEndpointModels('router')).toMatchObject({
      kind: 'connected',
      modelCount: 1,
    });
    net.answer(() => list([{ id: 'alpha' }, { id: 'beta' }], { x: 'y'.repeat(3 * 1024 * 1024) }));
    expect(await registry.refreshEndpointModels('router')).toMatchObject({
      kind: 'unsupported',
      modelCount: 1,
    });
    net.answer(
      () => new Response(null, { status: 307, headers: { location: 'https://sink.test' } }),
    );
    expect(await registry.refreshEndpointModels('router')).toMatchObject({
      kind: 'redirect',
      status: 307,
      modelCount: 1,
    });
    expect(net.seen.some((request) => request.url.includes('sink'))).toBe(false);
    expect(registry.profilesView().map((view) => view.modelId)).toEqual(['alpha']);
  });

  it('one fetch per endpoint at a time', async () => {
    const { registry, net, credentials } = setup();
    key(credentials, 'k');
    const held = net.hold();
    const first = registry.refreshEndpointModels('router');
    const second = registry.refreshEndpointModels('router');
    await held.arrived;
    held.release(list([{ id: 'alpha' }]));
    expect(await first).toEqual(await second);
    expect(net.seen).toHaveLength(1);
  });

  it('drops a late result when the address changes, and never uses the old origin cache or key there', async () => {
    const { registry, net, credentials, models } = setup();
    key(credentials, 'old-origin-key');
    net.answer(() => list([{ id: 'alpha' }]));
    await registry.refreshEndpointModels('router');
    const held = net.hold();
    const pending = registry.refreshEndpointModels('router');
    await held.arrived;
    const moved = { ...ROUTER, baseUrl: 'https://elsewhere.example.test/v1' };
    // As the server saves a config: register the endpoints, then reconfigure.
    const next = registry.endpointsFor([moved]);
    registerEndpoints(models, next);
    await registry.reconfigure([], next, 'rev-2');
    held.release(list([{ id: 'late' }]));
    await expect(pending).rejects.toMatchObject({ code: 'conflict' });
    await registry.idle();
    // The new address has no list of its own yet, and the old-origin key was not sent there.
    expect(registry.profilesView()).toEqual([]);
    expect(net.seen.filter((request) => request.url.startsWith('https://elsewhere'))).toEqual([]);
    expect(registry.authView()[0]).toMatchObject({
      endpointChanged: true,
      modelFetch: { kind: 'authentication', status: null },
    });
  });

  it('drops a late result when the key changes during the fetch', async () => {
    const { registry, net, credentials } = setup();
    key(credentials, 'k');
    const held = net.hold();
    const pending = registry.refreshEndpointModels('router');
    await held.arrived;
    await registry.setApiKey('router', 'replacement-key');
    held.release(list([{ id: 'late' }]));
    await expect(pending).rejects.toMatchObject({ code: 'conflict' });
    await registry.idle();
    expect(registry.profilesView().map((view) => view.modelId)).not.toContain('late');
  });

  it('keeps a fetch result across a config save that leaves the endpoint’s address and access alone', async () => {
    const { registry, net, credentials, models } = setup();
    key(credentials, 'k');
    net.answer(() => list([{ id: 'alpha' }]));
    await registry.refreshEndpointModels('router');
    const held = net.hold();
    const pending = registry.refreshEndpointModels('router');
    await held.arrived;
    // Profiles, the endpoint's name and its written models change; its address and access do not.
    const next = registry.endpointsFor([
      { ...ROUTER, name: 'Renamed', models: [{ id: 'written', contextWindow: 9000 }] },
    ]);
    registerEndpoints(models, next);
    await registry.reconfigure(
      [{ id: 'chosen', provider: 'router', model: 'written' }],
      next,
      'rev-2',
    );
    held.release(list([{ id: 'alpha' }, { id: 'late' }]));
    await expect(pending).resolves.toMatchObject({ kind: 'connected', modelCount: 3 });
    await registry.idle();
    expect(net.seen).toHaveLength(2);
    expect(
      registry
        .catalog()
        .find((provider) => provider.providerId === 'router')
        ?.models.map((model) => [model.id, model.limits?.contextWindow.value]),
    ).toEqual([
      ['alpha', 32000],
      ['late', 32000],
      ['written', 9000],
    ]);
    expect(registry.catalog().find((provider) => provider.providerId === 'router')?.name).toBe(
      'Renamed',
    );
  });

  it('saving fetches when the endpoint is new, its address or access changed, or its address has no list yet', async () => {
    const { registry, net, credentials, models } = setup({ configs: [] });
    key(credentials, 'k');
    const save = async (configs: ModelProviderConfig[]) => {
      const next = registry.endpointsFor(configs);
      registerEndpoints(models, next);
      await registry.reconfigure([], next, 'rev');
      await registry.idle();
      return net.seen.length;
    };
    net.answer(() => {
      throw new Error('offline');
    });
    expect(await save([ROUTER])).toBe(1); // new
    // The address has no list (the fetch failed): saving it unchanged fetches again.
    expect(await save([{ ...ROUTER, name: 'Renamed' }])).toBe(2);
    net.answer(() => list([{ id: 'alpha' }]));
    expect(await save([{ ...ROUTER, name: 'Renamed' }])).toBe(3);
    // Now it has one: an unchanged address and access fetch nothing.
    expect(await save([{ ...ROUTER, name: 'Again' }])).toBe(3);
    expect(await save([{ ...ROUTER, access: 'none' }])).toBe(4);
    expect(net.seen.at(-1)).toMatchObject({ authorization: null });
  });

  it('a key bound to another origin is never sent; no request is made', async () => {
    const { registry, net, credentials } = setup();
    key(credentials, 'other-origin-key', 'https://other.example.test');
    expect(await registry.refreshEndpointModels('router')).toMatchObject({
      kind: 'authentication',
      status: null,
      modelCount: 0,
    });
    expect(net.seen).toEqual([]);
  });

  it('a restart reads the cache and sends nothing; an address with another origin does not use it', async () => {
    const first = setup();
    key(first.credentials, 'k');
    first.net.answer(() => list([{ id: 'alpha', context_length: 50000 }]));
    await first.registry.refreshEndpointModels('router');
    const net = network();
    const again = setup({ configDir: first.configDir, net });
    key(again.credentials, 'k');
    await again.registry.refreshStatus();
    expect(again.registry.profilesView().map((view) => [view.modelId, view.contextWindow])).toEqual(
      [['alpha', 50000]],
    );
    expect(net.seen).toEqual([]);
    const moved = setup({
      configDir: first.configDir,
      net,
      configs: [{ ...ROUTER, baseUrl: 'https://elsewhere.example.test/v1' }],
    });
    key(moved.credentials, 'k', 'https://elsewhere.example.test');
    await moved.registry.refreshStatus();
    expect(moved.registry.profilesView()).toEqual([]);
    expect(net.seen).toEqual([]);
  });

  it('values come from the config, then known defaults, then the response, then models.dev, then endpoint defaults', async () => {
    const catalogRequests: string[] = [];
    const catalog = new ModelCatalogService(
      join(temp(), 'catalog.json'),
      async (input) => {
        catalogRequests.push(String(input));
        return new Response(
          JSON.stringify({
            vendor: {
              models: {
                gamma: {
                  name: 'Gamma',
                  reasoning: true,
                  modalities: { input: ['text', 'image'] },
                  limit: { context: 90000, output: 9000 },
                },
              },
            },
          }),
        );
      },
      () => Date.UTC(2026, 10, 11),
    );
    const hive: ModelProviderConfig = {
      id: 'hive',
      name: 'Hive',
      baseUrl: 'https://api-cdn.thehive.ai/api/v3',
      access: 'api_key',
      models: [],
    };
    const configured: ModelProviderConfig = {
      ...ROUTER,
      models: [{ id: 'alpha', contextWindow: 5000, reasoning: false }],
    };
    const { registry, net, credentials } = setup({ configs: [configured, hive], catalog });
    key(credentials, 'k');
    key(credentials, 'hive-key', 'https://api-cdn.thehive.ai', 'hive');
    net.answer((url) =>
      url.startsWith('https://api-cdn')
        ? list([{ id: 'deepseek-ai/deepseek-v4.1-flash-1017', context_length: 64000 }])
        : list([
            { id: 'alpha', context_length: 70000, supported_parameters: ['reasoning'] },
            { id: 'vendor/gamma', top_provider: { max_completion_tokens: 7000 } },
            { id: 'delta' },
          ]),
    );
    await registry.refreshEndpointModels('router');
    await registry.refreshEndpointModels('hive');
    // models.dev was missing, so it was refreshed once before the first fetch only.
    expect(catalogRequests).toEqual(['https://models.dev/api.json']);
    const router = registry.catalog().find((provider) => provider.providerId === 'router')!;
    expect(Object.fromEntries(router.models.map((model) => [model.id, model.limits]))).toEqual({
      alpha: {
        contextWindow: { value: 5000, source: 'config' },
        maxOutput: { value: 4096, source: 'default' },
        reasoning: { value: false, source: 'config' },
        imageInput: { value: false, source: 'default' },
      },
      'vendor/gamma': {
        contextWindow: { value: 90000, source: 'catalog' },
        maxOutput: { value: 7000, source: 'response' },
        reasoning: { value: true, source: 'catalog' },
        imageInput: { value: true, source: 'catalog' },
      },
      delta: {
        contextWindow: { value: 32000, source: 'default' },
        maxOutput: { value: 4096, source: 'default' },
        reasoning: { value: false, source: 'default' },
        imageInput: { value: false, source: 'default' },
      },
    });
    const hiveModel = registry
      .catalog()
      .find((provider) => provider.providerId === 'hive')!
      .models.find((model) => model.id === 'deepseek-ai/deepseek-v4.1-flash-1017')!;
    expect(hiveModel.limits).toMatchObject({
      contextWindow: { value: 1_000_000, source: 'known' },
      maxOutput: { value: 4096, source: 'known' },
      reasoning: { value: true, source: 'known' },
      imageInput: { value: true, source: 'known' },
    });
    const profiles = registry.profilesView();
    expect(
      profiles.find((view) => view.modelId === 'deepseek-ai/deepseek-v4.1-flash-1017')
        ?.reasoningCapabilities.levels,
    ).toEqual(['off', 'low', 'high', 'max']);
  });

  it('a failed models.dev refresh does not fail the fetch', async () => {
    const catalog = new ModelCatalogService(
      join(temp(), 'catalog.json'),
      async () => {
        throw new Error('offline');
      },
      () => Date.UTC(2026, 10, 11),
    );
    const { registry, net, credentials } = setup({ catalog });
    key(credentials, 'k');
    net.answer(() => list([{ id: 'alpha' }]));
    expect(await registry.refreshEndpointModels('router')).toMatchObject({
      kind: 'connected',
      modelCount: 1,
    });
  });

  it('a prepared request survives other models joining the list', async () => {
    const { registry, net, credentials, models } = setup();
    key(credentials, 'k');
    net.answer(() => list([{ id: 'alpha', context_length: 60000 }]));
    await registry.refreshEndpointModels('router');
    const resolved = registry.resolve('router:alpha', 'live');
    if (!resolved.ok) throw new Error(resolved.reason);
    expect(resolved.snapshot.endpointHash).toMatch(/^[a-f0-9]{64}$/);
    net.answer(() => list([{ id: 'alpha', context_length: 60000 }, { id: 'gamma' }]));
    await registry.refreshEndpointModels('router');
    expect(registry.endpointOf(resolved.snapshot)?.models.map((model) => model.id)).toEqual([
      'alpha',
    ]);
    await expect(registry.credentials(resolved.snapshot)).resolves.toBe('k');
    const next = registry.endpointsFor([{ ...ROUTER, models: [{ id: 'epsilon' }] }]);
    registerEndpoints(models, next);
    await registry.reconfigure([], next, 'rev-2');
    expect(() => registry.endpointOf(resolved.snapshot)).not.toThrow();
  });

  /** A Run started on `alpha` as the endpoint listed it: 60,000 context and reasoning. */
  async function runningAlpha() {
    const context = setup();
    key(context.credentials, 'k');
    context.net.answer(() =>
      list([{ id: 'alpha', context_length: 60000, supported_parameters: ['reasoning'] }]),
    );
    await context.registry.refreshEndpointModels('router');
    const resolved = context.registry.resolve('router:alpha', 'live');
    if (!resolved.ok) throw new Error(resolved.reason);
    return { ...context, snapshot: resolved.snapshot };
  }

  it('a running Run keeps the definition it started with across a refresh that changes its context window; the worker receives it', async () => {
    const { registry, net, snapshot } = await runningAlpha();
    net.answer(() => list([{ id: 'alpha', context_length: 61000 }]));
    await registry.refreshEndpointModels('router');
    // New runs see the refreshed values.
    expect(registry.profilesView().map((view) => [view.modelId, view.contextWindow])).toEqual([
      ['alpha', 61000],
    ]);
    // What the adapter hands the worker is the definition pinned at run start.
    const pinned = registry.endpointOf(snapshot);
    expect(pinned?.baseUrl).toBe('https://router.example.test/v1');
    expect(pinned?.models).toEqual([
      { id: 'alpha', contextWindow: 60000, maxOutput: 4096, reasoning: true },
    ]);
    const worker = endpointProvider('router', pinned!).getModels()[0]!;
    expect(modelReasoningCapabilities(worker).identity).toBe(snapshot.reasoning?.identity);
    expect(registry.modelBroker(snapshot).model).toMatchObject({
      id: 'alpha',
      contextWindow: 60000,
      reasoning: true,
    });
    await expect(registry.credentials(snapshot)).resolves.toBe('k');
  });

  it('a running Run keeps its model when a refresh drops it from the list', async () => {
    const { registry, net, snapshot } = await runningAlpha();
    net.answer(() => list([{ id: 'gamma' }]));
    await registry.refreshEndpointModels('router');
    expect(registry.profilesView().map((view) => view.modelId)).toEqual(['gamma']);
    expect(registry.endpointOf(snapshot)?.models.map((model) => model.id)).toEqual(['alpha']);
    expect(registry.modelBroker(snapshot).model).toMatchObject({
      id: 'alpha',
      contextWindow: 60000,
    });
    await expect(registry.credentials(snapshot)).resolves.toBe('k');
    // A new run cannot start on a model the endpoint no longer lists.
    expect(registry.resolve('router:alpha', 'live').ok).toBe(false);
  });

  it('what a person writes in the config still refuses the prepared request; a rename does not', async () => {
    for (const change of [
      { baseUrl: 'https://elsewhere.example.test/v1' },
      { access: 'none' as const },
      { cacheRetention: 'long' as const },
      { sessionAffinity: 'headers' as const },
      { models: [{ id: 'alpha', contextWindow: 50000 }] },
    ]) {
      const { registry, models, snapshot } = await runningAlpha();
      const next = registry.endpointsFor([{ ...ROUTER, ...change }]);
      registerEndpoints(models, next);
      await registry.reconfigure([], next, 'rev-2');
      const label = JSON.stringify(change);
      expect(() => registry.endpointOf(snapshot), label).toThrow(/endpoint configuration changed/);
      expect(() => registry.modelBroker(snapshot), label).toThrow(/endpoint configuration changed/);
      await expect(registry.credentials(snapshot), label).rejects.toThrow(
        /endpoint configuration changed/,
      );
    }
    const { registry, models, snapshot } = await runningAlpha();
    const renamed = registry.endpointsFor([{ ...ROUTER, name: 'Renamed router' }]);
    registerEndpoints(models, renamed);
    await registry.reconfigure([], renamed, 'rev-2');
    expect(registry.endpointOf(snapshot)?.models[0]).toMatchObject({ contextWindow: 60000 });
  });

  it('the list and a stored choice agree on which model an id means when two pairs make the same id', async () => {
    const configs: ModelProviderConfig[] = [
      {
        id: 'loc',
        name: 'Loc',
        baseUrl: 'http://127.0.0.1:1111/v1',
        access: 'none',
        models: [{ id: 'x:m' }],
      },
      {
        id: 'loc:x',
        name: 'Loc X',
        baseUrl: 'http://127.0.0.1:2222/v1',
        access: 'none',
        models: [{ id: 'm' }, { id: 'other' }],
      },
    ];
    const { registry, models } = setup({ configs });
    const endpoints = registry.endpointsFor(configs);
    registerEndpoints(models, endpoints);
    // A named profile on the second endpoint comes first in the provider order.
    await registry.reconfigure([{ id: 'p', provider: 'loc:x', model: 'other' }], endpoints, 'rev');
    await registry.idle();
    expect(connectionProfileId('loc', 'x:m')).toBe(connectionProfileId('loc:x', 'm'));
    const listed = registry.profilesView().filter((view) => view.profileId === 'loc:x:m');
    expect(listed).toHaveLength(1);
    const resolved = registry.resolve('loc:x:m', 'live');
    if (!resolved.ok) throw new Error(resolved.reason);
    expect([resolved.snapshot.provider, resolved.snapshot.modelId]).toEqual([
      listed[0]!.provider,
      listed[0]!.modelId,
    ]);
  });

  it('refreshing a provider that is not an endpoint is refused without a request', async () => {
    const { registry, net } = setup();
    await expect(registry.refreshEndpointModels('nobody')).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(net.seen).toEqual([]);
  });

  it('two workspaces naming the same endpoint id at different addresses keep each other’s lists', async () => {
    const configDir = temp();
    const at = (port: number): ModelProviderConfig => ({
      ...ROUTER,
      id: 'local',
      baseUrl: `http://127.0.0.1:${port}/v1`,
    });
    // Both servers start before either one fetches.
    const one = setup({ configDir, configs: [at(1111)] });
    const two = setup({ configDir, configs: [at(2222)] });
    key(one.credentials, 'k', 'http://127.0.0.1:1111', 'local');
    key(two.credentials, 'k', 'http://127.0.0.1:2222', 'local');
    one.net.answer(() => list([{ id: 'one-model' }]));
    two.net.answer(() => list([{ id: 'two-model' }]));
    await one.registry.refreshEndpointModels('local');
    await two.registry.refreshEndpointModels('local');
    // Restarted, each finds its own list by its address and sends nothing.
    for (const [port, model] of [
      [1111, 'one-model'],
      [2222, 'two-model'],
    ] as const) {
      const net = network();
      const again = setup({ configDir, net, configs: [at(port)] });
      key(again.credentials, 'k', `http://127.0.0.1:${port}`, 'local');
      await again.registry.refreshStatus();
      expect(again.registry.profilesView().map((view) => view.modelId)).toEqual([model]);
      expect(net.seen).toEqual([]);
    }
  });

  it('a cache write merges its one entry into what the file holds now; entries are found by address', () => {
    const file = join(temp(), 'endpoint-models-v1.json');
    const first = new EndpointModelCache(file);
    // Read before the first one wrote anything.
    const second = new EndpointModelCache(file);
    const entry = (id: string) => ({
      fetchedAt: '2026-11-11T00:00:00.000Z',
      models: [{ id, response: {}, catalog: {} }],
    });
    first.write('https://a.example.test/v1', entry('a'));
    second.write('https://b.example.test/v1/', entry('b'));
    const fresh = new EndpointModelCache(file);
    expect(fresh.read('https://a.example.test/v1')?.models.map((m) => m.id)).toEqual(['a']);
    expect(fresh.read('https://b.example.test/v1')?.models.map((m) => m.id)).toEqual(['b']);
    expect(fresh.read('https://a.example.test/v2')).toBeNull();
    expect(fresh.read('https://a.example.test')).toBeNull();
  });

  it('a cache file in the earlier shape is ignored', async () => {
    const configDir = temp();
    writeFileSync(
      join(configDir, 'endpoint-models-v1.json'),
      JSON.stringify({
        version: 1,
        endpoints: {
          router: {
            origin: 'https://router.example.test',
            fetchedAt: '2020-01-01T00:00:00.000Z',
            models: [{ id: 'alpha', response: { contextWindow: 7000 }, catalog: {} }],
          },
        },
      }),
    );
    const net = network();
    const { registry, credentials } = setup({ configDir, net });
    key(credentials, 'k');
    await registry.refreshStatus();
    expect(registry.profilesView()).toEqual([]);
    expect(registry.authView()[0]).toMatchObject({ modelFetch: null });
    expect(net.seen).toEqual([]);
  });

  it('server start makes no request even when the cache is old', async () => {
    const configDir = temp();
    writeFileSync(
      join(configDir, 'endpoint-models-v1.json'),
      JSON.stringify({
        version: 2,
        endpoints: {
          'https://router.example.test/v1': {
            fetchedAt: '2020-01-01T00:00:00.000Z',
            models: [{ id: 'alpha', response: { contextWindow: 7000 }, catalog: {} }],
          },
        },
      }),
    );
    const net = network();
    const { registry, credentials } = setup({ configDir, net });
    key(credentials, 'k');
    await registry.refreshStatus();
    await registry.idle();
    expect(registry.profilesView().map((view) => [view.modelId, view.contextWindow])).toEqual([
      ['alpha', 7000],
    ]);
    expect(registry.authView()[0]).toMatchObject({
      modelFetch: { kind: 'connected', fetchedAt: '2020-01-01T00:00:00.000Z' },
    });
    expect(net.seen).toEqual([]);
  });
});

describe('endpoint configuration without models', () => {
  it('an endpoint may list no models, or leave models out', () => {
    for (const models of [[], undefined]) {
      const parsed = parseWorkspaceConfig({
        schemaVersion: '0.1',
        modelProviders: [
          {
            id: 'router',
            name: 'Router',
            baseUrl: 'https://router.example.test/v1',
            access: 'api_key',
            ...(models ? { models } : {}),
          },
        ],
      });
      expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
    }
  });
});
