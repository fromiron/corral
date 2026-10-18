import type { AutoModelChoice } from '@corral/contracts';
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
  ] as const)('serializes %j consistently with run requests', async (reasoning, expected) => {
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
    const choice: AutoModelChoice = { modelProfile: 'chosen', ...(reasoning ? { reasoning } : {}) };
    await registry.routeAuto('A short question.', choice);
    expect(payload).toBeDefined();
    expect((payload as { reasoning?: { effort?: string } }).reasoning?.effort).toBe(expected);
    expect(models.getModel('openai-codex', 'gpt-6-luna')?.thinkingLevelMap?.off).toBe('none');
  });

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
      const message = fauxAssistantMessage('x'.repeat(257));
      message.usage = { ...message.usage, input: 10, output: 70, totalTokens: 80 };
      stream.push({
        type: 'text_delta',
        contentIndex: 0,
        delta: 'x'.repeat(257),
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

  it.each([39, 256])('accepts a streamed answer of %i bytes and keeps its usage', async (bytes) => {
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
  });

  it('counts UTF-8 bytes and thinking output toward the streamed bound', async () => {
    const { registry, models } = await setup();
    let signal: AbortSignal | undefined;
    vi.spyOn(models, 'streamSimple').mockImplementation((_model, _context, options) => {
      signal = options?.signal;
      const stream = createAssistantMessageEventStream();
      const message = fauxAssistantMessage([{ type: 'thinking', thinking: '가'.repeat(86) }]);
      stream.push({
        type: 'thinking_delta',
        contentIndex: 0,
        delta: '가'.repeat(86),
        partial: message,
      });
      stream.push({ type: 'done', reason: 'stop', message });
      stream.end();
      return stream;
    });
    expect(await registry.routeAuto('A question.', { modelProfile: 'chosen' })).toMatchObject({
      ok: false,
      reason: 'output_limit',
    });
    expect(signal?.aborted).toBe(true);
  });

  it('refuses over-bound final output without deltas and preserves its reported usage', async () => {
    const { registry, models } = await setup();
    vi.spyOn(models, 'streamSimple').mockImplementation(() => {
      const stream = createAssistantMessageEventStream();
      const message = fauxAssistantMessage('x'.repeat(257));
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

  it('refuses a short response whose reported hidden reasoning exceeds the token cap', async () => {
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
      ok: false,
      reason: 'output_limit',
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
