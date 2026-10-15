import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AgentAdapter,
  CanvasLayout,
  type Clock,
  type CommandError,
  CorralDefinitionDraft,
  CreateRunRequest,
  type ErrorCode,
  type IdFactory,
  type Receipt,
  type RunEvent,
  SCHEMA_VERSION,
} from '@corral/contracts';
import {
  Coordinator,
  compileDefinition,
  type InstallationPolicy,
  planRun,
  type SaveResult,
} from '@corral/core';
import { LangGraphRunner } from '@corral/runner-langgraph';
import { openDatabase, SqliteCorralRepository, SqliteRunStore } from '@corral/storage-sqlite';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import packageJson from '../package.json' with { type: 'json' };
import { RandomIdFactory, systemClock } from './runtime.ts';
import {
  assertLoopback,
  boundaryFor,
  newBootstrapToken,
  SECURITY_HEADERS,
  Sessions,
  sessionCookie,
} from './security.ts';
import { prepareWorkspace } from './workspace.ts';

// The local server (C-015, C-055, C-057): REST commands and queries, SSE for committed events,
// and Studio's static files, all on one loopback origin. The Coordinator is the only writer.

export interface ServerOptions {
  workspace: string;
  host?: string;
  /** 0 picks a free port. */
  port?: number;
  agents: AgentAdapter;
  clock?: Clock;
  ids?: IdFactory;
  /** Built Studio to serve; omitted when Studio runs elsewhere (Vite dev with a proxy). */
  staticDir?: string;
  /** Normally random; the E2E harness passes one so tests can open a session. */
  bootstrapToken?: string;
  /** Extra Studio origins, such as the Vite dev server. Opt-in only. */
  extraOrigins?: string[];
}

export interface CorralServer {
  url: string;
  bootstrapUrl: string;
  policy: InstallationPolicy;
  coordinator: Coordinator;
  close(): Promise<void>;
}

const STATUS: Record<ErrorCode, number> = {
  SCHEMA_INVALID: 400,
  GRAPH_INVALID: 422,
  CAPABILITY_DENIED: 403,
  STALE_CONTROL_REVISION: 409,
  IDEMPOTENCY_CONFLICT: 409,
  COMMAND_NOT_SUPPORTED: 501,
  TARGET_NOT_FOUND: 404,
  TARGET_TERMINAL: 409,
  RUN_ALREADY_ACTIVE: 409,
  REVISION_CONFLICT: 409,
  RESOURCE_CAPACITY: 409,
  CRITERIA_CHANGE_REQUIRES_NEW_RUN: 409,
  RESTART_NOT_ALLOWED: 409,
  APPROVAL_STALE: 409,
  LIMIT_REACHED: 409,
  STORAGE_UNAVAILABLE: 503,
  SESSION_INVALID: 401,
  ORIGIN_REJECTED: 403,
};

/** A slow SSE reader is cut off past this much unsent data; it resumes from its cursor. */
const MAX_SSE_BUFFER_BYTES = 1024 * 1024;
const HEARTBEAT_MS = 15_000;

const LayoutInput = z.strictObject({
  nodes: CanvasLayout.shape.nodes,
  viewport: CanvasLayout.shape.viewport,
});
const CreateCorral = z.strictObject({ definition: CorralDefinitionDraft, layout: LayoutInput });
const UpdateCorral = z.strictObject({ definition: CorralDefinitionDraft, layout: LayoutInput });

