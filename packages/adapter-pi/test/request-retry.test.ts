import { createAssistantMessageEventStream, fauxAssistantMessage } from '@earendil-works/pi-ai';
import { expect, it } from 'vitest';
import { providerFailure } from '../src/ported/dsh/retry.ts';
import { managedRetryStream } from '../src/request-retry.ts';

it('identifies Hive exhausted balance as quota and preserves safe metadata', () => {
  expect(
    providerFailure('Organization has been paused due to account balance', {
      status: 405,
      headers: new Headers({ 'retry-after': '2', 'x-request-id': 'req-1' }),
    }),
  ).toEqual({ code: 'QUOTA', status: 405, retryAfterMs: 2000, requestId: 'req-1' });
});

it('identifies a reached subscription limit as quota, even on a 200 stream', () => {
  expect(
    providerFailure('The ChatGPT user has reached their Subscription Sharing usage limit.', {
      status: 200,
      headers: new Headers(),
    }),
  ).toEqual({ code: 'QUOTA', status: 200, retryAfterMs: null, requestId: null });
  expect(providerFailure('usage_limit_reached', { status: 429, headers: new Headers() }).code).toBe(
    'QUOTA',
  );
});

it('leaves a rate limit retryable', () => {
  expect(providerFailure('Rate limit exceeded', { status: 429, headers: new Headers() }).code).toBe(
    'RATE_LIMIT',
  );
});

it('keeps HTTP failure classifications ahead of a generic SDK connection message', () => {
  for (const [status, code] of [
    [401, 'AUTH'],
    [429, 'RATE_LIMIT'],
    [503, 'SERVER'],
  ] as const) {
    expect(providerFailure('Connection error.', { status, headers: new Headers() })).toEqual({
      code,
      status,
      retryAfterMs: null,
      requestId: null,
    });
  }
});

it('does not infer a connection failure from arbitrary provider response text', () => {
  expect(providerFailure('Response: Connection error. credential=private-key')).toEqual({
    code: 'UNKNOWN',
    status: null,
    retryAfterMs: null,
    requestId: null,
  });
});

it('retries only explicit transient errors before content and accounts each failed attempt', async () => {
  const opened: number[] = [],
    waits: number[] = [],
    failed: string[] = [];
  const result = managedRetryStream({
    model: { id: 'fixture', provider: 'faux', api: 'faux' },
    signal: new AbortController().signal,
    random: () => 0.5,
    delay: async (ms) => {
      waits.push(ms);
      return true;
    },
    beforeRetry: (msg) => {
      failed.push(msg.errorMessage!);
    },
    open: (attempt) => {
      opened.push(attempt);
      const stream = createAssistantMessageEventStream();
      const message = {
        ...fauxAssistantMessage(attempt === 2 ? 'ok' : ''),
        ...(attempt < 2 ? { stopReason: 'error' as const, errorMessage: 'HTTP 429' } : {}),
      };
      if (message.stopReason === 'error')
        stream.push({ type: 'error', reason: 'error', error: message });
      else stream.push({ type: 'done', reason: 'stop', message });
      stream.end(message);
      return stream;
    },
  });
  expect((await result.result()).stopReason).toBe('stop');
  expect(opened).toEqual([0, 1, 2]);
  expect(waits).toEqual([500, 1000]);
  expect(failed).toHaveLength(2);
});
it.each(['insufficient_quota HTTP 429', 'HTTP 401', 'response lost'])(
  'does not repeat %s',
  async (errorMessage) => {
    let calls = 0;
    const result = managedRetryStream({
      model: { id: 'fixture', provider: 'faux', api: 'faux' },
      signal: new AbortController().signal,
      open: () => {
        calls++;
        const stream = createAssistantMessageEventStream();
        const error = { ...fauxAssistantMessage(''), stopReason: 'error' as const, errorMessage };
        stream.push({ type: 'error', reason: 'error', error });
        stream.end(error);
        return stream;
      },
    });
    expect((await result.result()).stopReason).toBe('error');
    expect(calls).toBe(1);
  },
);
