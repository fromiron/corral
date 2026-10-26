import type { RunEvent } from '@corral/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpSseTransport, openSession } from '../src/index.ts';

const event = (runSeq: number): RunEvent => ({
  schemaVersion: '0.1',
  eventId: `event_${runSeq}`,
  runId: 'run_test',
  runSeq,
  recordedAt: '2026-10-15T00:00:00.000Z',
  actor: { kind: 'runtime', id: 'runtime' },
  causedByEventIds: [],
  type: 'run.state_changed',
  payload: { from: 'running', to: 'succeeded', reasonCode: 'done' },
});
const sse = (...events: RunEvent[]) =>
  new Response(events.map((e) => `event: domain\ndata: ${JSON.stringify(e)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
afterEach(() => vi.useRealTimers());

describe('HTTP boundaries and replay', () => {
  it('acquires CSRF before mutation and excludes session bootstrap', async () => {
    const requests: { path: string; headers: Headers }[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const path = String(input);
      requests.push({ path, headers: new Headers(init?.headers) });
      if (path.endsWith('/session') && init?.method === 'POST')
        return new Response(null, { status: 204 });
      if (path.endsWith('/session')) return Response.json({ ok: true, csrfToken: 'csrf-test' });
      return Response.json({ status: 'accepted' });
    };
    await openSession({ baseUrl: 'http://localhost', fetch: fetcher }, 'one-time');
    expect(requests).toHaveLength(1);
    const transport = new HttpSseTransport({ baseUrl: 'http://localhost', fetch: fetcher });
    await transport.sendCommand({
      schemaVersion: '0.1',
      commandId: 'cancel_test',
      runId: 'run_test',
      type: 'cancel',
      payload: { scope: { kind: 'run' }, reason: 'test' },
    });
    expect(requests).toHaveLength(3);
    expect(requests[2]?.headers.get('x-corral-csrf')).toBe('csrf-test');
  });

  it('reconnects at committed cursor, discards duplicate events and retrieves lost events', async () => {
    vi.useFakeTimers();
    const cursors: string[] = [];
    const received: number[] = [];
    const errors: unknown[] = [];
    const fetcher: typeof fetch = async (_input, init) => {
      cursors.push(new Headers(init?.headers).get('last-event-id') ?? '');
      return cursors.length === 1 ? sse(event(1), event(3)) : sse(event(1), event(2), event(3));
    };
    const transport = new HttpSseTransport({ baseUrl: '', fetch: fetcher });
    const stop = transport.subscribe('run_test', 0, {
      onEvent: (e) => received.push(e.runSeq),
      onError: (e) => errors.push(e),
    });
    await vi.advanceTimersByTimeAsync(300);
    stop();
    expect(received).toEqual([1, 2, 3]);
    expect(cursors.slice(0, 2)).toEqual(['0', '1']);
    expect(errors).toEqual([]);
  });

  it('reads coalesced replay frames larger than the individual frame bound', async () => {
    vi.useFakeTimers();
    const received: number[] = [];
    const events = Array.from({ length: 4000 }, (_, index) => event(index + 1));
    const transport = new HttpSseTransport({ baseUrl: '', fetch: async () => sse(...events) });
    const stop = transport.subscribe('run_test', 0, { onEvent: (e) => received.push(e.runSeq) });
    await vi.advanceTimersByTimeAsync(0);
    stop();
    expect(received).toHaveLength(4000);
  });

  it('accepts CRLF split across network chunks', async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    const chunks = ['event: domain\r', `\ndata: ${JSON.stringify(event(1))}\r`, '\n\r', '\n'];
    const transport = new HttpSseTransport({
      baseUrl: '',
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
              controller.close();
            },
          }),
        ),
    });
    const received: number[] = [];
    const stop = transport.subscribe('run_test', 0, { onEvent: (e) => received.push(e.runSeq) });
    await vi.advanceTimersByTimeAsync(0);
    stop();
    expect(received).toEqual([1]);
  });

  it('replays an interrupted large domain frame from its unadvanced cursor', async () => {
    vi.useFakeTimers();
    const large = {
      ...event(1),
      type: 'run.state_changed',
      payload: { from: 'running', to: 'succeeded', reasonCode: 'x'.repeat(2_200_000) },
    } satisfies RunEvent;
    const whole = `event: domain\ndata: ${JSON.stringify(large)}\n\n`;
    const cursors: string[] = [];
    const transport = new HttpSseTransport({
      baseUrl: '',
      fetch: async (_input, init) => {
        cursors.push(new Headers(init?.headers).get('last-event-id') ?? '');
        return new Response(cursors.length === 1 ? whole.slice(0, -20) : whole);
      },
    });
    const received: RunEvent[] = [];
    const stop = transport.subscribe('run_test', 0, { onEvent: (e) => received.push(e) });
    await vi.advanceTimersByTimeAsync(300);
    stop();
    expect(cursors).toEqual(['0', '0']);
    expect(received).toEqual([large]);
  });

  it.each([
    ['domain', '{"type":"invalid"}'],
    ['stream', '가'.repeat(800_000)],
    ['domain', 'not json'],
  ])('stops on an invalid %s frame without retrying', async (kind, data) => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response(`event: ${kind}\ndata: ${data}\n\n`));
    const errors: unknown[] = [];
    const transport = new HttpSseTransport({ baseUrl: '', fetch: fetcher });
    const stop = transport.subscribe('run_test', 0, {
      onEvent() {
        throw new Error('invalid frame must not be delivered');
      },
      onError: (error) => errors.push(error),
    });
    await vi.advanceTimersByTimeAsync(20_000);
    stop();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(errors).toHaveLength(1);
  });

  it('retains the size bound for an unfinished comment or header', async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response(':'.repeat(2 * 1024 * 1024 + 1)));
    const errors: unknown[] = [];
    const transport = new HttpSseTransport({ baseUrl: '', fetch: fetcher });
    const stop = transport.subscribe('run_test', 0, {
      onEvent() {},
      onError: (e) => errors.push(e),
    });
    await vi.advanceTimersByTimeAsync(20_000);
    stop();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(errors).toHaveLength(1);
  });

  it('cancellation stops retrying a disconnected stream', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'));
    const transport = new HttpSseTransport({ baseUrl: '', fetch: fetcher });
    const stop = transport.subscribe('run_test', 0, { onEvent() {} });
    await vi.advanceTimersByTimeAsync(10);
    stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
