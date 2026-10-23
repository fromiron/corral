import type { TerminalInput, TerminalStreamMessage, TerminalView } from '@corral/contracts';
import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import type { PtyRuntime } from '../src/processes/pty.ts';
import { registerTerminalRoutes } from '../src/processes/pty-routes.ts';
import { InteractiveRequestLimiter } from '../src/security.ts';

const view: TerminalView = {
  terminalId: 'terminal',
  target: {
    hostId: 'host',
    projectId: 'default',
    bindingId: 'binding',
    sessionId: 'session',
    copyGeneration: 1,
  },
  generation: 'generation',
  shellId: 'bash',
  state: 'running',
  initialCols: 80,
  initialRows: 24,
  cols: 80,
  rows: 24,
  lastSequence: 2,
  replayAvailable: true,
  controllerGeneration: 1,
  controller: { attachmentId: 'attachment', generation: 1, acceptedSequence: 0 },
  exitCode: null,
  error: null,
};
const input: TerminalInput = {
  target: view.target,
  generation: view.generation,
  attachmentId: 'attachment',
  controllerGeneration: 1,
  sequence: 1,
  data: 'hello\r',
};
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});
function fixture() {
  const app = Fastify();
  apps.push(app);
  let detach = () => {};
  const detached = new Promise<void>((resolve) => {
    detach = resolve;
  });
  const listeners = new Set<(message: TerminalStreamMessage) => void>();
  const runtime = {
    input: vi.fn(() => ({
      generation: view.generation,
      controllerGeneration: 1,
      acceptedSequence: 1,
    })),
    stop: vi.fn(() => view),
    get: vi.fn(() => view),
    subscribe: vi.fn(
      (
        _session: string,
        _terminal: string,
        _cursor: unknown,
        listener: (message: TerminalStreamMessage) => void,
      ) => {
        listeners.add(listener);
        return {
          view,
          events: [
            { generation: view.generation, sequence: 1, type: 'resize', cols: 80, rows: 24 },
            {
              generation: view.generation,
              sequence: 2,
              type: 'output',
              data: '\u001b[31m가\n\nevent: forged\ndata: injected\r\n',
            },
          ],
          close: () => {
            listeners.delete(listener);
            detach();
          },
        };
      },
    ),
  };
  const streams = new Set<() => void>();
  app.addHook('onClose', async () => {
    for (const close of streams) close();
  });
  registerTerminalRoutes(app, {
    terminals: runtime as unknown as PtyRuntime,
    hasSession: async (id) => id === 'session',
    streams,
    limiter: new InteractiveRequestLimiter(() => 0),
    fail: (reply, code, message) =>
      reply
        .code(code === 'TARGET_NOT_FOUND' ? 404 : code === 'SCHEMA_INVALID' ? 400 : 503)
        .send({ error: { code, message } }),
  });
  return { app, runtime, detached, listeners, streams };
}

it('[TC-WBD-004-N] validates the UTF-8 input cap and controller frame before dispatch', async () => {
  const { app, runtime } = fixture();
  const url = '/api/v1/sessions/session/terminals/terminal/input';
  expect((await app.inject({ method: 'POST', url, payload: input })).statusCode).toBe(200);
  expect(runtime.input).toHaveBeenCalledExactlyOnceWith('session', 'terminal', input);
  for (const payload of [
    { ...input, data: '가'.repeat(6000) },
    { ...input, sequence: 0 },
  ]) {
    expect((await app.inject({ method: 'POST', url, payload })).statusCode).toBe(400);
  }
  expect(runtime.input).toHaveBeenCalledTimes(1);
});

it('[TC-WBD-004-H] JSON-frames ANSI output and detaches a viewer without stopping its shell', async () => {
  const { app, runtime, detached, listeners, streams } = fixture();
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  const response = await fetch(
    `${url}/api/v1/sessions/session/terminals/terminal/events?generation=generation&after=0`,
  );
  if (!response.body) throw new Error('terminal stream body missing');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (text.split('\n\n').length < 4) {
    const { value, done } = await reader.read();
    if (done) throw new Error('terminal stream ended before replay');
    text += decoder.decode(value, { stream: true });
  }
  const frames = text.trim().split('\n\n');
  expect(frames).toHaveLength(3);
  const messages = frames.map((frame) =>
    JSON.parse(
      frame
        .split('\n')
        .find((line) => line.startsWith('data: '))
        ?.slice(6) ?? '',
    ),
  );
  expect(messages[0]).toEqual({ type: 'status', terminal: view });
  expect(messages[2]).toMatchObject({
    type: 'output',
    sequence: 2,
    data: '\u001b[31m가\n\nevent: forged\ndata: injected\r\n',
  });
  expect(streams.size).toBe(1);
  await reader.cancel();
  await detached;
  expect(listeners.size).toBe(0);
  expect(streams.size).toBe(0);
  expect(runtime.stop).not.toHaveBeenCalled();
});

it('[TC-WBD-004-N] does not attach an invalid cursor or another session', async () => {
  const { app, runtime } = fixture();
  expect(
    (
      await app.inject({
        url: '/api/v1/sessions/session/terminals/terminal/events?generation=generation&after=0',
        headers: { 'last-event-id': '-1' },
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (await app.inject({ url: '/api/v1/sessions/missing/terminals/terminal' })).statusCode,
  ).toBe(404);
  expect(runtime.subscribe).not.toHaveBeenCalled();
  expect(runtime.get).not.toHaveBeenCalled();
});

it('[TC-WBD-004-N] applies the frame budget to malformed input as well as accepted keystrokes', async () => {
  const { app, runtime } = fixture();
  const url = '/api/v1/sessions/session/terminals/terminal/input';
  for (let frame = 0; frame < 120; frame++) {
    expect(
      (await app.inject({ method: 'POST', url, payload: { ...input, sequence: 0 } })).statusCode,
    ).toBe(400);
  }
  expect((await app.inject({ method: 'POST', url, payload: input })).statusCode).toBe(429);
  expect(runtime.input).not.toHaveBeenCalled();
});
