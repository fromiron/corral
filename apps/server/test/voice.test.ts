import type { ModelProfileSnapshot } from '@corral/contracts';
import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import type { ModelRegistry } from '../src/models/registry.ts';
import { onceResourceCleanup } from '../src/resource-cleanup.ts';
import { registerVoiceRoutes } from '../src/voice/routes.ts';
import { VoiceService } from '../src/voice/service.ts';

const key = 'test-only-not-a-real-key';
const input = {
  profileId: 'primary',
  model: 'gpt-realtime',
  target: { hostId: 'local', sessionId: 'session_a', runId: 'run_a', executionId: 'exec_a' },
  sdp: 'v=0\r\na=audio-offer',
};
const registry = (patch: Partial<ModelProfileSnapshot> = {}) => ({
  profileConfigs: () => [{ id: 'primary', provider: 'openai', model: 'gpt-6-luna' }],
  refreshStatus: async () => {},
  resolve: () => ({
    ok: true as const,
    snapshot: {
      profile: 'primary',
      provider: 'openai',
      modelId: 'gpt-6-luna',
      auth: 'api_key' as const,
      ...patch,
    },
  }),
  credentials: async () => key,
});
const provider = () =>
  vi.fn<typeof fetch>(async (url) =>
    String(url).endsWith('/hangup')
      ? new Response(null, { status: 200 })
      : new Response('v=0\r\na=audio-answer', {
          status: 201,
          headers: { location: '/v1/realtime/calls/rtc_abc' },
        }),
  );
afterEach(() => vi.useRealTimers());

it.each(['503', 'timeout'])(
  '[TC-ABS-015-N] a hangup %s prevents successful host cleanup and retains the call for retry',
  async (failure) => {
    const http = provider();
    const voice = new VoiceService(registry(), { fetch: http });
    const app = Fastify();
    registerVoiceRoutes(app, {
      registry: null,
      hasSession: async () => true,
      hasRun: async () => true,
      service: voice,
    });
    const call = await voice.start(input);
    await app.ready();
    http.mockImplementationOnce(async () => {
      if (failure === 'timeout') throw new DOMException('fixture timeout', 'TimeoutError');
      return new Response(null, { status: 503 });
    });
    const releaseOwnership = vi.fn();
    const close = onceResourceCleanup(() => app.close(), releaseOwnership);
    try {
      await expect(close()).rejects.toMatchObject({ code: 'RESOURCE_CLEANUP_FAILED' });
      expect(releaseOwnership).not.toHaveBeenCalled();
      await expect(voice.start(input)).rejects.toThrow('End the current');
    } finally {
      await voice.stop(call.callId);
    }
    expect(http).toHaveBeenCalledTimes(3);
  },
);

it('[TC-ABS-015-H] exchanges SDP through the public operation without exposing a key; owns hangup and limits', async () => {
  const http = provider();
  const voice = new VoiceService(registry(), { fetch: http, id: () => 'call_a', now: () => 1_000 });
  const call = await voice.start(input);
  expect(call.target).toEqual(input.target);
  expect(call.expiresAt).toBe('1970-01-01T00:05:01.000Z');
  expect(JSON.stringify(call)).not.toContain(key);
  expect(http.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/realtime/calls');
  const init = http.mock.calls[0]?.[1];
  if (!init) throw new Error('missing provider request');
  const session = JSON.parse((init.body as FormData).get('session') as string);
  expect(session.tools).toEqual([]);
  expect(session.audio.input.turn_detection.interrupt_response).toBe(true);
  expect(session.audio.input.transcription.model).toBe('gpt-4o-mini-transcribe');
  expect(session.max_output_tokens).toBe(384);
  await expect(voice.start(input)).rejects.toThrow('End the current');
  await voice.stop(call.callId);
  await voice.stop(call.callId);
  expect(http).toHaveBeenCalledTimes(2);
  expect(String(http.mock.calls[1]?.[0])).toContain('/rtc_abc/hangup');
  await voice.close();
});

it('[TC-ABS-015-N] rejects subscription/custom credentials and redacts provider failures', async () => {
  for (const patch of [{ auth: 'oauth' as const }, { endpointHash: 'custom' }]) {
    const http = provider();
    const voice = new VoiceService(registry(patch), { fetch: http });
    expect((await voice.configuration()).profiles[0]?.available).toBe(false);
    await expect(voice.start(input)).rejects.toThrow('cannot use live voice');
    expect(http).not.toHaveBeenCalled();
  }
  const voice = new VoiceService(registry(), {
    fetch: async () => new Response(`secret ${key}`, { status: 401 }),
  });
  await expect(voice.start(input)).rejects.toThrow('provider refused');
});

it('[TC-ABS-015-N] late creation after cancellation is hung up and provider shutdown failures retain ownership', async () => {
  const abort = new AbortController();
  const http = provider();
  http.mockImplementationOnce(async () => {
    abort.abort();
    return new Response('v=0', {
      status: 201,
      headers: { location: '/v1/realtime/calls/rtc_late' },
    });
  });
  const voice = new VoiceService(registry(), { fetch: http, id: () => 'call_late' });
  await expect(voice.start(input, abort.signal)).rejects.toThrow('cancelled');
  expect(String(http.mock.calls[1]?.[0])).toContain('/rtc_late/hangup');
  const call = await voice.start(input);
  http.mockImplementationOnce(async () => new Response(null, { status: 503 }));
  await expect(voice.stop(call.callId)).rejects.toThrow('not yet confirmed');
  await expect(voice.start(input)).rejects.toThrow('End the current');
  await voice.close();
});

it('[TC-ABS-015-N] server enforces elapsed time even without a browser stop request', async () => {
  vi.useFakeTimers();
  const http = provider();
  const voice = new VoiceService(registry(), { fetch: http, maxDurationSeconds: 2 });
  await voice.start(input);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(http).toHaveBeenCalledTimes(2);
  await voice.close();
});

it('[TC-ABS-015-N] routes reject mismatched run/session ownership before an external call', async () => {
  const app = Fastify();
  const http = provider();
  registerVoiceRoutes(app, {
    registry: registry() as unknown as ModelRegistry,
    hasSession: async (id) => id === 'session_a',
    hasRun: async () => false,
    service: new VoiceService(registry(), { fetch: http }),
  });
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/voice/calls',
    payload: { ...input, target: { ...input.target, hostId: 'http://localhost:80' } },
  });
  expect(response.statusCode).toBe(404);
  expect(http).not.toHaveBeenCalled();
  await app.close();
});

it('[TC-ABS-015-N] an unidentifiable provider call blocks another paid create attempt', async () => {
  const http = vi.fn<typeof fetch>(async () => new Response('v=0', { status: 201 }));
  const voice = new VoiceService(registry(), { fetch: http });
  await expect(voice.start(input)).rejects.toThrow('invalid call identifier');
  await expect(voice.start(input)).rejects.toThrow('could not be reconciled');
  expect(http).toHaveBeenCalledTimes(1);
});
