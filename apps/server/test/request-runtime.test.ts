import { once } from 'node:events';
import type { ModelAttempt } from '@corral/contracts';
import { Coordinator, InProcessTransport, SPEC_HARD_CAPS, waitForProjection } from '@corral/core';
import { FakeClock, linearCorral, SequentialIdFactory } from '@corral/testkit';
import {
  createAssistantMessageEventStream,
  createFauxCore,
  fauxAssistantMessage,
} from '@earendil-works/pi-ai';
import { expect, it, vi } from 'vitest';
import { cancellationFromSignal, ModelRequestRuntime } from '../src/models/request-runtime.ts';

it.each([false, true])(
  'zero usage is reported only when present in the provider frame (%s)',
  async (reported) => {
    const records = new Map<string, ModelAttempt>();
    let time = 0;
    const rates = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 };
    const runtime = new ModelRequestRuntime({
      store: {
        put: (r) => records.set(r.attemptId, structuredClone(r)),
        get: (id) => records.get(id) ?? null,
        list: () => [...records.values()],
      },
      acquire: async () => {
        time += 25;
        return () => {};
      },
      now: () => new Date(time),
    });
    const model = createFauxCore({ provider: 'faux', models: [{ id: 'fixture', name: 'Fixture' }] })
      .models[0]!;
    const stream = runtime.stream(
      {
        streamSimple: (_m, _c, options) => {
          expect(options?.toolChoice).toBe(reported ? 'none' : undefined);
          const out = createAssistantMessageEventStream();
          void (async () => {
            if (reported)
              await options?.onProviderStreamEvent?.(
                { response: { usage: { input_tokens: 0, output_tokens: 0 } } },
                model,
              );
            const message = fauxAssistantMessage('');
            out.push({ type: 'done', reason: 'stop', message });
            out.end(message);
          })();
          return out;
        },
      },
      model,
      { messages: [] },
      {
        requestId: 'zero',
        owner: { kind: 'draft', id: 'zero' },
        purpose: reported ? 'compaction' : 'draft',
        revision: 0,
      },
      {},
      false,
      { subscription: false, rates },
    );
    await stream.result();
    expect([...records.values()][0]?.usage).toMatchObject({
      source: reported ? 'reported' : 'unknown',
      inputTokens: reported ? 0 : null,
      outputTokens: reported ? 0 : null,
      costStatus: reported ? 'estimated' : 'unknown',
      costUsd: reported ? 0 : null,
    });
    expect([...records.values()][0]?.queueWaitMs).toBe(25);
    expect([...records.values()][0]?.usage.pricing).toEqual(
      reported ? { source: 'pi-ai-1.3.0-catalog', usdPerMillion: rates } : undefined,
    );
  },
);

