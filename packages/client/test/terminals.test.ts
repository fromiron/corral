import type { TerminalEvent, TerminalIdentity } from '@corral/contracts';
import { afterEach, expect, it, vi } from 'vitest';
import { TerminalsApi } from '../src/index.ts';

const identity: TerminalIdentity = {
  target: {
    hostId: 'host',
    projectId: 'default',
    bindingId: 'binding',
    sessionId: 'session',
    copyGeneration: 1,
  },
  generation: 'generation',
};
const event = (sequence: number): TerminalEvent => ({
  type: 'output',
  generation: identity.generation,
  sequence,
  data: '\u001b[31m가\n\nevent: status\r\n',
});
const stream = (...events: TerminalEvent[]) =>
  new Response(
    events.map((value) => `event: terminal\ndata: ${JSON.stringify(value)}\n\n`).join(''),
  );
afterEach(() => vi.useRealTimers());

it('[TC-WBD-004-F] uses the existing CSRF boundary and does not replay ambiguous input', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const api = new TerminalsApi({
    baseUrl: '',
    fetch: async (url, init) => {
      calls.push({ url: String(url), ...(init ? { init } : {}) });
      if (String(url).endsWith('/session')) return Response.json({ csrfToken: 'csrf' });
      throw new Error('response lost');
    },
  });
  await expect(
    api.input('session', 'terminal', {
      ...identity,
      attachmentId: 'view',
      controllerGeneration: 1,
      sequence: 1,
      data: 'echo test\r',
    }),
  ).rejects.toThrow('response lost');
  expect(calls.map((call) => call.url)).toEqual([
    '/api/v1/session',
    '/api/v1/sessions/session/terminals/terminal/input',
  ]);
  expect(new Headers(calls[1]?.init?.headers).get('x-corral-csrf')).toBe('csrf');
});

it('[TC-WBD-004-H] resumes only after async rendering completes and preserves ANSI as JSON data', async () => {
  vi.useFakeTimers();
  const cursors: string[] = [];
  const received: TerminalEvent[] = [];
  let release = () => {};
  const applied = new Promise<void>((resolve) => {
    release = resolve;
  });
  const api = new TerminalsApi({
    baseUrl: '',
    fetch: async (url) => {
      cursors.push(new URL(String(url), 'http://localhost').searchParams.get('after') ?? '');
      return cursors.length === 1 ? stream(event(1)) : stream(event(1), event(2));
    },
  });
  const stop = api.subscribe(
    'session',
    'terminal',
    { generation: identity.generation, after: 0 },
    {
      async onEvent(value) {
        if (value.type === 'status') return;
        received.push(value);
        if (value.sequence === 1) await applied;
      },
    },
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(cursors).toEqual(['0']);
  expect(received).toEqual([event(1)]);
  release();
  await vi.advanceTimersByTimeAsync(300);
  stop();
  expect(cursors.slice(0, 2)).toEqual(['0', '1']);
  expect(received).toEqual([event(1), event(2)]);
});

it('[TC-WBD-004-N] refuses a different process generation without delivering or retrying it', async () => {
  vi.useFakeTimers();
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(stream({ ...event(1), generation: 'old_generation' }));
  const errors: unknown[] = [];
  const onEvent = vi.fn();
  const api = new TerminalsApi({ baseUrl: '', fetch: fetcher });
  const stop = api.subscribe(
    'session',
    'terminal',
    { generation: identity.generation, after: 0 },
    { onEvent, onError: (error) => errors.push(error) },
  );
  await vi.advanceTimersByTimeAsync(5000);
  stop();
  expect(onEvent).not.toHaveBeenCalled();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(errors).toHaveLength(1);
});

it('[TC-WBD-004-F] reports an interrupted stream before reconnecting so queued input can be dropped', async () => {
  vi.useFakeTimers();
  const errors: unknown[] = [];
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(stream(event(1)));
  const api = new TerminalsApi({ baseUrl: '', fetch: fetcher });
  const stop = api.subscribe(
    'session',
    'terminal',
    { generation: identity.generation, after: 0 },
    {
      onEvent() {},
      onError: (error) => errors.push(error),
    },
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(errors).toHaveLength(1);
  expect(fetcher).toHaveBeenCalledTimes(1);
  stop();
});

it('[TC-WBD-004-N] keeps the terminal frame bound even for an unexpected domain event', async () => {
  vi.useFakeTimers();
  const errors: unknown[] = [];
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(`event: domain\ndata: ${'x'.repeat(2_100_000)}`));
  const api = new TerminalsApi({ baseUrl: '', fetch: fetcher });
  const stop = api.subscribe(
    'session',
    'terminal',
    { generation: identity.generation, after: 0 },
    { onEvent() {}, onError: (error) => errors.push(error) },
  );
  await vi.advanceTimersByTimeAsync(300);
  stop();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(errors).toHaveLength(1);
});
