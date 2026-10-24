import type { AutoModelChoice, ModelAttempt, ModelAttemptStore } from '@corral/contracts';
import {
  Coordinator,
  createAutoStarter,
  InMemoryRunStore,
  InProcessTransport,
  SPEC_HARD_CAPS,
  waitForProjection,
} from '@corral/core';
import { FakeClock, ScriptedAgentAdapter, SequentialIdFactory } from '@corral/testkit';
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  InMemoryCredentialStore,
  normalizeContext,
} from '@earendil-works/pi-ai';
import { streamSimple as codexStream } from '@earendil-works/pi-ai/api/openai-codex-responses';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelRegistry } from '../src/models/registry.ts';

const token = `test.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'test-account' } })).toString('base64url')}.test`;

async function setup() {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify('openai-codex', async () => ({
    type: 'oauth',
    access: token,
    refresh: '',
    expires: Date.now() + 3_600_000,
  }));
  const models = builtinModels({
    credentials,
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  const registry = new ModelRegistry(
    models,
    [{ id: 'chosen', provider: 'openai-codex', model: 'gpt-6-luna' }],
    { credentials, getDeviceId: () => 'test-device' },
  );
  await registry.refreshStatus();
  return { registry, models };
}

async function accountingSetup(maxModelConcurrency = 6) {
  const { registry, models } = await setup();
  const records = new Map<string, ModelAttempt>();
  const attempts: ModelAttemptStore = {
    put: (value) => {
      records.set(value.attemptId, structuredClone(value));
    },
    get: (id) => records.get(id) ?? null,
    list: (ownerId) =>
      [...records.values()].filter((r) => !ownerId || r.intent.owner.id === ownerId),
  };
  const store = new InMemoryRunStore();
  const coordinator = new Coordinator({
    store,
    modelAttempts: attempts,
    clock: new FakeClock(),
    ids: new SequentialIdFactory(),
    agents: new ScriptedAgentAdapter({ turns: 1 }),
    policy: { ...SPEC_HARD_CAPS, maxModelConcurrency },
  });
  registry.configureRequests({
    store: attempts,
    acquire: (signal) => coordinator.acquireAuxiliaryModelSlot(signal),
    onUsage: (intent) => coordinator.settleAutoRouteUsage(intent),
  });
  const starter = createAutoStarter<AbortSignal>({
    startRun: (request) => coordinator.startRun(request),
    previousStart: (id) => {
      const result = coordinator.startResult(id);
      return result
        ? {
            ...result,
            autoRoute: result.runId
              ? (coordinator.getRunSnapshot(result.runId)?.autoRoute ?? null)
              : null,
          }
        : null;
    },
    route: ({ brief, commandId, sessionId, signal }) =>
      registry.routeAuto(brief, { modelProfile: 'chosen' }, signal, undefined, undefined, {
        requestId: commandId,
        ...(sessionId ? { sessionId } : {}),
      }),
  });
  const request = {
    commandId: 'chooser_accounting',
    sessionId: 'session_chooser',
    brief: 'Question',
    mode: 'mock' as const,
    choice: { modelProfile: 'model-a' },
  };
  const settled = (runId: string) =>
    waitForProjection(new InProcessTransport(coordinator), runId, (p) => p.status === 'succeeded');
  const events = (runId: string) =>
    store
      .readEvents(runId, 0)
      .filter(
        (e) =>
          (e.type === 'budget.reserved' || e.type === 'budget.settled') &&
          e.payload.reservationId.startsWith('auto_route'),
      );
  return { registry, models, attempts, store, coordinator, starter, request, settled, events };
}

it('[TC-LLM-002-H] chooser reservations use every physical retry allowance and reported usage', async () => {
  const f = await accountingSetup();
  const allowances: number[] = [];
  const spy = vi.spyOn(f.models, 'streamSimple').mockImplementation((model, context, options) => {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      allowances.push(options!.maxTokens!);
      await options?.onPayload?.({ model: model.id, input: context.messages }, model);
      const first = allowances.length === 1;
      const message = fauxAssistantMessage(
        first ? '' : '{"template":"single","reason":"Short."}',
        first ? { stopReason: 'error' } : {},
      );
      message.usage = {
        ...message.usage,
        input: 10,
        output: first ? 7 : 700,
        totalTokens: first ? 17 : 710,
      };
      if (first)
        message.errorMessage = JSON.stringify({
          code: 'RATE_LIMIT',
          status: 429,
          retryAfterMs: 1,
          requestId: null,
        });
      stream.push(
        first
          ? { type: 'error', reason: 'error', error: message }
          : { type: 'done', reason: 'stop', message },
      );
      stream.end(message);
    })();
    return stream;
  });
  const result = await f.starter.start(f.request, { fileTools: false });
  await f.settled(result.runId!);
  const reserved = f.events(result.runId!).filter((e) => e.type === 'budget.reserved');
  expect(reserved.map((e) => e.payload.amount.outputTokens)).toEqual(allowances);
  expect(allowances).toHaveLength(2);
  expect(allowances.every((cap) => cap > 256)).toBe(true);
  expect(
    f
      .events(result.runId!)
      .filter((e) => e.type === 'budget.settled')
      .map((e) => e.payload.actual.outputTokens),
  ).toEqual([7, 700]);
  expect(result.autoRoute?.usage?.outputTokens).toBe(707);
  await f.starter.start(f.request, { fileTools: false });
  expect(spy).toHaveBeenCalledTimes(2);
  expect(f.events(result.runId!)).toHaveLength(4);
});

