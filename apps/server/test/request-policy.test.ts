import { memoryChannelPair, modelBridgeChannel } from '@corral/adapter-pi';
import type { ModelAttempt } from '@corral/contracts';
import {
  createAssistantMessageEventStream,
  createModels,
  fauxAssistantMessage,
  InMemoryCredentialStore,
  normalizeContext,
} from '@earendil-works/pi-ai';
import { expect, it, vi } from 'vitest';
import { workerModelBridge } from '../../../packages/adapter-pi/src/model-bridge.ts';
import { endpointsFrom, registerEndpoints } from '../src/models/endpoints.ts';
import { ModelRegistry } from '../src/models/registry.ts';

it('[TC-LLM-004-N] an execution broker uses its reported input anchor and does not share it with another execution', async () => {
  const credentials = new InMemoryCredentialStore();
  const models = createModels({
    credentials,
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  const endpoints = endpointsFrom([
    {
      id: 'fixture',
      name: 'Fixture',
      baseUrl: 'http://127.0.0.1:8001/v1',
      access: 'none',
      models: [{ id: 'model', contextWindow: 20000, maxOutput: 4000 }],
    },
  ]);
  registerEndpoints(models, endpoints);
  const registry = new ModelRegistry(
    models,
    [{ id: 'chosen', provider: 'fixture', model: 'model' }],
    { credentials, endpoints, getDeviceId: () => 'fixture' },
  );
  await registry.refreshStatus();
  const selected = registry.resolve('chosen', 'live');
  if (!selected.ok) throw new Error(selected.reason);
  const records = new Map<string, ModelAttempt>();
  registry.configureRequests({
    store: {
      put: (r) => records.set(r.attemptId, structuredClone(r)),
      get: (id) => records.get(id) ?? null,
      list: () => [...records.values()],
    },
    acquire: async () => () => {},
    adopt: () => ({ release() {}, lateUsage: async () => {} }),
  });
  const spy = vi.spyOn(models, 'streamSimple').mockImplementation((model, context, options) => {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      await options?.onPayload?.(
        { model: model.id, messages: context.messages, max_completion_tokens: options.maxTokens },
        model,
      );
      const answer = fauxAssistantMessage('continue');
      answer.usage.input = 6000;
      answer.usage.output = 1;
      stream.push({ type: 'done', reason: 'stop', message: answer });
      stream.end(answer);
    })();
    return stream;
  });
  try {
    const execution = () => {
      const pair = memoryChannelPair();
      const broker = registry.modelBroker(selected.snapshot);
      const channel = modelBridgeChannel(pair.host, broker);
      const worker = workerModelBridge(pair.worker);
      return async (context: ReturnType<typeof normalizeContext>, modelCallId: string) => {
        channel.send({ type: 'permit', modelCallId, apiKey: null, maxOutputTokens: 4000 });
        await new Promise<void>((resolve) => setImmediate(resolve));
        return worker.streamFn(broker.model, context, { maxTokens: 4000 });
      };
    };
    const request = execution();
    const prefix = normalizeContext({
      messages: [{ role: 'user', content: 'a'.repeat(56000), timestamp: 1 }],
    });
    const first = await request(prefix, 'first');
    expect((await first.result()).stopReason).toBe('stop');
    const next = normalizeContext({
      messages: [...prefix.messages, { role: 'user', content: 'b'.repeat(28000), timestamp: 2 }],
    });
    const second = await request(next, 'second');
    expect((await second.result()).stopReason).toBe('stop');
    expect(spy).toHaveBeenCalledTimes(2);
    expect([...records.values()].at(-1)?.prepared?.estimatedInputTokens).toBeLessThan(16000);
    expect([...records.values()].at(-1)?.prepared?.measurement).toBe('usage-anchor-v2');
    expect(spy.mock.calls[1]?.[2]?.maxTokens).toBe(4000);
    const isolated = await execution()(next, 'other');
    expect((await isolated.result()).stopReason).toBe('error');
    expect(spy).toHaveBeenCalledTimes(2);
  } finally {
    spy.mockRestore();
  }
});

