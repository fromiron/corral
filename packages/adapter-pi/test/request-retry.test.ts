import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  fauxAssistantMessage,
} from '@earendil-works/pi-ai';
import { expect, it } from 'vitest';
import { providerFailure } from '../src/ported/dsh/retry.ts';
import { isReplaySafe, managedRetryStream } from '../src/request-retry.ts';

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

type Block = AssistantMessage['content'][number];
const thinking: Block = { type: 'thinking', thinking: 'weighing options' };
const whitespace: Block = { type: 'text', text: ' \n\t ' };
const bodyText: Block = { type: 'text', text: 'The answer is' };
const toolCall: Block = { type: 'toolCall', id: 'c1', name: 'read', arguments: {} };
const image = { type: 'image', data: 'AAAA', mimeType: 'image/png' } as unknown as Block;

function cutAfter(content: Block[], errorMessage = 'HTTP 503') {
  const stream = createAssistantMessageEventStream();
  const base = fauxAssistantMessage('');
  stream.push({ type: 'start', partial: { ...base, content: [] } });
  content.forEach((block, contentIndex) => {
    const upTo = { ...base, content: content.slice(0, contentIndex + 1) };
    if (block.type === 'thinking')
      stream.push({ type: 'thinking_delta', contentIndex, delta: block.thinking, partial: upTo });
    else if (block.type === 'text')
      stream.push({ type: 'text_delta', contentIndex, delta: block.text, partial: upTo });
    else if (block.type === 'toolCall')
      stream.push({ type: 'toolcall_start', contentIndex, partial: upTo });
  });
  const error = { ...base, content, stopReason: 'error' as const, errorMessage };
  stream.push({ type: 'error', reason: 'error', error });
  stream.end(error);
  return stream;
}

function succeed() {
  const stream = createAssistantMessageEventStream();
  const message = fauxAssistantMessage('ok');
  stream.push({ type: 'start', partial: { ...message, content: [] } });
  stream.push({ type: 'done', reason: 'stop', message });
  stream.end(message);
  return stream;
}

async function run(cuts: Block[][], after: () => ReturnType<typeof succeed> = succeed) {
  const opened: number[] = [],
    seen: string[] = [];
  const out = managedRetryStream({
    model: { id: 'fixture', provider: 'faux', api: 'faux' },
    signal: new AbortController().signal,
    random: () => 0.5,
    delay: async () => true,
    open: (attempt) => {
      opened.push(attempt);
      return attempt < cuts.length ? cutAfter(cuts[attempt]!) : after();
    },
  });
  for await (const event of out) seen.push(event.type);
  return { opened, seen, result: await out.result() };
}

it.each([
  ['no blocks', [], true],
  ['thinking only', [thinking], true],
  ['whitespace text only', [whitespace], true],
  ['thinking and whitespace', [thinking, whitespace], true],
  ['body text', [bodyText], false],
  ['body text after thinking', [thinking, bodyText], false],
  ['a tool call', [toolCall], false],
  ['an image', [image], false],
])('isReplaySafe: %s', (_name, content, safe) => {
  expect(isReplaySafe({ ...fauxAssistantMessage(''), content })).toBe(safe);
});

it('retries a response cut after only reasoning and shows the consumer one clean attempt', async () => {
  const { opened, seen, result } = await run([[thinking]]);
  expect(opened).toEqual([0, 1]);
  expect(result.stopReason).toBe('stop');
  expect(seen).toEqual(['start', 'done']);
});

it('retries a response cut after only whitespace text', async () => {
  const { opened, result } = await run([[whitespace]]);
  expect(opened).toEqual([0, 1]);
  expect(result.stopReason).toBe('stop');
});

it('keeps a response cut after body text as interrupted output and does not repeat it', async () => {
  const { opened, seen, result } = await run([[thinking, bodyText]]);
  expect(opened).toEqual([0]);
  expect(result.stopReason).toBe('error');
  expect(result.content).toEqual([thinking, bodyText]);
  expect(seen).toEqual(['start', 'thinking_delta', 'text_delta', 'error']);
});

it.each([
  ['a tool call', [thinking, toolCall]],
  ['an image', [image]],
])('does not repeat a response cut after %s', async (_name, content) => {
  const { opened, result } = await run([content]);
  expect(opened).toEqual([0]);
  expect(result.stopReason).toBe('error');
});

it('keeps the two-retry allowance for reasoning-only cuts', async () => {
  const { opened, result } = await run([[thinking], [thinking], [thinking]]);
  expect(opened).toEqual([0, 1, 2]);
  expect(result.stopReason).toBe('error');
});

it('streams a retried attempt live once it carries body text', async () => {
  const { opened, seen } = await run([[thinking]], () => cutAfter([thinking, bodyText]));
  expect(opened).toEqual([0, 1]);
  expect(seen).toEqual(['start', 'thinking_delta', 'text_delta', 'error']);
});