it.each([false, true])(
  '[TC-LLM-002-N] chooser distinguishes missing terminal usage from explicit zero (%s)',
  async (reported) => {
    const f = await accountingSetup();
    vi.spyOn(f.models, 'streamSimple').mockImplementation((model, context, options) => {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        await options?.onPayload?.({ model: model.id, input: context.messages }, model);
        if (reported)
          await options?.onProviderStreamEvent?.(
            { response: { usage: { input_tokens: 0, output_tokens: 0 } } },
            model,
          );
        const message = fauxAssistantMessage('{"template":"single","reason":"Short."}');
        message.usage = { ...message.usage };
        stream.push({ type: 'done', reason: 'stop', message });
        stream.end(message);
      })();
      return stream;
    });
    const result = await f.starter.start(f.request, { fileTools: false });
    const projection = await f.settled(result.runId!);
    expect(result.autoRoute?.usage).toEqual(reported ? { inputTokens: 0, outputTokens: 0 } : null);
    const request = f.attempts.list()[0]!;
    expect(projection.budget.unknownOutstanding).toBe(
      reported ? 0 : request.prepared!.outputAllowance,
    );
  },
);

it('[TC-LLM-002-F] late chooser usage settles the original reservation once without changing the completed response', async () => {
  const f = await accountingSetup();
  vi.useFakeTimers();
  const delayed = createAssistantMessageEventStream();
  vi.spyOn(f.models, 'streamSimple').mockImplementation((model, context, options) => {
    void options?.onPayload?.({ model: model.id, input: context.messages }, model);
    return delayed;
  });
  const pending = f.starter.start(f.request, { fileTools: false });
  await vi.advanceTimersByTimeAsync(30_000);
  const result = await pending;
  const before = await f.settled(result.runId!);
  expect(result.autoRoute).toMatchObject({ source: 'fallback', fallback: 'timeout' });
  const request = f.attempts.list()[0]!;
  expect(before.budget.unknownOutstanding).toBe(request.prepared!.outputAllowance);
  const message = fauxAssistantMessage(
    '{"template":"research_write_review","reason":"Late choice."}',
  );
  message.usage = { ...message.usage, input: 10, output: 700, totalTokens: 710 };
  delayed.push({ type: 'done', reason: 'stop', message });
  delayed.end(message);
  await vi.advanceTimersByTimeAsync(0);
  f.coordinator.settleAutoRouteUsage(request.intent);
  const after = f.store.getRun(result.runId!)!.projection;
  expect(after.budget.unknownOutstanding).toBe(0);
  expect(
    f
      .events(result.runId!)
      .filter((e) => e.type === 'budget.settled')
      .map((e) => e.payload.actual.outputTokens),
  ).toEqual([null, 700]);
  expect(after.status).toBe(before.status);
  expect(after.artifacts).toEqual(before.artifacts);
  expect(f.coordinator.getRunSnapshot(result.runId!)?.autoRoute).toEqual(result.autoRoute);
});