it('Retry-After waits before admission and leaves other provider accounts runnable', async () => {
  vi.useFakeTimers();
  try {
    let slots = 0,
      calls = 0;
    const records = new Map<string, ModelAttempt>();
    const runtime = new ModelRequestRuntime({
      store: {
        put: (r) => records.set(r.attemptId, structuredClone(r)),
        get: (id) => records.get(id) ?? null,
        list: () => [...records.values()],
      },
      acquire: async () => {
        slots++;
        return () => {
          slots--;
        };
      },
    });
    const model = createFauxCore({
      provider: 'limited',
      models: [{ id: 'fixture', name: 'Fixture' }],
    }).models[0]!;
    const models = {
      streamSimple: () => {
        calls++;
        const stream = createAssistantMessageEventStream();
        const message = {
          ...fauxAssistantMessage(''),
          ...(calls === 1
            ? {
                stopReason: 'error' as const,
                errorMessage: JSON.stringify({
                  code: 'RATE_LIMIT',
                  status: 429,
                  retryAfterMs: 1000,
                  requestId: null,
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
        return stream;
      },
    };
    const intent = {
      requestId: 'cooldown',
      owner: { kind: 'draft' as const, id: 'cooldown' },
      purpose: 'draft' as const,
      revision: 0,
    };
    await runtime.stream(models, model, { messages: [] }, intent).result();
    const waiting = runtime.stream(models, model, { messages: [] }, intent).result();
    await runtime
      .stream(
        models,
        { ...model, provider: 'other' },
        { messages: [] },
        { ...intent, requestId: 'other' },
      )
      .result();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(2);
    expect(slots).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    await waiting;
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(3);
    expect(slots).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it('cancellation returns promptly, retains transport admission until termination, and reconciles late usage', async () => {
  const records = new Map<string, ModelAttempt>();
  let released = 0;
  const runtime = new ModelRequestRuntime({
    store: {
      put: (value) => records.set(value.attemptId, structuredClone(value)),
      get: (id) => records.get(id) ?? null,
      list: () => [...records.values()],
    },
    acquire: async () => () => {
      released++;
    },
    newId: () => 'physical_1',
  });
  const source = createAssistantMessageEventStream();
  const model = createFauxCore({ provider: 'faux', models: [{ id: 'fixture', name: 'Fixture' }] })
    .models[0]!;
  const abort = new AbortController();
  const result = runtime.stream(
    { streamSimple: () => source },
    model,
    { messages: [] },
    {
      requestId: 'logical_1',
      owner: { kind: 'draft', id: 'draft_1' },
      purpose: 'draft',
      revision: 0,
    },
    { signal: abort.signal },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  abort.abort();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(released).toBe(0);
  expect(records.get('physical_1')?.status).toBe('cancelled');
  const message = fauxAssistantMessage('late');
  message.usage = { ...message.usage, input: 7, output: 3, cacheRead: 2, totalTokens: 12 };
  source.push({ type: 'done', reason: 'stop', message });
  source.end(message);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(records.get('physical_1')).toMatchObject({
    status: 'cancelled',
    usage: { source: 'reported', inputTokens: 9, outputTokens: 3 },
  });
  expect((await result.result()).stopReason).toBe('aborted');
  expect(released).toBe(1);
});

it('a cancelled execution retains its physical slot and late usage reconciles the terminal Run once', async () => {
  const records = new Map<string, ModelAttempt>();
  const source = createAssistantMessageEventStream();
  const model = createFauxCore({ provider: 'faux', models: [{ id: 'fixture', name: 'Fixture' }] })
    .models[0]!;
  let runtime!: ModelRequestRuntime;
  const coordinator = new Coordinator({
    clock: new FakeClock(),
    ids: new SequentialIdFactory(),
    policy: { ...SPEC_HARD_CAPS, maxModelConcurrency: 1 },
    agents: {
      async start(input, host) {
        const abort = new AbortController();
        const settled = (async () => {
          const permit = await host.prepareModelRequest();
          const stream = runtime.stream(
            { streamSimple: () => source },
            model,
            { messages: [] },
            {
              requestId: permit.modelCallId,
              purpose: 'turn',
              revision: input.attemptNo,
              owner: {
                kind: 'execution',
                id: input.executionId,
                runId: input.runId,
                executionId: input.executionId,
                modelCallId: permit.modelCallId,
              },
            },
            { signal: abort.signal },
            true,
          );
          await stream.result();
          await host.observe({
            kind: 'model_completed',
            modelCallId: permit.modelCallId,
            text: '',
            usage: { inputTokens: null, outputTokens: null },
          });
          return { outcome: 'cancelled' as const };
        })();
        return { cancel: async () => abort.abort(), waitForSettlement: () => settled };
      },
    },
  });
  runtime = new ModelRequestRuntime({
    store: {
      put: (value) => records.set(value.attemptId, structuredClone(value)),
      get: (id) => records.get(id) ?? null,
      list: () => [...records.values()],
    },
    acquire: (signal) => coordinator.acquireAuxiliaryModelSlot(signal),
    adopt: (intent) => coordinator.adoptModelSlot(intent),
  });
  const definition = linearCorral(['writer']);
  definition.limits.maxModelConcurrency = 1;
  const started = coordinator.startRun({
    schemaVersion: '0.1',
    commandId: 'start_late_usage',
    definition,
    mode: 'mock',
  });
  expect(started.runId, JSON.stringify(started.receipt)).not.toBeNull();
  const transport = new InProcessTransport(coordinator);
  await expect
    .poll(() => coordinator.getSnapshot(started.runId!).projection.budget.modelCalls)
    .toBe(1);
  const running = coordinator.getSnapshot(started.runId!).projection;
  await new Promise<void>((resolve) => setImmediate(resolve));
  await coordinator.submit({
    schemaVersion: '0.1',
    commandId: 'cancel_late_usage',
    runId: started.runId!,
    type: 'cancel',
    payload: { scope: { kind: 'run' }, reason: 'test' },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await expect
    .poll(() => coordinator.getSnapshot(started.runId!).projection.status)
    .toBe('cancelled');
  let nextAdmitted = false;
  const next = coordinator
    .acquireAuxiliaryModelSlot(cancellationFromSignal(new AbortController().signal))
    .then((release) => {
      nextAdmitted = true;
      return release;
    });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(nextAdmitted).toBe(false);
  const message = fauxAssistantMessage('discarded');
  message.usage = { ...message.usage, input: 7, output: 3, totalTokens: 10 };
  source.push({ type: 'done', reason: 'stop', message });
  source.end(message);
  await expect
    .poll(() => nextAdmitted, { message: JSON.stringify([...records.values()]) })
    .toBe(true);
  (await next)();
  const after = coordinator.getSnapshot(started.runId!).projection;
  expect(after).toMatchObject({ status: 'cancelled', budget: { spent: 3, unknownOutstanding: 0 } });
  expect(after.executionOrder).toEqual(running.executionOrder);
  expect([...records.values()][0]).toMatchObject({
    status: 'cancelled',
    usage: { inputTokens: 7, outputTokens: 3 },
  });
  expect(Object.values(after.modelCalls)[0]?.responseRef).toBeNull();
});

it('actual Pi HTTP failures retain Retry-After and request ID before SDK rejection', async () => {
  const { createServer } = await import('node:http');
  const { createModels } = await import('@earendil-works/pi-ai');
  const { endpointProvider } = await import('@corral/adapter-pi');
  const server = createServer((_request, response) => {
    response.writeHead(429, {
      'content-type': 'application/json',
      'retry-after': '30',
      'x-request-id': 'loopback-429',
    });
    response.end(
      JSON.stringify({ error: { message: 'rate limit exceeded', type: 'rate_limit_error' } }),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  const models = createModels();
  models.setProvider(
    endpointProvider('limited', {
      name: 'Loopback',
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      keyless: true,
      models: [{ id: 'fixture', contextWindow: 32000, maxOutput: 512, reasoning: false }],
    }),
  );
  const records = new Map<string, ModelAttempt>();
  const runtime = new ModelRequestRuntime({
    store: {
      put: (a) => records.set(a.attemptId, structuredClone(a)),
      get: (id) => records.get(id) ?? null,
      list: () => [...records.values()],
    },
    acquire: async () => () => {},
    now: () => new Date('2026-10-24T00:00:00Z'),
  });
  try {
    const result = await runtime
      .stream(
        models,
        models.getModel('limited', 'fixture')!,
        { messages: [{ role: 'user', content: 'synthetic', timestamp: 0 }] },
        { requestId: 'http', purpose: 'draft', owner: { kind: 'draft', id: 'http' }, revision: 0 },
      )
      .result();
    expect(JSON.parse(result.errorMessage!)).toMatchObject({
      code: 'RATE_LIMIT',
      status: 429,
      retryAfterMs: 30000,
      requestId: 'loopback-429',
    });
    expect(runtime.retryAfterMs('limited')).toBe(30000);
    expect(runtime.retryAfterMs('other')).toBe(0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
