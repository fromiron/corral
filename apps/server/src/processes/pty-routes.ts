import {
  type ErrorCode,
  Identifier,
  MAX_TERMINAL_INPUT_BYTES,
  TerminalControllerChange,
  TerminalCreate,
  TerminalIdentity,
  TerminalInput,
  TerminalResize,
  type TerminalStreamMessage,
} from '@corral/contracts';
import { ToolRefusal } from '@corral/core';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { WorkspaceError } from '../files/service.ts';
import { type InteractiveRequestLimiter, SECURITY_HEADERS } from '../security.ts';
import { boundedSseWriter } from '../sse.ts';
import type { PtyRuntime } from './pty.ts';

const BASE = '/api/v1/sessions/:sessionId/terminals';
export const PTY_INTERACTIVE_ROUTES = [`${BASE}/:terminalId/input`, `${BASE}/:terminalId/resize`];
const Params = z.strictObject({ sessionId: Identifier, terminalId: Identifier.optional() });
const Cursor = z.strictObject({
  generation: Identifier,
  after: z.coerce.number().int().min(0).default(0),
});
type Route = { Params: { sessionId: string; terminalId: string } };

/** Registered under the existing Host, Origin, session and CSRF hooks. */
export function registerTerminalRoutes(
  app: FastifyInstance,
  options: {
    terminals: PtyRuntime;
    hasSession: (sessionId: string) => Promise<boolean>;
    fail: (reply: FastifyReply, code: ErrorCode, message: string) => FastifyReply;
    streams: Set<() => void>;
    limiter: InteractiveRequestLimiter;
  },
) {
  const { terminals, fail } = options;
  const run = async (
    reply: FastifyReply,
    params: Route['Params'] | { sessionId: string },
    operation: () => unknown,
  ) => {
    if (!Params.safeParse(params).success)
      return fail(reply, 'SCHEMA_INVALID', 'invalid terminal target');
    if (!(await options.hasSession(params.sessionId)))
      return fail(reply, 'TARGET_NOT_FOUND', 'no such session');
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ToolRefusal || error instanceof WorkspaceError)
        return fail(reply, error.code, error.message);
      return fail(reply, 'STORAGE_UNAVAILABLE', 'the terminal operation failed');
    }
  };
  app.get<Route>(BASE, (request, reply) =>
    run(reply, request.params, () => terminals.list(request.params.sessionId)),
  );
  app.get<Route>(`${BASE}/:terminalId`, (request, reply) =>
    run(reply, request.params, () =>
      terminals.get(request.params.sessionId, request.params.terminalId),
    ),
  );
  app.post<Route>(BASE, (request, reply) => {
    const input = TerminalCreate.safeParse(request.body);
    if (!input.success || input.data.target.sessionId !== request.params.sessionId)
      return fail(reply, 'SCHEMA_INVALID', 'invalid terminal create request');
    return run(reply, request.params, () => terminals.create(request.params.sessionId, input.data));
  });
  app.post<Route>(`${BASE}/:terminalId/control`, (request, reply) => {
    const input = TerminalControllerChange.safeParse(request.body);
    if (!input.success) return fail(reply, 'SCHEMA_INVALID', 'invalid terminal controller request');
    return run(reply, request.params, () =>
      terminals.control(request.params.sessionId, request.params.terminalId, input.data),
    );
  });
  app.post<Route>(`${BASE}/:terminalId/stop`, (request, reply) => {
    const input = TerminalIdentity.safeParse(request.body);
    if (!input.success) return fail(reply, 'SCHEMA_INVALID', 'invalid terminal stop request');
    return run(reply, request.params, () =>
      terminals.stop(request.params.sessionId, request.params.terminalId, input.data),
    );
  });
  const allow = (reply: FastifyReply, bytes: number) => {
    if (options.limiter.allow(bytes)) return true;
    void reply
      .header('retry-after', '1')
      .code(429)
      .send({ error: { code: 'LIMIT_REACHED', message: 'terminal input rate exceeded' } });
    return false;
  };
  app.post<Route>(
    `${BASE}/:terminalId/input`,
    { bodyLimit: MAX_TERMINAL_INPUT_BYTES * 6 + 4096 },
    (request, reply) => {
      if (!allow(reply, Buffer.byteLength(JSON.stringify(request.body ?? null)))) return reply;
      const input = TerminalInput.safeParse(request.body);
      if (!input.success || Buffer.byteLength(input.data.data) > MAX_TERMINAL_INPUT_BYTES)
        return fail(reply, 'SCHEMA_INVALID', 'invalid terminal input frame');
      return run(reply, request.params, () =>
        terminals.input(request.params.sessionId, request.params.terminalId, input.data),
      );
    },
  );
  app.post<Route>(`${BASE}/:terminalId/resize`, { bodyLimit: 4096 }, (request, reply) => {
    if (!allow(reply, Buffer.byteLength(JSON.stringify(request.body ?? null)))) return reply;
    const input = TerminalResize.safeParse(request.body);
    if (!input.success) return fail(reply, 'SCHEMA_INVALID', 'invalid terminal resize frame');
    return run(reply, request.params, () =>
      terminals.resize(request.params.sessionId, request.params.terminalId, input.data),
    );
  });
  app.get<Route>(`${BASE}/:terminalId/events`, (request, reply) => {
    const query = Cursor.safeParse(request.query);
    const header = request.headers['last-event-id'];
    const afterSeq =
      typeof header === 'string' && /^\d+$/.test(header)
        ? Number(header)
        : query.success
          ? query.data.after
          : NaN;
    if (
      !query.success ||
      !Number.isSafeInteger(afterSeq) ||
      (header !== undefined && (typeof header !== 'string' || !/^\d+$/.test(header)))
    )
      return fail(reply, 'SCHEMA_INVALID', 'invalid terminal stream cursor');
    return run(reply, request.params, () => {
      if (options.streams.size >= 16)
        return reply.code(429).send({
          error: { code: 'LIMIT_REACHED', message: 'at most 16 event streams may be open' },
        });
      let send = (_frame: string) => false;
      const emit = (message: TerminalStreamMessage) =>
        send(
          `${message.type === 'status' ? '' : `id: ${message.sequence}\n`}event: terminal\ndata: ${JSON.stringify(message)}\n\n`,
        );
      const subscription = terminals.subscribe(
        request.params.sessionId,
        request.params.terminalId,
        { generation: query.data.generation, afterSeq },
        emit,
      );
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'private, no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
        ...SECURITY_HEADERS,
      });
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let flushDeadline: ReturnType<typeof setTimeout> | undefined;
      let closed = false;
      const release = () => {
        closed = true;
        clearInterval(heartbeat);
        clearTimeout(flushDeadline);
        subscription.close();
        options.streams.delete(close);
      };
      const close = () => {
        release();
        res.destroy();
      };
      send = boundedSseWriter(res, () => {
        closed = true;
        clearInterval(heartbeat);
        subscription.close();
        res.end();
        flushDeadline = setTimeout(close, 10_000);
        flushDeadline.unref();
      });
      options.streams.add(close);
      res.once('close', release);
      emit({ type: 'status', terminal: subscription.view });
      for (const event of subscription.events) if (!emit(event)) break;
      if (!closed) heartbeat = setInterval(() => send(': ping\n\n'), 15_000);
    });
  });
}