it('[TC-LLM-002-F] a chooser can wait for a slot and still use its full response timeout', async () => {
  const f = await accountingSetup(1);
  const release = await f.coordinator.acquireAuxiliaryModelSlot({
    aborted: false,
    onCancel: () => () => {},
  });
  vi.useFakeTimers();
  const response = createAssistantMessageEventStream();
  const spy = vi.spyOn(f.models, 'streamSimple').mockImplementation((model, context, options) => {
    void options?.onPayload?.({ model: model.id, input: context.messages }, model);
    return response;
  });
  try {
    let finished = false;
    const pending = f.starter.start(f.request, { fileTools: false }).then((result) => {
      finished = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(finished).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    expect(f.store.listRuns()).toEqual([]);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(spy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(finished).toBe(false);
    const message = fauxAssistantMessage(
      '{"template":"research_write_review","reason":"Use sources."}',
    );
    message.usage = { ...message.usage, input: 10, output: 20, totalTokens: 30 };
    response.push({ type: 'done', reason: 'stop', message });
    response.end(message);
    const result = await pending;
    expect(result.autoRoute).toMatchObject({ source: 'model', template: 'research_write_review' });
    await f.settled(result.runId!);
  } finally {
    release();
  }
});

it('[TC-AUTO-003-N] cancelling a chooser after a long slot wait starts no provider or Run', async () => {
  const f = await accountingSetup(1);
  const release = await f.coordinator.acquireAuxiliaryModelSlot({
    aborted: false,
    onCancel: () => () => {},
  });
  vi.useFakeTimers();
  const stop = new AbortController();
  const spy = vi.spyOn(f.models, 'streamSimple');
  try {
    const pending = f.starter.start(f.request, { fileTools: false, signal: stop.signal });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.store.listRuns()).toEqual([]);
    const cancelled = expect(pending).rejects.toThrow(/cancelled/);
    stop.abort();
    await cancelled;
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(spy).not.toHaveBeenCalled();
    expect(f.store.listRuns()).toEqual([]);
    expect(f.attempts.list().every((attempt) => !attempt.prepared)).toBe(true);
  } finally {
    release();
  }
});

it('[TC-LLM-002-F] chooser retry backoff does not consume either attempt response timeout', async () => {
  const f = await accountingSetup();
  vi.useFakeTimers();
  let calls = 0;
  const spy = vi.spyOn(f.models, 'streamSimple').mockImplementation((model, context, options) => {
    const first = ++calls === 1;
    const stream = createAssistantMessageEventStream();
    void options?.onPayload?.({ model: model.id, input: context.messages }, model);
    setTimeout(() => {
      const message = fauxAssistantMessage(first ? '' : '{"template":"single","reason":"Direct."}');
      message.usage = {
        ...message.usage,
        input: 10,
        output: first ? 0 : 20,
        totalTokens: first ? 10 : 30,
      };
      if (first) {
        message.stopReason = 'error';
        message.errorMessage = JSON.stringify({
          code: 'RATE_LIMIT',
          status: 429,
          retryAfterMs: 40_000,
          requestId: null,
        });
      }
      stream.push(
        first
          ? { type: 'error', reason: 'error', error: message }
          : { type: 'done', reason: 'stop', message },
      );
      stream.end(message);
    }, 25_000);
    return stream;
  });
  let finished = false;
  const pending = f.starter.start(f.request, { fileTools: false }).then((result) => {
    finished = true;
    return result;
  });
  await vi.advanceTimersByTimeAsync(25_000);
  expect(spy).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(40_000);
  expect(finished).toBe(false);
  expect(spy).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(25_000);
  const result = await pending;
  expect(result.autoRoute).toMatchObject({
    source: 'model',
    template: 'single',
    usage: { outputTokens: 20 },
  });
  await f.settled(result.runId!);
  expect(f.events(result.runId!).filter((event) => event.type === 'budget.reserved')).toHaveLength(
    2,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('the auto chooser at the provider boundary (CR-024)', () => {
  it.each([
    [{ mode: 'fixed', level: 'low' }, 'low'],
    [{ mode: 'fixed', level: 'max' }, 'max'],
    [{ mode: 'fixed', level: 'off' }, 'none'],
    [{ mode: 'provider_default' }, undefined],
    [undefined, undefined],
    [{ mode: 'route' }, 'medium'],
    [{ mode: 'auto' }, 'medium'],
  ] as const)(
    'uses minimum chooser reasoning independently of work policy %j',
    async (reasoning, _expected) => {
      const { registry, models } = await setup();
      let payload: unknown;
      vi.spyOn(models, 'streamSimple').mockImplementation((model, context, options) =>
        codexStream({ ...model, api: 'openai-codex-responses' }, normalizeContext(context), {
          ...options,
          apiKey: token,
          onPayload: (body) => {
            payload = body;
            throw new Error('serializer-only: never send');
          },
        }),
      );
      const choice: AutoModelChoice = {
        modelProfile: 'chosen',
        ...(reasoning ? { reasoning } : {}),
      };
      await registry.routeAuto('A short question.', choice);
      expect(payload).toBeDefined();
      expect((payload as { reasoning?: { effort?: string } }).reasoning?.effort).toBe('none');
      expect(models.getModel('openai-codex', 'gpt-6-luna')?.thinkingLevelMap?.off).toBe('none');
    },
  );

  it.each(['error', 'aborted'] as const)(
    'preserves reported usage after %s',
    async (stopReason) => {
      const { registry, models } = await setup();
      vi.spyOn(models, 'streamSimple').mockImplementation(() => {
        const stream = createAssistantMessageEventStream();
        const message = fauxAssistantMessage('partial', { stopReason });
        message.usage = { ...message.usage, input: 23, output: 17, totalTokens: 40 };
        stream.push({ type: 'error', reason: stopReason, error: message });
        stream.end();
        return stream;
      });
      expect(await registry.routeAuto('A question.', { modelProfile: 'chosen' })).toEqual({
        ok: false,
        reason: 'model_error',
        usage: { inputTokens: 23, outputTokens: 17 },
      });
    },
  );

  it('aborts an oversized streamed response even when the transport ignores maxTokens', async () => {
    const { registry, models } = await setup();
    let signal: AbortSignal | undefined;
    vi.spyOn(models, 'streamSimple').mockImplementation((_model, _context, options) => {
      signal = options?.signal;
      const stream = createAssistantMessageEventStream();
      const message = fauxAssistantMessage('x'.repeat(4097));
      message.usage = { ...message.usage, input: 10, output: 70, totalTokens: 80 };
      stream.push({
        type: 'text_delta',
        contentIndex: 0,
        delta: 'x'.repeat(4097),
        partial: message,
      });
      stream.push({ type: 'done', reason: 'stop', message });
      stream.end();
      return stream;
    });
    const answer = await registry.routeAuto('A question.', { modelProfile: 'chosen' });
    expect(answer).toMatchObject({ ok: false, reason: 'output_limit' });
    expect(signal?.aborted).toBe(true);
  });

  it.each([39, 4096])(
    'accepts a streamed answer of %i bytes and keeps its usage',
    async (bytes) => {
      const { registry, models } = await setup();
      const text = '{"template":"single","reason":"Short."}'.padEnd(bytes, ' ');
      expect(Buffer.byteLength(text)).toBe(bytes);
      vi.spyOn(models, 'streamSimple').mockImplementation(() => {
        const stream = createAssistantMessageEventStream();
        const message = fauxAssistantMessage(text);
        message.usage = { ...message.usage, input: 10, output: 20, totalTokens: 30 };
        stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: message });
        stream.push({ type: 'done', reason: 'stop', message });
        stream.end();
        return stream;
      });
      expect(await registry.routeAuto('A question.', { modelProfile: 'chosen' })).toEqual({
        ok: true,
        text,
        usage: { inputTokens: 10, outputTokens: 20 },
      });
    },
  );

  it('does not count thinking output against the selection JSON byte bound', async () => {
    const { registry, models } = await setup();
    let signal: AbortSignal | undefined;
    vi.spyOn(models, 'streamSimple').mockImplementation((_model, _context, options) => {
      signal = options?.signal;
      const stream = createAssistantMessageEventStream();
      const message = fauxAssistantMessage([
        { type: 'thinking', thinking: '가'.repeat(2000) },
        { type: 'text', text: '{"template":"single","reason":"Short."}' },
      ]);
      stream.push({
        type: 'thinking_delta',
        contentIndex: 0,
        delta: '가'.repeat(2000),
        partial: message,
      });
      stream.push({ type: 'done', reason: 'stop', message });
      stream.end();
      return stream;
    });
    expect(await registry.routeAuto('A question.', { modelProfile: 'chosen' })).toMatchObject({
      ok: true,
    });
    expect(signal?.aborted).toBe(false);
  });

  it('refuses over-bound final output without deltas and preserves its reported usage', async () => {
    const { registry, models } = await setup();
    vi.spyOn(models, 'streamSimple').mockImplementation(() => {
      const stream = createAssistantMessageEventStream();
      const message = fauxAssistantMessage('x'.repeat(4097));
      message.usage = { ...message.usage, input: 10, output: 300, totalTokens: 310 };
      stream.push({ type: 'done', reason: 'stop', message });
      stream.end();
      return stream;
    });
    expect(await registry.routeAuto('A question.', { modelProfile: 'chosen' })).toEqual({
      ok: false,
      reason: 'output_limit',
      usage: { inputTokens: 10, outputTokens: 300 },
    });
  });

  it('accepts valid selection text with longer reported reasoning', async () => {
    const { registry, models } = await setup();
    vi.spyOn(models, 'streamSimple').mockImplementation(() => {
      const stream = createAssistantMessageEventStream();
      const message = fauxAssistantMessage('{"template":"single","reason":"Short."}');
      message.usage = { ...message.usage, input: 10, output: 300, totalTokens: 310 };
      stream.push({ type: 'done', reason: 'stop', message });
      stream.end();
      return stream;
    });
    expect(await registry.routeAuto('A question.', { modelProfile: 'chosen' })).toEqual({
      ok: true,
      text: '{"template":"single","reason":"Short."}',
      usage: { inputTokens: 10, outputTokens: 300 },
    });
  });

  it('settles after 30 seconds when a provider ignores abort and never finishes', async () => {
    const { registry, models } = await setup();
    vi.useFakeTimers();
    vi.spyOn(models, 'streamSimple').mockImplementation(() => createAssistantMessageEventStream());
    const pending = registry.routeAuto('A question.', { modelProfile: 'chosen' });
    const result = Promise.race([
      pending,
      new Promise((resolve) => setTimeout(() => resolve('hung'), 30_001)),
    ]);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(await result).toMatchObject({ ok: false, reason: 'timeout' });
  });

  it('keeps unreported usage unknown when a zero-initialized partial response times out', async () => {
    const { registry, models } = await setup();
    vi.useFakeTimers();
    vi.spyOn(models, 'streamSimple').mockImplementation(() => {
      const stream = createAssistantMessageEventStream();
      stream.push({ type: 'start', partial: fauxAssistantMessage('') });
      return stream;
    });
    const pending = registry.routeAuto('A question.', { modelProfile: 'chosen' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toEqual({ ok: false, reason: 'timeout', usage: null });
  });

  it('keeps usage reported before a provider stops responding and times out', async () => {
    const { registry, models } = await setup();
    vi.useFakeTimers();
    vi.spyOn(models, 'streamSimple').mockImplementation(() => {
      const stream = createAssistantMessageEventStream();
      const message = fauxAssistantMessage('partial');
      message.usage = { ...message.usage, input: 23, output: 17, totalTokens: 40 };
      stream.push({ type: 'text_delta', contentIndex: 0, delta: 'partial', partial: message });
      return stream;
    });
    const pending = registry.routeAuto('A question.', { modelProfile: 'chosen' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toEqual({
      ok: false,
      reason: 'timeout',
      usage: { inputTokens: 23, outputTokens: 17 },
    });
  });

  it('makes no request when the caller already cancelled', async () => {
    const { registry, models } = await setup();
    const send = vi.spyOn(models, 'streamSimple');
    const stop = new AbortController();
    stop.abort();
    expect(
      await registry.routeAuto('A question.', { modelProfile: 'chosen' }, stop.signal),
    ).toMatchObject({
      ok: false,
      reason: 'model_error',
    });
    expect(send).not.toHaveBeenCalled();
  });
});
