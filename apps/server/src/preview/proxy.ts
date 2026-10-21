import {
  Agent,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { connect, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

export type ConnectionAttestation = (
  operationId: string,
  port: number,
  peerPort: number,
) => Promise<boolean>;

/** No request bytes reach a listener before the kernel ties this connection to its owner. */
export async function ownedConnection(
  operationId: string,
  port: number,
  attest: ConnectionAttestation,
): Promise<Socket> {
  const pending = AbortSignal.timeout(5000);
  const socket = connect({ host: '127.0.0.1', port });
  socket.setTimeout(5000, () => socket.destroy(new Error('preview connection timed out')));
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  try {
    // TCP connect may finish before accept() exposes the server socket in its process FDs.
    while (socket.localPort && !socket.destroyed) {
      pending.throwIfAborted();
      if (await attest(operationId, port, socket.localPort)) {
        pending.throwIfAborted();
        if (socket.destroyed) break;
        socket.setTimeout(0);
        return socket;
      }
      await delay(50, undefined, { signal: pending });
    }
    throw new Error('service does not own this connection');
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

function headers(request: IncomingMessage, port: number) {
  const result: IncomingHttpHeaders = { ...request.headers, host: `127.0.0.1:${port}` };
  for (const key of ['proxy-authorization', 'x-corral-preview']) delete result[key];
  if (result.origin) result.origin = `http://127.0.0.1:${port}`;
  return result;
}

/** A fresh Agent consumes exactly the already-attested socket; no pool can reconnect it. */
function socketAgent(socket: Socket) {
  const agent = new Agent({ keepAlive: false });
  agent.createConnection = () => socket;
  return agent;
}

export async function proxyHttp(input: {
  operationId: string;
  port: number;
  origin: string;
  request: IncomingMessage;
  response: ServerResponse;
  attest: ConnectionAttestation;
}) {
  const socket = await ownedConnection(input.operationId, input.port, input.attest);
  const agent = socketAgent(socket);
  const upstream = httpRequest({
    hostname: '127.0.0.1',
    port: input.port,
    path: input.request.url,
    method: input.request.method,
    headers: headers(input.request, input.port),
    agent,
  });
  input.response.once('close', () => {
    upstream.destroy();
    agent.destroy();
  });
  upstream.once('error', () => {
    if (!input.response.headersSent) input.response.writeHead(502);
    input.response.end('Owned preview service unavailable');
  });
  upstream.once('response', (response) => {
    const output = { ...response.headers };
    // Only the private lease's isolated desktop/browser context reaches this proxy.
    // Preserve the application's own sessions while keeping cookies host-only on the proxy.
    if (output['set-cookie'])
      output['set-cookie'] = output['set-cookie'].map((cookie) =>
        cookie.replace(/;\s*domain=127\.0\.0\.1(?=;|$)/gi, ''),
      );
    delete output['content-security-policy'];
    delete output['x-frame-options'];
    if (output.location) {
      const target = new URL(output.location, `http://127.0.0.1:${input.port}`);
      if (target.origin !== `http://127.0.0.1:${input.port}`) {
        response.destroy();
        input.response.writeHead(403).end('Preview redirects cannot leave their owned service');
        return;
      }
      output.location = `${input.origin}${target.pathname}${target.search}${target.hash}`;
    }
    input.response.writeHead(response.statusCode ?? 502, output);
    response.pipe(input.response);
  });
  input.request.pipe(upstream);
}

export async function proxyWebSocket(input: {
  operationId: string;
  port: number;
  request: IncomingMessage;
  client: Duplex;
  head: Buffer;
  attest: ConnectionAttestation;
}) {
  const socket = await ownedConnection(input.operationId, input.port, input.attest);
  const agent = socketAgent(socket);
  const upstream = httpRequest({
    hostname: '127.0.0.1',
    port: input.port,
    path: input.request.url,
    method: 'GET',
    headers: headers(input.request, input.port),
    agent,
  });
  input.client.once('close', () => {
    upstream.destroy();
    socket.destroy();
    agent.destroy();
  });
  upstream.once('error', () => input.client.destroy());
  upstream.once('response', (response) => {
    response.destroy();
    input.client.destroy();
  });
  upstream.once('upgrade', (response, upgraded, head) => {
    const responseHeaders = Object.entries(response.headers).flatMap(([name, value]) =>
      value === undefined
        ? []
        : (Array.isArray(value) ? value : [value]).map((item) => `${name}: ${item}`),
    );
    input.client.write(
      `HTTP/1.1 101 Switching Protocols\r\n${responseHeaders.join('\r\n')}\r\n\r\n`,
    );
    if (head.length) input.client.write(head);
    if (input.head.length) upgraded.write(input.head);
    upgraded.on('error', () => input.client.destroy());
    input.client.on('error', () => upgraded.destroy());
    upgraded.pipe(input.client);
    input.client.pipe(upgraded);
  });
  upstream.end();
}
