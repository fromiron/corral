import { request as httpRequest } from 'node:http';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { drainRejectedBody, type RejectedBodyDrain } from '../src/rejected-body.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

async function server(bodyLimit = 1024, requestTimeoutMs = 1000, elapsedMs?: number) {
  const app = Fastify({ bodyLimit, requestTimeout: requestTimeoutMs });
  cleanups.push(() => app.close());
  let rejected!: () => void;
  const rejection = new Promise<void>((resolve) => {
    rejected = resolve;
  });
  let drained!: (result: RejectedBodyDrain) => void;
  const drain = new Promise<RejectedBodyDrain>((resolve) => {
    drained = resolve;
  });
  let handled = 0;
  app.post('/input', () => {
    handled++;
    return { accepted: true };
  });
  app.setErrorHandler(async (error, request, reply) => {
    if (
      !(error instanceof Error) ||
      !('code' in error) ||
      error.code !== 'FST_ERR_CTP_BODY_TOO_LARGE'
    )
      throw error;
    rejected();
    const result = await drainRejectedBody(request.raw, {
      bodyLimit: request.routeOptions.bodyLimit,
      requestTimeoutMs,
      elapsedMs: elapsedMs ?? reply.elapsedTime,
    });
    drained(result);
    if (result !== 'drained') {
      reply.hijack();
      reply.raw.destroy();
      return;
    }
    return reply.code(413).send({
      error: { code: 'SCHEMA_INVALID', message: 'request body is too large' },
    });
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('expected TCP listener');
  return {
    url: `http://127.0.0.1:${address.port}/input`,
    rejection,
    drain,
    handled: () => handled,
  };
}

function upload(url: string, length?: number) {
  let finished = false;
  let complete!: (value: { status?: number; early?: boolean; error?: string }) => void;
  const result = new Promise<{ status?: number; early?: boolean; error?: string }>((resolve) => {
    complete = resolve;
  });
  const request = httpRequest(
    url,
    {
      method: 'POST',
      agent: false,
      headers: {
        'content-type': 'application/json',
        ...(length === undefined ? {} : { 'content-length': length }),
      },
    },
    (response) => {
      const early = !finished;
      response.resume();
      response.once('end', () => complete({ status: response.statusCode, early }));
      response.once('error', (error: NodeJS.ErrnoException) => complete({ error: error.code }));
    },
  );
  request.once('error', (error: NodeJS.ErrnoException) => complete({ error: error.code }));
  return {
    request,
    result,
    end(body?: string) {
      finished = true;
      request.end(body);
    },
  };
}

describe('bounded oversized-body refusal over real HTTP', () => {
  it('[TC-SEC-002-N] finishes receiving a bounded upload before sending its readable 413', async () => {
    const endpoint = await server();
    const body = 'x'.repeat(1200);
    const client = upload(endpoint.url, body.length);
    client.request.write(body.slice(0, 100));
    await endpoint.rejection;
    await new Promise((resolve) => setTimeout(resolve, 30));
    client.end(body.slice(100));
    expect(await client.result).toEqual({ status: 413, early: false });
    expect(await endpoint.drain).toBe('drained');
    expect(endpoint.handled()).toBe(0);
  });

  it.each([false, true])(
    '[TC-SEC-002-N] delivers repeated near-limit refusals without resetting the client, chunked=%s',
    async (chunked) => {
      const endpoint = await server(2 * 1024 * 1024);
      const body = JSON.stringify({ text: 'x'.repeat(2 * 1024 * 1024) });
      for (let count = 0; count < 20; count++) {
        const client = upload(endpoint.url, chunked ? undefined : Buffer.byteLength(body));
        if (chunked) {
          client.request.write(body.slice(0, 1024 * 1024));
          client.end(body.slice(1024 * 1024));
        } else client.end(body);
        expect(await client.result).toEqual({ status: 413, early: false });
      }
      expect(endpoint.handled()).toBe(0);
    },
  );

  it('[TC-SEC-002-N] closes excessive rejected input after the bounded discard budget', async () => {
    const endpoint = await server(1024);
    const client = upload(endpoint.url, 4096);
    client.request.write('x'.repeat(3072));
    expect(await endpoint.drain).toBe('byte_limit');
    expect((await client.result).error).toBeTruthy();
    expect(endpoint.handled()).toBe(0);
  });

  it('[TC-SEC-002-N] uses only the remaining request time for a stalled upload', async () => {
    const endpoint = await server(1024, 1000, 950);
    const client = upload(endpoint.url, 1200);
    client.request.write('x');
    const started = Date.now();
    expect(await endpoint.drain).toBe('timeout');
    expect((await client.result).error).toBeTruthy();
    expect(Date.now() - started).toBeLessThan(700);
    expect(endpoint.handled()).toBe(0);
  });

  it('[TC-SEC-002-N] releases the rejected request when its client aborts', async () => {
    const endpoint = await server();
    const client = upload(endpoint.url, 1200);
    client.request.write('x');
    await endpoint.rejection;
    client.request.destroy();
    expect(await endpoint.drain).toBe('aborted');
    expect((await client.result).error).toBeTruthy();
    expect(endpoint.handled()).toBe(0);
  });
});