it('[TC-LLM-001-F] a frozen endpoint snapshot cannot silently resolve a changed destination', async () => {
  const credentials = new InMemoryCredentialStore();
  const models = createModels({
    credentials,
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  const profiles = [{ id: 'chosen', provider: 'fixture', model: 'model' }];
  const endpoints = (host: string) =>
    endpointsFrom([
      {
        id: 'fixture',
        name: 'Fixture',
        baseUrl: `http://127.0.0.1:${host}/v1`,
        access: 'none',
        models: [{ id: 'model', contextWindow: 128000, maxOutput: 50000 }],
      },
    ]);
  const first = endpoints('8001');
  registerEndpoints(models, first);
  const registry = new ModelRegistry(models, profiles, {
    credentials,
    endpoints: first,
    getDeviceId: () => 'fixture',
  });
  await registry.refreshStatus();
  const pinned = registry.resolve('chosen', 'live');
  if (!pinned.ok) throw new Error(pinned.reason);
  expect(pinned.snapshot.contextPolicy?.reserveTokens).toBe(32000);
  const next = endpoints('8002');
  registerEndpoints(models, next);
  await registry.reconfigure(profiles, next);
  await expect(registry.credentials(pinned.snapshot)).rejects.toThrow(/endpoint.*changed/);
  expect(() => registry.endpointOf(pinned.snapshot)).toThrow(/endpoint.*changed/);
  expect(() => registry.modelBroker(pinned.snapshot)).toThrow(/endpoint.*changed/);
  const fresh = registry.resolve('chosen', 'live');
  if (!fresh.ok) throw new Error(fresh.reason);
  expect(await registry.credentials(fresh.snapshot)).toBeNull();
});

it('[TC-LLM-002-H] auxiliary retry attempts retain one logical request and distinct physical identities', async () => {
  const credentials = new InMemoryCredentialStore();
  const models = createModels({
    credentials,
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  const endpoints = endpointsFrom([
    {
      id: 'fixture',
      name: 'Fixture',
      baseUrl: 'http://127.0.0.1:8001/v1',
      access: 'none',
      models: [{ id: 'model', contextWindow: 32000, maxOutput: 512 }],
    },
  ]);
  registerEndpoints(models, endpoints);
  const registry = new ModelRegistry(
    models,
    [{ id: 'chosen', provider: 'fixture', model: 'model', contextWindow: 4096 }],
    { credentials, endpoints, getDeviceId: () => 'fixture' },
  );
  await registry.refreshStatus();
  const records = new Map<string, ModelAttempt>();
  let calls = 0;
  registry.configureRequests({
    store: {
      put: (r) => records.set(r.attemptId, structuredClone(r)),
      get: (id) => records.get(id) ?? null,
      list: () => [...records.values()],
    },
    acquire: async () => () => {},
  });
  const spy = vi.spyOn(models, 'streamSimple').mockImplementation((model, _context, options) => {
    const stream = createAssistantMessageEventStream();
    const retry = calls++ === 0;
    void (async () => {
      await options?.onPayload?.({ model: model.id }, model);
      const message = {
        ...fauxAssistantMessage(retry ? '' : 'answer'),
        ...(retry
          ? {
              stopReason: 'error' as const,
              errorMessage: JSON.stringify({
                code: 'RATE_LIMIT',
                status: 429,
                retryAfterMs: 0,
                requestId: 'provider-1',
              }),
            }
          : {}),
      };
      stream.push(
        message.stopReason === 'error'
          ? { type: 'error', reason: 'error', error: message }
          : { type: 'done', reason: 'stop', message },
      );
      stream.end(message);
    })();
    return stream;
  });
  try {
    await registry.draftTeam('Synthetic goal', { id: 'logical_draft' });
    const attempts = [...records.values()];
    expect(attempts.map((a) => a.intent.requestId)).toEqual(['logical_draft', 'logical_draft']);
    expect(attempts.map((a) => a.intent.retryIndex)).toEqual([0, 1]);
    expect(new Set(attempts.map((a) => a.attemptId)).size).toBe(2);
    expect(spy.mock.calls.every(([model]) => model.contextWindow === 4096)).toBe(true);
    expect(attempts.every((a) => a.policy?.contextWindow === 4096)).toBe(true);
    expect(attempts[0]?.failure).toMatchObject({
      status: 429,
      retryAfterMs: 0,
      requestId: 'provider-1',
    });
  } finally {
    spy.mockRestore();
  }
});

it('[TC-LLM-001-H] host worker transport retains endpoint-bound credential metadata', async () => {
  const credentials = new InMemoryCredentialStore();
  const { ENDPOINT_ORIGIN } = await import('../src/models/endpoints.ts');
  await credentials.modify('fixture', async () => ({
    type: 'api_key',
    key: 'test-secret',
    env: { [ENDPOINT_ORIGIN]: 'http://127.0.0.1:8001' },
  }));
  const models = createModels({ credentials });
  const endpoints = endpointsFrom([
    {
      id: 'fixture',
      name: 'Fixture',
      baseUrl: 'http://127.0.0.1:8001/v1',
      access: 'api_key',
      models: [{ id: 'model' }],
    },
  ]);
  registerEndpoints(models, endpoints);
  const registry = new ModelRegistry(
    models,
    [{ id: 'chosen', provider: 'fixture', model: 'model' }],
    { credentials, endpoints, getDeviceId: () => 'fixture' },
  );
  await registry.refreshStatus();
  const resolved = registry.resolve('chosen', 'live');
  if (!resolved.ok) throw new Error(resolved.reason);
  const broker = registry.modelBroker(resolved.snapshot);
  let prepared = false;
  const stream = await broker.withPermit!({
    modelCallId: 'call',
    apiKey: await registry.credentials(resolved.snapshot),
    maxOutputTokens: 64,
  })(
    broker.model,
    normalizeContext({ messages: [{ role: 'user', content: 'synthetic fixture', timestamp: 0 }] }),
    {
      apiKey: 'test-secret',
      maxTokens: 64,
      onPayload: () => {
        prepared = true;
        throw new Error('fixture stops before network');
      },
    },
  );
  await stream.result();
  expect(prepared).toBe(true);
});
