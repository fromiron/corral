import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  fauxAssistantMessage,
} from '@earendil-works/pi-ai';
import { expect, it } from 'vitest';
import { cancellableDelay, providerFailure } from '../src/ported/dsh/retry.ts';
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

const overflow = 'prompt is too long: 250000 tokens > 200000 maximum';

async function runOverflow(content: Block[]) {
  const opened: number[] = [],
    seen: string[] = [];
  let recoveries = 0;
  const out = managedRetryStream({
    model: { id: 'fixture', provider: 'faux', api: 'faux' },
    signal: new AbortController().signal,
    random: () => 0.5,
    delay: async () => true,
    onContextOverflow: () => {
      recoveries++;
      return true;
    },
    open: (attempt) => {
      opened.push(attempt);
      return attempt === 0 ? cutAfter(content, overflow) : succeed();
    },
  });
  for await (const event of out) seen.push(event.type);
  return { opened, seen, recoveries, result: await out.result() };
}

it.each([
  ['reasoning', [thinking]],
  ['whitespace text', [whitespace]],
])('recovers once from a context overflow after only %s', async (_name, content) => {
  const { opened, seen, recoveries, result } = await runOverflow(content);
  expect(recoveries).toBe(1);
  expect(opened).toEqual([0, 1]);
  expect(result.stopReason).toBe('stop');
  expect(seen).toEqual(['start', 'done']);
});

it.each([
  ['body text', [bodyText]],
  ['a started tool call', [toolCall]],
])('does not recover from a context overflow after %s', async (_name, content) => {
  const { opened, recoveries, result } = await runOverflow(content);
  expect(recoveries).toBe(0);
  expect(opened).toEqual([0]);
  expect(result.stopReason).toBe('error');
});

it('delivers held reasoning in order and then aborts when cancelled mid-attempt', async () => {
  const controller = new AbortController();
  const opened: number[] = [],
    seen: string[] = [];
  const base = fauxAssistantMessage('');
  const usage = { ...base.usage, input: 5, output: 2, totalTokens: 7 };
  const out = managedRetryStream({
    model: { id: 'fixture', provider: 'faux', api: 'faux' },
    signal: controller.signal,
    random: () => 0.5,
    delay: async () => true,
    open: (attempt) => {
      opened.push(attempt);
      const stream = createAssistantMessageEventStream();
      const partial = { ...base, content: [thinking], usage };
      stream.push({ type: 'start', partial: { ...partial, content: [] } });
      stream.push({ type: 'thinking_delta', contentIndex: 0, delta: 'w', partial });
      controller.abort();
      const aborted = { ...partial, stopReason: 'aborted' as const, errorMessage: 'CANCELLED' };
      stream.push({ type: 'error', reason: 'aborted', error: aborted });
      stream.end(aborted);
      return stream;
    },
  });
  for await (const event of out) seen.push(event.type);
  const result = await out.result();
  expect(seen).toEqual(['start', 'thinking_delta', 'error']);
  expect(result.stopReason).toBe('aborted');
  expect(result.usage).toEqual(usage);
  expect(opened).toEqual([0]);
});

it('ends as cancelled when cancelled while waiting to retry after reasoning', async () => {
  const controller = new AbortController();
  const opened: number[] = [],
    seen: string[] = [];
  const out = managedRetryStream({
    model: { id: 'fixture', provider: 'faux', api: 'faux' },
    signal: controller.signal,
    random: () => 0.5,
    delay: async (ms, signal) => {
      queueMicrotask(() => controller.abort());
      return cancellableDelay(ms, signal);
    },
    open: (attempt) => {
      opened.push(attempt);
      return cutAfter([thinking]);
    },
  });
  for await (const event of out) seen.push(event.type);
  const result = await out.result();
  expect(result.stopReason).toBe('aborted');
  expect(result.errorMessage).toBe('CANCELLED');
  expect(opened).toEqual([0]);
  expect(seen).toEqual(['error']);
});

const lostConnection = [
  'terminated',
  'TypeError: terminated',
  'premature close',
  'read ECONNRESET',
  'socket hang up',
  'other side closed',
  'Premature Close',
];

it.each(lostConnection)('classifies "%s" after the response started as transport', (text) => {
  const ok = { status: 200, headers: new Headers() };
  expect(providerFailure(text, ok, { responseStarted: true })).toEqual({
    code: 'TRANSPORT',
    status: 200,
    retryAfterMs: null,
    requestId: null,
  });
});

