import { randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, join, resolve } from 'node:path';
import type { Duplex } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import type { StartPreviewInput, WorkspacePreview } from '@corral/client';
import { type DefaultTreeAdapterTypes, parse, serialize } from 'parse5';
import { safeRelative } from '../files/service.ts';
import { ownedConnection, proxyHttp, proxyWebSocket } from './proxy.ts';

type SessionConnectionAttestation = (
  sessionId: string,
  operationId: string,
  port: number,
  peerPort: number,
) => Promise<boolean>;

export interface DesktopPreviewTarget {
  url: string;
  origin: string;
  webSocketOrigins: string[];
  headers: Record<string, string>;
  pathPrefix?: string;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};
const ENTRY = new Set(['.html', '.htm', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']);
const MAX_BYTES = 8 * 1024 * 1024;
const HOST = '127.0.0.2';

/** No origin is granted because it is loopback: every lease owns its listener and path key. */
export class PreviewService {
  private readonly leases = new Map<
    string,
    {
      view: WorkspacePreview;
      server: Server;
      root: string;
      secret: string;
      pending: boolean;
      prefix?: string;
      sockets: Set<Duplex>;
      delegations: Map<string, { token: string; expiresAt: number }>;
      service?: { operationId: string; port: number };
    }
  >();
  private readonly resolveRoot: (sessionId: string, runId?: string) => Promise<string>;
  private readonly attest?: SessionConnectionAttestation;
  private readonly operationRun?: (
    sessionId: string,
    operationId: string,
  ) => Promise<string | undefined>;
  private readonly readSnapshot?: (
    sessionId: string,
    runId: string,
    path: string,
  ) => Promise<Buffer | null>;
  private readonly now: () => number;
  private readonly pendingStarts = new Map<string, number>();
  private closed = false;
  private readonly stopListeners = new Set<(leaseId: string) => Promise<void>>();

  onStop(listener: (leaseId: string) => Promise<void>) {
    this.stopListeners.add(listener);
    return () => this.stopListeners.delete(listener);
  }

  constructor(options: {
    resolveRoot: (sessionId: string, runId?: string) => Promise<string>;
    attestConnection?: SessionConnectionAttestation;
    operationRun?: (sessionId: string, operationId: string) => Promise<string | undefined>;
    readSnapshot?: (sessionId: string, runId: string, path: string) => Promise<Buffer | null>;
    now?: () => number;
  }) {
    this.resolveRoot = options.resolveRoot;
    this.attest = options.attestConnection;
    this.operationRun = options.operationRun;
    this.readSnapshot = options.readSnapshot;
    this.now = options.now ?? Date.now;
  }

  list(sessionId: string): WorkspacePreview[] {
    return [...this.leases.values()]
      .filter(({ view, pending }) => view.sessionId === sessionId && !pending)
      .map(({ view }) => ({ ...view }));
  }

  async start(sessionId: string, input: StartPreviewInput): Promise<WorkspacePreview> {
    if (this.closed) throw new Error('preview service stopped');
    const pending = this.pendingStarts.get(sessionId) ?? 0;
    if (this.list(sessionId).filter((item) => item.state === 'ready').length + pending >= 8)
      throw new Error('close an existing preview before opening another');
    const pendingTotal = [...this.pendingStarts.values()].reduce((sum, count) => sum + count, 0);
    if (
      [...this.leases.values()].filter((lease) => !lease.pending && lease.view.state === 'ready')
        .length +
        pendingTotal >=
      64
    )
      throw new Error('preview capacity reached');
    this.pendingStarts.set(sessionId, pending + 1);
    try {
      return 'operationId' in input
        ? await this.startService(sessionId, input)
        : await this.startFile(sessionId, input);
    } finally {
      const remaining = (this.pendingStarts.get(sessionId) ?? 1) - 1;
      if (remaining) this.pendingStarts.set(sessionId, remaining);
      else this.pendingStarts.delete(sessionId);
    }
  }

  private async startFile(
    sessionId: string,
    input: Extract<StartPreviewInput, { path: string }>,
  ): Promise<WorkspacePreview> {
    const path = safeAssetPath(input.path);
    if (!ENTRY.has(extname(path).toLowerCase())) throw new Error('file has no supported preview');
    const root = await this.resolveRoot(sessionId, input.runId);
    const read = async (path: string) => {
      const snapshot = input.runId ? await this.readSnapshot?.(sessionId, input.runId, path) : null;
      if (snapshot) {
        if (snapshot.length > MAX_BYTES) throw new Error('preview asset exceeds size limit');
        return snapshot;
      }
      return readAsset(root, path);
    };
    await read(path);
    const key = randomBytes(32).toString('base64url');
    const secret = randomBytes(32).toString('base64url');
    const prefix = `/${key}/`;
    let origin = '';
    const view: WorkspacePreview = {
      leaseId: `preview_${randomUUID().replaceAll('-', '')}`,
      sessionId,
      ...(input.runId ? { runId: input.runId } : {}),
      kind: 'static',
      url: '',
      origin: '',
      path,
      state: 'ready',
      createdAt: new Date().toISOString(),
    };
    const server = createServer(async (request, response) => {
      response.setHeader('cache-control', 'no-store');
      response.setHeader('referrer-policy', 'no-referrer');
      response.setHeader('x-content-type-options', 'nosniff');
      const interactive =
        request.headers['x-corral-preview'] === secret ||
        this.delegated(view.leaseId, request.headers['x-corral-preview']);
      response.setHeader(
        'content-security-policy',
        [
          interactive ? 'sandbox allow-scripts' : 'sandbox',
          "default-src 'none'",
          ...(interactive ? [`script-src ${origin} 'unsafe-inline'`] : []),
          `style-src ${origin}${interactive ? '' : prefix} 'unsafe-inline'`,
          `img-src ${origin}${interactive ? '' : prefix} data: blob:`,
          `font-src ${origin}${interactive ? '' : prefix}`,
          `connect-src ${origin}${interactive ? '' : prefix}`,
          "base-uri 'none'",
          "form-action 'none'",
          "object-src 'none'",
          "worker-src 'none'",
        ].join('; '),
      );
      // An opaque sandbox may fetch modules/assets only when it also holds the path key.
      response.setHeader('access-control-allow-origin', 'null');
      if (request.headers['x-corral-preview'] !== undefined && !interactive) {
        response.writeHead(403).end('Preview credential expired');
        return;
      }
      if (!['GET', 'HEAD'].includes(request.method ?? '')) {
        response.writeHead(405).end();
        return;
      }
      try {
        if (
          view.state !== 'ready' ||
          request.headers.host !== new URL(origin).host ||
          (await this.resolveRoot(sessionId, input.runId)) !== root
        )
          throw new Error('lease no longer owns this worktree');
        const url = new URL(request.url ?? '', origin);
        if (!interactive && !url.pathname.startsWith(prefix)) throw new Error('unknown lease');
        const rel = safeAssetPath(
          decodeURIComponent(
            url.pathname.slice(url.pathname.startsWith(prefix) ? prefix.length : 1),
          ),
        );
        const bytes = await read(rel);
        // Revocation during file I/O must not publish the bytes.
        if (view.state !== 'ready' || (await this.resolveRoot(sessionId, input.runId)) !== root)
          throw new Error('preview revoked');
        response.writeHead(200, {
          'content-type': MIME[extname(rel).toLowerCase()] ?? 'application/octet-stream',
        });
        response.end(
          request.method === 'HEAD'
            ? undefined
            : !interactive && ['.html', '.htm'].includes(extname(rel).toLowerCase())
              ? staticDocument(bytes.toString('utf8'), `${origin}${prefix}`, url.href)
              : bytes,
        );
      } catch {
        response.writeHead(404).end('Preview unavailable');
      }
    });
    server.on('upgrade', (_request, socket) => socket.destroy());
    server.requestTimeout = 5000;
    server.headersTimeout = 5000;
    await new Promise<void>((done, reject) => {
      server.once('error', reject);
      server.listen(0, HOST, done);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      throw new Error('preview listener unavailable');
    }
    origin = `http://${HOST}:${address.port}`;
    view.origin = origin;
    view.url = `${origin}${prefix}${path.split('/').map(encodeURIComponent).join('/')}`;
    this.leases.set(view.leaseId, {
      view,
      root,
      server,
      secret,
      pending: true,
      prefix,
      sockets: new Set(),
      delegations: new Map(),
    });
    if (this.closed) {
      await this.stop(sessionId, view.leaseId);
      throw new Error('preview service stopped');
    }
    try {
      await responseReady(view.url, secret);
      const lease = this.leases.get(view.leaseId);
      if (this.closed || !lease || lease.view.state !== 'ready')
        throw new Error('preview service stopped');
      lease.pending = false;
    } catch (error) {
      await this.stop(sessionId, view.leaseId);
      throw error;
    }
    return { ...view };
  }

  private async startService(
    sessionId: string,
    input: Extract<StartPreviewInput, { operationId: string }>,
  ): Promise<WorkspacePreview> {
    const attestConnection = this.attest;
    const operationRun = this.operationRun;
    if (this.closed || !attestConnection || !operationRun)
      throw new Error('owned service previews unavailable');
    if (!Number.isSafeInteger(input.port) || input.port < 1024 || input.port > 65535)
      throw new Error('invalid service port');
    const runId = await operationRun(sessionId, input.operationId);
    const root = await this.resolveRoot(sessionId, runId);
    const attest = (operationId: string, port: number, peerPort: number) =>
      attestConnection(sessionId, operationId, port, peerPort);
    // Process startup is not HTTP readiness. Use one bounded budget for bind and compilation.
    const startup = AbortSignal.timeout(15000);
    const requireLiveOwner = async () => {
      startup.throwIfAborted();
      if (
        this.closed ||
        (await operationRun(sessionId, input.operationId)) !== runId ||
        (await this.resolveRoot(sessionId, runId)) !== root
      )
        throw new Error('preview lease no longer owns this service');
      startup.throwIfAborted();
    };
    const retryStartup = async <T>(check: () => Promise<T>): Promise<T> => {
      while (true) {
        await requireLiveOwner();
        try {
          return await check();
        } catch (error) {
          startup.throwIfAborted();
          if (!startupRetryable(error)) throw error;
          await delay(75, undefined, { signal: startup });
        }
      }
    };
    const test = await retryStartup(() => {
      const probe = AbortSignal.any([startup, AbortSignal.timeout(1000)]);
      return new Promise<import('node:net').Socket>((resolve, reject) => {
        const aborted = () => reject(probe.reason);
        probe.addEventListener('abort', aborted, { once: true });
        void ownedConnection(input.operationId, input.port, attest).then(
          (socket) => {
            probe.removeEventListener('abort', aborted);
            if (probe.aborted) {
              socket.destroy();
              reject(probe.reason);
            } else resolve(socket);
          },
          (error: unknown) => {
            probe.removeEventListener('abort', aborted);
            reject(error);
          },
        );
      });
    });
    test.destroy();
    await requireLiveOwner();
    const path = input.entryPath ?? '/';
    if (
      !path.startsWith('/') ||
      path.startsWith('//') ||
      path.includes('\\') ||
      /[\r\n]/.test(path)
    )
      throw new Error('use a service-relative entry path');
    const secret = randomBytes(32).toString('base64url');
    const sockets = new Set<Duplex>();
    const view: WorkspacePreview = {
      leaseId: `preview_${randomUUID().replaceAll('-', '')}`,
      sessionId,
      runId,
      operationId: input.operationId,
      kind: 'service',
      url: '',
      origin: '',
      path,
      state: 'ready',
      createdAt: new Date().toISOString(),
    };
    const liveAttest = async (operationId: string, port: number, peerPort: number) =>
      view.state === 'ready' &&
      (await attest(operationId, port, peerPort)) &&
      view.state === 'ready' &&
      !this.closed;
    const authorized = async (request: import('node:http').IncomingMessage) => {
      if (
        view.state !== 'ready' ||
        request.headers.host !== new URL(view.origin).host ||
        (request.headers['x-corral-preview'] !== secret &&
          !this.delegated(view.leaseId, request.headers['x-corral-preview'])) ||
        new URL(request.url ?? '/', view.origin).origin !== view.origin ||
        (await this.resolveRoot(sessionId, runId)) !== root ||
        (await operationRun(sessionId, input.operationId)) !== runId
      )
        throw new Error('preview lease no longer owns this service');
    };
    const server = createServer(async (request, response) => {
      response.setHeader('cache-control', 'no-store');
      response.setHeader('referrer-policy', 'no-referrer');
      response.setHeader('x-content-type-options', 'nosniff');
      response.setHeader(
        'content-security-policy',
        [
          "default-src 'none'",
          `script-src ${view.origin} 'unsafe-inline' 'unsafe-eval'`,
          `style-src ${view.origin} 'unsafe-inline'`,
          `img-src ${view.origin} data: blob:`,
          `font-src ${view.origin} data:`,
          `connect-src ${view.origin} ${view.origin.replace('http:', 'ws:')}`,
          "base-uri 'none'",
          "form-action 'self'",
          "worker-src 'none'",
          "frame-src 'none'",
        ].join('; '),
      );
      try {
        await authorized(request);
        await proxyHttp({ ...input, origin: view.origin, request, response, attest: liveAttest });
      } catch {
        response.writeHead(403).end('Owned preview unavailable');
      }
    });
    server.on('upgrade', (request, client, head) => {
      sockets.add(client);
      client.once('close', () => sockets.delete(client));
      void authorized(request)
        .then(() =>
          proxyWebSocket({
            ...input,
            request,
            client,
            head,
            attest: liveAttest,
          }),
        )
        .catch(() => client.destroy());
    });
    await new Promise<void>((done, reject) => {
      server.once('error', reject);
      server.listen(0, HOST, done);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      throw new Error('listener unavailable');
    }
    view.origin = `http://${HOST}:${address.port}`;
    view.url = new URL(path, view.origin).href;
    this.leases.set(view.leaseId, {
      view,
      root,
      server,
      secret,
      pending: true,
      sockets,
      delegations: new Map(),
      service: { operationId: input.operationId, port: input.port },
    });
    if (this.closed) {
      await this.stop(sessionId, view.leaseId);
      throw new Error('preview service stopped');
    }
    try {
      await retryStartup(() =>
        responseReady(view.url, secret, AbortSignal.any([startup, AbortSignal.timeout(1000)])),
      );
      await requireLiveOwner();
      const lease = this.leases.get(view.leaseId);
      if (lease?.view.state !== 'ready') throw new Error('preview service stopped');
      lease.pending = false;
    } catch (error) {
      await this.stop(sessionId, view.leaseId);
      throw error;
    }
    return { ...view };
  }

  /** Private sidecar/worker channel only. Never return these headers from the public routes. */
  async desktopTarget(sessionId: string, leaseId: string): Promise<DesktopPreviewTarget | null> {
    const lease = this.leases.get(leaseId);
    if (
      !lease ||
      lease.pending ||
      lease.view.sessionId !== sessionId ||
      lease.view.state !== 'ready'
    )
      return null;
    try {
      if ((await this.resolveRoot(sessionId, lease.view.runId)) !== lease.root) return null;
      if (lease.service) {
        const attestConnection = this.attest;
        if (
          !attestConnection ||
          !this.operationRun ||
          (await this.operationRun(sessionId, lease.service.operationId)) !== lease.view.runId
        )
          return null;
        const socket = await ownedConnection(
          lease.service.operationId,
          lease.service.port,
          (operationId, port, peerPort) => attestConnection(sessionId, operationId, port, peerPort),
        );
        socket.destroy();
      }
      if (
        lease.view.state !== 'ready' ||
        (await this.resolveRoot(sessionId, lease.view.runId)) !== lease.root
      )
        return null;
      return {
        url: lease.view.url,
        origin: lease.view.origin,
        webSocketOrigins: lease.service ? [lease.view.origin.replace('http:', 'ws:')] : [],
        headers: { 'x-corral-preview': lease.secret },
      };
    } catch {
      return null;
    }
  }

  private delegated(leaseId: string, token: string | string[] | undefined): boolean {
    if (typeof token !== 'string') return false;
    const lease = this.leases.get(leaseId);
    return (
      !!lease &&
      lease.view.state === 'ready' &&
      [...lease.delegations.values()].some(
        (entry) => entry.token === token && entry.expiresAt > this.now(),
      )
    );
  }

  /** Authenticated remote Desktop delegation; the ordinary lease view never carries credentials. */
  async delegate(sessionId: string, leaseId: string, delegationId?: string) {
    const target = await this.desktopTarget(sessionId, leaseId);
    const lease = this.leases.get(leaseId);
    if (!target || !lease || lease.view.state !== 'ready')
      throw new Error('preview lease unavailable');
    for (const [id, entry] of lease.delegations)
      if (entry.expiresAt <= this.now()) lease.delegations.delete(id);
    const id = delegationId ?? `delegation_${randomUUID().replaceAll('-', '')}`;
    const existing = lease.delegations.get(id);
    if (delegationId && !existing) throw new Error('preview delegation expired');
    if (!existing && lease.delegations.size >= 32) throw new Error('too many preview delegates');
    const entry = {
      token: existing?.token ?? randomBytes(32).toString('base64url'),
      expiresAt: this.now() + 60_000,
    };
    lease.delegations.set(id, entry);
    return {
      delegationId: id,
      expiresAt: new Date(entry.expiresAt).toISOString(),
      target: { ...target, headers: { 'x-corral-preview': entry.token } },
    };
  }

  async stop(sessionId: string, leaseId: string): Promise<void> {
    const lease = this.leases.get(leaseId);
    if (!lease || lease.view.sessionId !== sessionId) throw new Error('preview lease not found');
    if (lease.view.state === 'stopped') return;
    lease.view.state = 'stopped';
    const cleanup = await Promise.allSettled(
      [...this.stopListeners].map((listener) => listener(leaseId)),
    );
    for (const socket of lease.sockets) socket.destroy();
    lease.server.closeAllConnections();
    await new Promise<void>((done) => lease.server.close(() => done()));
    const failed = cleanup.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }

  async dispose(): Promise<void> {
    this.closed = true;
    await Promise.all(
      [...this.leases.values()].map(({ view }) => this.stop(view.sessionId, view.leaseId)),
    );
    this.leases.clear();
  }
}

class PreviewResponseError extends Error {
  readonly status: number;
  constructor(status: number) {
    super('preview entry did not answer successfully');
    this.status = status;
  }
}

function startupRetryable(error: unknown): boolean {
  if (error instanceof PreviewResponseError) return [502, 503, 504].includes(error.status);
  if (error instanceof DOMException && error.name === 'TimeoutError') return true;
  if (!error || typeof error !== 'object') return false;
  const code = 'code' in error ? error.code : undefined;
  if (typeof code === 'string' && ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes(code))
    return true;
  return 'cause' in error && startupRetryable(error.cause);
}

async function responseReady(url: string, secret: string, startup?: AbortSignal) {
  const response = await fetch(url, {
    headers: { 'x-corral-preview': secret },
    redirect: 'error',
    signal: startup ?? AbortSignal.timeout(5000),
  });
  const body = response.body?.getReader();
  try {
    if (!response.ok) throw new PreviewResponseError(response.status);
    await body?.read();
  } finally {
    await body?.cancel().catch(() => {});
  }
}

/** Static rendering cannot rely on sandbox alone: meta refresh also navigates a frame. */
function staticDocument(html: string, leaseBase: string, documentUrl: string): string {
  const document = parse(html);
  const visit = (node: DefaultTreeAdapterTypes.ParentNode) => {
    node.childNodes = node.childNodes.filter((child) => {
      if (!('tagName' in child)) return true;
      if (
        ['script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'base', 'form'].includes(
          child.tagName,
        )
      )
        return false;
      if (child.tagName === 'meta' && child.attrs.some((attr) => attr.name === 'http-equiv'))
        return false;
      child.attrs = child.attrs.filter((attr) => {
        if (
          /^on/i.test(attr.name) ||
          ['target', 'download', 'srcdoc', 'srcset', 'ping'].includes(attr.name)
        )
          return false;
        if (['src', 'href', 'action', 'formaction'].includes(attr.name)) {
          try {
            const target = new URL(attr.value, documentUrl);
            return target.href.startsWith(leaseBase) && !target.username && !target.password;
          } catch {
            return false;
          }
        }
        return true;
      });
      visit(child);
      return true;
    });
  };
  visit(document);
  return serialize(document);
}

function safeAssetPath(path: string): string {
  const rel = safeRelative(path);
  if (rel.includes(':') || rel.split('/').some((part) => part.startsWith('.')))
    throw new Error('private paths are not preview assets');
  if (!MIME[extname(rel).toLowerCase()]) throw new Error('unsupported preview asset');
  return rel;
}

async function readAsset(root: string, path: string): Promise<Buffer> {
  if ((await realpath(root)) !== root || (await lstat(root)).isSymbolicLink())
    throw new Error('worktree moved');
  let current = root;
  for (const part of path.split('/')) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error('symlink is not a preview asset');
  }
  const handle = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    const named = await lstat(current);
    if (
      !stat.isFile() ||
      stat.size > MAX_BYTES ||
      named.ino !== stat.ino ||
      named.dev !== stat.dev ||
      (await realpath(current)) !== resolve(root, path)
    )
      throw new Error('preview asset unavailable');
    const bytes = Buffer.alloc(Math.min(stat.size + 1, MAX_BYTES + 1));
    let size = 0;
    while (size < bytes.length) {
      const result = await handle.read(bytes, size, bytes.length - size, size);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    const after = await handle.stat();
    if (
      size !== stat.size ||
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs
    )
      throw new Error('preview asset changed while reading');
    return bytes.subarray(0, size);
  } finally {
    await handle.close();
  }
}