/** `If-Match: 3` or `If-Match: "3"`: the definition revision the edit started from. */
function ifMatchRevision(header: string | undefined): number | null {
  const value = header
    ?.trim()
    .replace(/^W\//, '')
    .replace(/^"(.*)"$/, '$1');
  return value && /^[1-9]\d*$/.test(value) ? Number(value) : null;
}

const fail = (reply: FastifyReply, code: ErrorCode, message: string) =>
  reply.code(STATUS[code]).send({ error: { code, message } satisfies CommandError });

const receiptStatus = (receipt: Receipt) => {
  if (receipt.error) return STATUS[receipt.error.code];
  return receipt.status === 'queued' || receipt.status === 'accepted' ? 202 : 200;
};

export async function startCorralServer(options: ServerOptions): Promise<CorralServer> {
  const host = options.host ?? '127.0.0.1';
  assertLoopback(host);
  const workspace = prepareWorkspace(options.workspace);
  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? new RandomIdFactory();
  const db = openDatabase(workspace.dbPath);
  const corrals = new SqliteCorralRepository(db, {
    clock,
    newCorralId: () => ids.next('artifact').replace(/^art_/, 'corral_'),
  });
  const backendSessionId = ids.next('run').replace(/^run_/, 'backend_');
  const coordinator = new Coordinator({
    clock,
    ids,
    agents: options.agents,
    store: new SqliteRunStore(db),
    runner: new LangGraphRunner(),
    corrals,
    policy: workspace.policy,
    sessionId: backendSessionId,
  });

  const token = options.bootstrapToken ?? newBootstrapToken();
  const sessions = new Sessions(token);
  let port = options.port ?? 0;
  const boundary = boundaryFor(() => port, options.extraOrigins);
  const streams = new Set<() => void>();

  const app = Fastify({
    logger: false,
    bodyLimit: 2 * 1024 * 1024,
    forceCloseConnections: true,
    return503OnClosing: true,
  });

  app.addHook('onRequest', async (request, reply) => {
    if (!boundary.hostAllowed(request.headers.host)) {
      return fail(reply, 'ORIGIN_REJECTED', 'this host name is not served here');
    }
    const origin = request.headers.origin;
    const safe = request.method === 'GET' || request.method === 'HEAD';
    if ((origin !== undefined || !safe) && !boundary.originAllowed(origin)) {
      return fail(reply, 'ORIGIN_REJECTED', 'requests must come from Studio');
    }
    const path = request.url.split('?')[0] ?? '';
    const open = path === '/api/v1/health' || (path === '/api/v1/session' && !safe);
    if (path.startsWith('/api/') && !open && !sessions.valid(request.headers.cookie)) {
      return fail(reply, 'SESSION_INVALID', 'open the link printed by the Corral server');
    }
  });
  app.addHook('onSend', async (_request, reply, payload) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) reply.header(name, value);
    return payload;
  });
  app.setErrorHandler((error: { statusCode?: number; message?: string }, _request, reply) => {
    if (error.statusCode && error.statusCode < 500) {
      return fail(reply, 'SCHEMA_INVALID', 'the request body could not be read');
    }
    return reply.code(500).send({ error: { code: 'INTERNAL', message: 'internal error' } });
  });

  // ── session ────────────────────────────────────────────────────────────────
  app.get('/api/v1/health', async () => ({
    ok: true,
    schemaVersion: SCHEMA_VERSION,
    version: packageJson.version,
    backendSessionId,
    agents: 'mock',
  }));
  app.post('/api/v1/session', async (request, reply) => {
    const session = sessions.redeem((request.body as { token?: unknown } | null)?.token);
    if (!session) return fail(reply, 'SESSION_INVALID', 'this link was already used or is wrong');
    return reply.header('set-cookie', sessionCookie(session)).code(204).send();
  });
  app.get('/api/v1/session', async () => ({ ok: true }));

  // ── Corrals ────────────────────────────────────────────────────────────────
  const saveReply = (reply: FastifyReply, result: SaveResult, created: boolean) => {
    if (result.ok) return reply.code(created ? 201 : 200).send(result);
    const code: ErrorCode =
      result.error === 'not_found'
        ? 'TARGET_NOT_FOUND'
        : result.error === 'revision_conflict'
          ? 'REVISION_CONFLICT'
          : 'STORAGE_UNAVAILABLE';
    return fail(reply, code, result.message);
  };
  const parse = <T>(schema: z.ZodType<T>, request: FastifyRequest, reply: FastifyReply) => {
    const parsed = schema.safeParse(request.body);
    if (parsed.success) return parsed.data;
    const issue = parsed.error.issues[0];
    void fail(
      reply,
      'SCHEMA_INVALID',
      issue ? `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}` : 'invalid',
    );
    return null;
  };

  app.get('/api/v1/corrals', async () => corrals.list());
  app.post('/api/v1/corrals', async (request, reply) => {
    const body = parse(CreateCorral, request, reply);
    if (!body) return reply;
    const result = await corrals.save({ ...body, expectedDefinitionRevision: null } as never);
    return saveReply(reply, result, true);
  });
  app.get<{ Params: { corralId: string } }>('/api/v1/corrals/:corralId', async (request, reply) => {
    const record = await corrals.get(request.params.corralId);
    return record ?? fail(reply, 'TARGET_NOT_FOUND', 'no such Corral');
  });
  app.put<{ Params: { corralId: string } }>('/api/v1/corrals/:corralId', async (request, reply) => {
    const expectedDefinitionRevision = ifMatchRevision(request.headers['if-match']);
    if (expectedDefinitionRevision === null) {
      return fail(reply, 'SCHEMA_INVALID', 'If-Match must name the definition revision');
    }
    const body = parse(UpdateCorral, request, reply);
    if (!body) return reply;
    if (body.definition.id !== request.params.corralId) {
      return fail(reply, 'SCHEMA_INVALID', 'definition.id does not match the address');
    }
    const result = await corrals.save({ ...body, expectedDefinitionRevision } as never);
    return saveReply(reply, result, false);
  });
  app.post<{ Params: { corralId: string } }>(
    '/api/v1/corrals/:corralId/duplicate',
    async (request, reply) => {
      const body = parse(z.strictObject({ name: z.string().min(1).max(200) }), request, reply);
      if (!body) return reply;
      return saveReply(reply, await corrals.duplicate(request.params.corralId, body.name), true);
    },
  );
  app.delete<{ Params: { corralId: string } }>(
    '/api/v1/corrals/:corralId',
    async (request, reply) => {
      await corrals.remove(request.params.corralId);
      return reply.code(204).send();
    },
  );
  app.post('/api/v1/corrals/validate', async (request, reply) => {
    const body = parse(z.strictObject({ definition: z.unknown() }), request, reply);
    if (!body) return reply;
    const compiled = compileDefinition(body.definition, {});
    const runnable = compiled.ok ? planRun(compiled.definition) : null;
    return {
      diagnostics: compiled.diagnostics,
      runnable: runnable?.ok ?? false,
      runtimeLimits: runnable && !runnable.ok ? runnable.issues : [],
      summary: compiled.ok ? compiled.plan.summary : null,
    };
  });

  // ── runs ───────────────────────────────────────────────────────────────────
  app.get('/api/v1/runs', async () => coordinator.listRuns());
  app.post('/api/v1/runs', async (request, reply) => {
    const parsed = CreateRunRequest.safeParse(request.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const message = issue
        ? `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`
        : 'invalid';
      return reply.code(400).send({
        runId: null,
        receipt: refusedStart(request.body, { code: 'SCHEMA_INVALID', message }),
      });
    }
    const resend = coordinator.hasStartCommand(parsed.data.commandId);
    const result = coordinator.startRun(parsed.data);
    const status = result.receipt.error ? STATUS[result.receipt.error.code] : resend ? 200 : 201;
    return reply.code(status).send(result);
  });

  type RunParams = { Params: { runId: string } };
  app.get<RunParams>('/api/v1/runs/:runId', async (request, reply) => {
    const snapshot = coordinator.getRunSnapshot(request.params.runId);
    if (!snapshot) return fail(reply, 'TARGET_NOT_FOUND', 'no such run');
    return { runId: request.params.runId, ...snapshot };
  });
  app.get<RunParams>('/api/v1/runs/:runId/snapshot', async (request, reply) => {
    return (
      coordinator.findSnapshot(request.params.runId) ??
      fail(reply, 'TARGET_NOT_FOUND', 'no such run')
    );
  });
  app.post<RunParams>('/api/v1/runs/:runId/commands', async (request, reply) => {
    const body = request.body as { runId?: unknown; commandId?: unknown } | null;
    if (body?.runId !== request.params.runId) {
      return fail(reply, 'SCHEMA_INVALID', 'runId does not match the address');
    }
    const receipt = coordinator.submit(request.body as never);
    return reply.code(receiptStatus(receipt)).send(receipt);
  });
  app.get<{ Params: { runId: string; commandId: string } }>(
    '/api/v1/runs/:runId/commands/:commandId',
    async (request, reply) =>
      coordinator.getReceipt(request.params.runId, request.params.commandId) ??
      fail(reply, 'TARGET_NOT_FOUND', 'no such command'),
  );
  app.get<{ Params: { runId: string; versionId: string } }>(
    '/api/v1/runs/:runId/artifact-versions/:versionId',
    async (request, reply) => {
      const { runId, versionId } = request.params;
      const known = coordinator.findSnapshot(runId)?.projection.artifacts[versionId];
      const isCriteria = coordinator.getRunSnapshot(runId)?.criteriaVersionId === versionId;
      const text = known || isCriteria ? coordinator.getArtifactText(runId, versionId) : null;
      return text === null ? fail(reply, 'TARGET_NOT_FOUND', 'no such version') : { text };
    },
  );
  app.get<{ Params: { runId: string; artifactId: string; version: string } }>(
    '/api/v1/runs/:runId/artifacts/:artifactId/versions/:version',
    async (request, reply) => {
      const { runId, artifactId, version } = request.params;
      const artifacts = coordinator.findSnapshot(runId)?.projection.artifacts ?? {};
      const found = Object.values(artifacts).find(
        (a) => a.artifactId === artifactId && String(a.version) === version,
      );
      const text = found ? coordinator.getArtifactText(runId, found.artifactVersionId) : null;
      return text === null
        ? fail(reply, 'TARGET_NOT_FOUND', 'no such version')
        : { ...found, text };
    },
  );

  app.get<RunParams & { Querystring: { after?: string } }>(
    '/api/v1/runs/:runId/events',
    (request, reply) => {
      const snapshot = coordinator.findSnapshot(request.params.runId);
      if (!snapshot) return fail(reply, 'TARGET_NOT_FOUND', 'no such run');
      // A valid Last-Event-ID wins over ?after (API-Contract §1); either must be in range.
      const header = request.headers['last-event-id'];
      const raw =
        typeof header === 'string' && header !== '' ? header : (request.query.after ?? '0');
      const cursor = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
      if (!Number.isSafeInteger(cursor) || cursor > snapshot.seq) {
        return fail(reply, 'SCHEMA_INVALID', `cursor must be 0..${snapshot.seq}`);
      }

      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
        ...SECURITY_HEADERS,
      });
      res.write(': stream open\n\n');
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        streams.delete(close);
        res.end();
      };
      const unsubscribe = coordinator.subscribe(
        request.params.runId,
        cursor,
        (event: RunEvent) => {
          if (closed) return;
          if (res.writableLength > MAX_SSE_BUFFER_BYTES) {
            // Too far behind: drop the connection; the client resumes from its cursor.
            close();
            return;
          }
          res.write(`id: ${event.runSeq}\nevent: domain\ndata: ${JSON.stringify(event)}\n\n`);
        },
        close,
      );
      const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
      streams.add(close);
      request.raw.on('close', close);
    },
  );

  // ── Studio ─────────────────────────────────────────────────────────────────
  // The page is marked as served by this server, so Studio talks to it instead of running
  // the in-browser demo runtime.
  let studioPage: string | null = null;
  if (options.staticDir && existsSync(join(options.staticDir, 'index.html'))) {
    studioPage = readFileSync(join(options.staticDir, 'index.html'), 'utf-8').replace(
      '<head>',
      '<head><meta name="corral-runtime" content="server">',
    );
    await app.register(fastifyStatic, { root: options.staticDir, wildcard: false, index: false });
  }
  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?')[0] ?? '';
    if (path.startsWith('/api/') || !studioPage || request.method !== 'GET') {
      return fail(reply, 'TARGET_NOT_FOUND', 'not found');
    }
    // Client-side routes all load the same page (C-056).
    return reply.header('cache-control', 'no-cache').type('text/html').send(studioPage);
  });

  await app.listen({ host, port });
  const address = app.server.address();
  port = typeof address === 'object' && address ? address.port : port;
  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    bootstrapUrl: `${url}/#bootstrap=${token}`,
    policy: workspace.policy,
    coordinator,
    async close() {
      for (const close of [...streams]) close();
      await app.close();
      db.close();
    },
  };
}

function refusedStart(body: unknown, error: CommandError): Receipt {
  const commandId = (body as { commandId?: unknown } | null)?.commandId;
  return {
    commandId: typeof commandId === 'string' && commandId ? commandId : 'unknown',
    runId: 'none',
    status: 'rejected',
    acceptedSeq: null,
    target: 'run:none',
    requestedBoundary: 'immediate',
    relatedEventIds: [],
    error,
  };
}