it.each(lostConnection)('keeps "%s" before any response event an unknown outcome', (text) => {
  expect(providerFailure(text).code).toBe('UNKNOWN');
  expect(providerFailure(text, undefined, { responseStarted: false }).code).toBe('UNKNOWN');
});

it.each([
  'Overloaded',
  '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
  'provider returned status 529',
  'HTTP 529',
  'error code: 529',
])('classifies the overload notice "%s" after the response started as a server error', (text) => {
  const ok = { status: 200, headers: new Headers() };
  expect(providerFailure(text, ok, { responseStarted: true }).code).toBe('SERVER');
  expect(providerFailure(text, ok).code).toBe('UNKNOWN');
});

it.each([
  'Your account has been terminated for violating the terms',
  'The response was terminated due to a content policy violation',
  'Requested 529.',
  'at least 529',
  'request-id: 7f3a-529-88',
])('keeps "%s" an unknown outcome even after the response started', (text) => {
  const ok = { status: 200, headers: new Headers() };
  expect(providerFailure(text, ok, { responseStarted: true }).code).toBe('UNKNOWN');
});

it.each(['Request was aborted', 'terminated: operation cancelled'])(
  'keeps cancellation "%s" ahead of a lost connection',
  (text) => {
    expect(providerFailure(text, undefined, { responseStarted: true }).code).toBe('CANCELLED');
  },
);

function cutBeforeStart(errorMessage: string) {
  const stream = createAssistantMessageEventStream();
  const error = { ...fauxAssistantMessage(''), stopReason: 'error' as const, errorMessage };
  stream.push({ type: 'error', reason: 'error', error });
  stream.end(error);
  return stream;
}

async function runCut(first: () => ReturnType<typeof succeed>, signal?: AbortSignal) {
  const opened: number[] = [];
  const out = managedRetryStream({
    model: { id: 'fixture', provider: 'faux', api: 'faux' },
    signal: signal ?? new AbortController().signal,
    random: () => 0.5,
    delay: async () => true,
    open: (attempt) => {
      opened.push(attempt);
      return attempt === 0 ? first() : succeed();
    },
  });
  return { opened, result: await out.result() };
}

it.each(lostConnection)('retries a response lost with "%s" after only reasoning', async (text) => {
  const { opened, result } = await runCut(() => cutAfter([thinking], text));
  expect(opened).toEqual([0, 1]);
  expect(result.stopReason).toBe('stop');
});

it('retries a response cut by an overload notice after only reasoning', async () => {
  const { opened, result } = await runCut(() => cutAfter([thinking], 'Overloaded'));
  expect(opened).toEqual([0, 1]);
  expect(result.stopReason).toBe('stop');
});

it('retries a response lost right after it started, before any delta', async () => {
  const { opened, result } = await runCut(() => cutAfter([], 'terminated'));
  expect(opened).toEqual([0, 1]);
  expect(result.stopReason).toBe('stop');
});

it('keeps a response lost after body text as interrupted output', async () => {
  const { opened, result } = await runCut(() => cutAfter([thinking, bodyText], 'terminated'));
  expect(opened).toEqual([0]);
  expect(result.stopReason).toBe('error');
  expect(result.content).toEqual([thinking, bodyText]);
});

it('does not repeat a response lost after a tool call started', async () => {
  const { opened, result } = await runCut(() => cutAfter([thinking, toolCall], 'terminated'));
  expect(opened).toEqual([0]);
  expect(result.stopReason).toBe('error');
});

it.each(['terminated', 'Overloaded'])(
  'does not repeat "%s" before any response event',
  async (text) => {
    const { opened, result } = await runCut(() => cutBeforeStart(text));
    expect(opened).toEqual([0]);
    expect(result.stopReason).toBe('error');
  },
);

it('does not repeat a response lost because it was cancelled', async () => {
  const controller = new AbortController();
  const { opened, result } = await runCut(() => {
    controller.abort();
    return cutAfter([thinking], 'terminated');
  }, controller.signal);
  expect(opened).toEqual([0]);
  expect(result.stopReason).toBe('error');
  const { opened: again } = await runCut(() => cutAfter([thinking], 'Request was aborted'));
  expect(again).toEqual([0]);
});
