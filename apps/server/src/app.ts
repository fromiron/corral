import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AgentAdapter,
  CanvasLayout,
  type Clock,
  type CommandError,
  CorralDefinitionDraft,
  CreateRunRequest,
  type DecisionProvider,
  type ErrorCode,
  type IdFactory,
  type Receipt,
  type RunEvent,
  SCHEMA_VERSION,
  type Scheduler,
} from '@corral/contracts';
import {
  Coordinator,
  compileDefinition,
  exportRunArchive,
  type InstallationPolicy,
  judgmentSettings,
  LocalHeuristicProvider,
  openRunArchive,
  planRun,
  type SaveResult,
} from '@corral/core';
import { LangGraphRunner } from '@corral/runner-langgraph';
import { openDatabase, SqliteCorralRepository, SqliteRunStore } from '@corral/storage-sqlite';
import type { CredentialStore, Models } from '@earendil-works/pi-ai';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import packageJson from '../package.json' with { type: 'json' };
import { ImportInput, type InputOptions, InputRegistry } from './inputs.ts';
import { assertOutsideWorkspace, DEFAULT_PROFILES, ModelRegistry } from './models/index.ts';
import { RandomIdFactory, systemClock, systemTimers } from './runtime.ts';
import { InputError } from './safe-http.ts';
import {
  assertLoopback,
  boundaryFor,
  newBootstrapToken,
  RequestLimiter,
  SECURITY_HEADERS,
  Sessions,
  sessionCookie,
} from './security.ts';
import { boundedSseWriter, flushSseRecord, MAX_SSE_BUFFER_BYTES } from './sse.ts';
import { prepareWorkspace } from './workspace.ts';
import { acquireWorkspaceOwnership } from './workspace-ownership.ts';

// The local server (C-015, C-055, C-057): REST commands and queries, SSE for committed events,
// and Studio's static files, all on one loopback origin. The Coordinator is the only writer.

export interface ServerOptions {
  workspace: string;
  /** Judgment providers beyond the built-in local-heuristic@1 (CR-003), e.g. the local model. */
  decisionProviders?: DecisionProvider[];
  host?: string;
  /** 0 picks a free port. */
  port?: number;
  agents: AgentAdapter;
  clock?: Clock;
  ids?: IdFactory;
  timers?: Scheduler;
  /** Built Studio to serve; omitted when Studio runs elsewhere (Vite dev with a proxy). */
  staticDir?: string;
  /** Normally random; the E2E harness passes one so tests can open a session. */
  bootstrapToken?: string;
  /** Extra Studio origins, such as the Vite dev server. Opt-in only. */
  extraOrigins?: string[];
  /** Real model calls (C-020, C-058). Without it, every run uses the simulated agents. */
  live?: LiveModels;
  /** Input network injection and explicit bounded search opt-in; credentials stay server-side. */
  inputs?: InputOptions;
}

export interface LiveModels {
  /** pi-ai's model catalog, resolving request auth from `credentials`. */
  models: Models;
  credentials: CredentialStore;
  /** The user's config directory holding `credentials`; must be outside the workspace. */
  configDir: string;
  getDeviceId(): string;
  /** Models a subscription sign-in may call (pi-ai's ChatGPT-account catalog for OpenAI). */
  subscriptionModels?: (providerId: string) => ReadonlySet<string> | null;
  /** The agent adapter for live runs; it asks the registry for each request's token. */
  agents(registry: ModelRegistry): AgentAdapter;
}

/** Simulated agents for mock runs, real ones for live runs (fixed per run in its snapshot). */
function routeByMode(mock: AgentAdapter, live: AgentAdapter | null): AgentAdapter {
  return {
    start: (input, host) => {
      if (input.mode === 'mock') return mock.start(input, host);
      if (!live) return Promise.reject(new Error('this server has no live model connection'));
      return live.start(input, host);
    },
  };
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
  POLICY_ERROR: 500,
};

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
  const resources = new AsyncDisposableStack();
  try {
    return await createCorralServer(options, resources);
  } catch (error) {
    await resources.disposeAsync();
    throw error;
  }
}

async function createCorralServer(
  options: ServerOptions,
  resources: AsyncDisposableStack,
): Promise<CorralServer> {
  const host = options.host ?? '127.0.0.1';
  assertLoopback(host);
  resources.defer(acquireWorkspaceOwnership(options.workspace));
  const workspace = prepareWorkspace(options.workspace);
  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? new RandomIdFactory();
  const db = openDatabase(workspace.dbPath);
  resources.defer(() => {
    db.close();
  });
  const corrals = new SqliteCorralRepository(db, {
    clock,
    newCorralId: () => ids.next('artifact').replace(/^art_/, 'corral_'),
  });
  const backendSessionId = ids.next('run').replace(/^run_/, 'backend_');
  let registry: ModelRegistry | null = null;
  if (options.live) {
    assertOutsideWorkspace(options.live.configDir, workspace.root);
    registry = new ModelRegistry(
      options.live.models,
      workspace.config.modelProfiles ?? DEFAULT_PROFILES,
      {
        credentials: options.live.credentials,
        getDeviceId: options.live.getDeviceId,
        ...(options.live.subscriptionModels
          ? { subscriptionModels: options.live.subscriptionModels }
          : {}),
      },
    );
    await registry.refreshStatus();
  }
  const store = new SqliteRunStore(db);
  const inputs = new InputRegistry(db, options.inputs);
  const coordinator = new Coordinator({
    clock,
    ids,
    timers: options.timers ?? systemTimers,
    agents: routeByMode(
      options.agents,
      registry && options.live ? options.live.agents(registry) : null,
    ),
    ...(registry ? { models: registry } : {}),
    store,
    tools: inputs,
    runner: new LangGraphRunner(),
    corrals,
    policy: workspace.policy,
    sessionId: backendSessionId,
    judgments: {
      providers: [new LocalHeuristicProvider(), ...(options.decisionProviders ?? [])],
      settings: judgmentSettings(workspace.config),
    },
  });

  const token = options.bootstrapToken ?? newBootstrapToken();
  const sessions = new Sessions(token);
  let port = options.port ?? 0;
  const boundary = boundaryFor(() => port, options.extraOrigins);
  const streams = new Set<() => void>();
  const limiter = new RequestLimiter(() => clock.monotonicMs());

  const app = Fastify({
    logger: false,
    bodyLimit: 2 * 1024 * 1024,
    requestTimeout: 30_000,
    forceCloseConnections: true,
    return503OnClosing: true,
  });
  resources.defer(() => app.close());

  app.addHook('onRequest', async (request, reply) => {
    if (!boundary.hostAllowed(request.headers.host)) {
      return fail(reply, 'ORIGIN_REJECTED', 'this host name is not served here');
    }
    const origin = request.headers.origin;
    const safe = request.method === 'GET' || request.method === 'HEAD';
    if ((origin !== undefined || !safe) && !boundary.originAllowed(origin)) {
      return fail(reply, 'ORIGIN_REJECTED', 'requests must come from Studio');
    }
    const path = request.routeOptions.url ?? request.url.split('?')[0] ?? '';
    if (path.startsWith('/api/')) {
      const queryKeys = Object.keys(request.query ?? {});
      if (queryKeys.some((key) => /token|key|secret|authorization|password/i.test(key))) {
        return fail(reply, 'SCHEMA_INVALID', 'credentials are not accepted in query strings');
      }
      if (!limiter.allow(!safe)) {
        return reply
          .header('retry-after', '60')
          .code(429)
          .send({
            error: { code: 'LIMIT_REACHED', message: 'local request rate exceeded' },
          });
      }
    }
    const open = path === '/api/v1/health' || (path === '/api/v1/session' && !safe);
    if (path.startsWith('/api/') && !open && !sessions.valid(request.headers.cookie)) {
      return fail(reply, 'SESSION_INVALID', 'open the link printed by the Corral server');
    }
    if (
      path.startsWith('/api/') &&
      !open &&
      !safe &&
      !sessions.validCsrf(request.headers.cookie, request.headers['x-corral-csrf'])
    ) {
      return fail(reply, 'ORIGIN_REJECTED', 'a session CSRF token is required');
    }
  });
  app.addHook('onSend', async (_request, reply, payload) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) reply.header(name, value);
    return payload;
  });
  app.setErrorHandler((error: { statusCode?: number; message?: string }, _request, reply) => {
    if (error.statusCode === 413)
      return reply
        .code(413)
        .send({ error: { code: 'SCHEMA_INVALID', message: 'request body exceeds 2 MiB' } });
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
    live: registry !== null,
  }));
  app.post('/api/v1/session', async (request, reply) => {
    const session = sessions.redeem((request.body as { token?: unknown } | null)?.token);
    if (!session) return fail(reply, 'SESSION_INVALID', 'this link was already used or is wrong');
    return reply
      .header('set-cookie', sessionCookie(session))
      .header('x-corral-csrf', sessions.csrfToken(sessionCookie(session)))
      .code(204)
      .send();
  });
  app.get('/api/v1/session', async (request) => ({
    ok: true,
    csrfToken: sessions.csrfToken(request.headers.cookie),
  }));

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
    void fail(reply, 'SCHEMA_INVALID', 'request does not match the schema');
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

  // Registered document IDs are stable across server restarts; raw paths never enter tools.
  app.get('/api/v1/documents', async () => inputs.list());
  app.post('/api/v1/documents/import', async (request, reply) => {
    const body = parse(ImportInput, request, reply);
    if (!body) return reply;
    try {
      if ('url' in body) return reply.code(201).send(await inputs.importSource(body));
      const document = inputs.importDocument(body);
      return reply.code(201).send({
        documentId: document.documentId,
        title: document.title,
        mimeType: document.mimeType,
        bytes: Buffer.byteLength(document.text),
      });
    } catch (error) {
      return fail(
        reply,
        'SCHEMA_INVALID',
        error instanceof InputError ? error.message : 'input registration failed',
      );
    }
  });
  app.post('/api/v1/history/import', async (request, reply) => {
    try {
      return openRunArchive(request.body);
    } catch {
      return fail(reply, 'SCHEMA_INVALID', 'invalid history archive');
    }
  });

  // ── models (C-058) ─────────────────────────────────────────────────────────
  // Status and expiry only; tokens never appear in these answers (ADR-019).
  app.get('/api/v1/model-profiles', async () => registry?.profilesView() ?? []);
  app.get('/api/v1/model-auth', async () => registry?.authView() ?? []);
  type ProviderParams = { Params: { providerId: string } };
  const noLive = (reply: FastifyReply) =>
    fail(reply, 'COMMAND_NOT_SUPPORTED', 'this server has no live model connection');
  app.post<ProviderParams>('/api/v1/model-auth/:providerId/login', async (request, reply) => {
    if (!registry) return noLive(reply);
    try {
      return reply.code(202).send(await registry.startLogin(request.params.providerId));
    } catch {
      return fail(reply, 'TARGET_NOT_FOUND', 'no model profile uses this provider');
    }
  });
  app.post<ProviderParams>(
    '/api/v1/model-auth/:providerId/login/callback',
    async (request, reply) => {
      if (!registry) return noLive(reply);
      const body = parse(z.strictObject({ url: z.string().url().max(4096) }), request, reply);
      if (!body) return reply;
      return registry.submitRedirect(request.params.providerId, body.url)
        ? { accepted: true }
        : fail(reply, 'TARGET_NOT_FOUND', 'no sign-in is waiting for this provider');
    },
  );
  app.delete<ProviderParams>('/api/v1/model-auth/:providerId/login', async (request, reply) => {
    if (!registry) return noLive(reply);
    registry.cancelLogin(request.params.providerId);
    return registry.authView();
  });
  app.delete<ProviderParams>('/api/v1/model-auth/:providerId', async (request, reply) => {
    if (!registry) return noLive(reply);
    await registry.logout(request.params.providerId);
    return registry.authView();
  });

  // ── runs ───────────────────────────────────────────────────────────────────
  app.get('/api/v1/runs', async () => coordinator.listRuns());
  app.post('/api/v1/runs', async (request, reply) => {
    const parsed = CreateRunRequest.safeParse(request.body);
    if (!parsed.success) {
      const message = 'request does not match the schema';
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
  app.post<RunParams>('/api/v1/runs/:runId/export', async (request, reply) => {
    const body = parse(
      z.strictObject({ privateTranscript: z.boolean().optional() }),
      request,
      reply,
    );
    if (!body) return reply;
    if (!coordinator.getRunSnapshot(request.params.runId))
      return fail(reply, 'TARGET_NOT_FOUND', 'no such run');
    return exportRunArchive(store, request.params.runId, body);
  });
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
      const projection = coordinator.findSnapshot(runId)?.projection;
      const known =
        projection &&
        (projection.artifacts[versionId] ||
          Object.values(projection.modelCalls).some((call) => call.responseRef === versionId) ||
          Object.values(projection.toolCalls).some((call) => call.resultRef === versionId) ||
          projection.currentCriteriaVersionId === versionId ||
          Object.values(projection.patches).some(
            (patch) =>
              patch.kind === 'criteria' &&
              (patch.before.criteriaVersionId === versionId ||
                patch.after.criteriaVersionId === versionId),
          ) ||
          coordinator.getRunSnapshot(runId)?.criteriaVersionId === versionId);
      const text = known ? coordinator.getArtifactText(runId, versionId) : null;
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

      if (streams.size >= 16)
        return reply.code(429).send({
          error: { code: 'LIMIT_REACHED', message: 'at most 16 event streams may be open' },
        });
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
        ...SECURITY_HEADERS,
      });
      let closed = false;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let flushDeadline: ReturnType<typeof setTimeout> | undefined;
      let unsubscribe = () => {};
      const release = () => {
        clearInterval(heartbeat);
        clearTimeout(flushDeadline);
        unsubscribe();
        streams.delete(close);
      };
      const close = () => {
        closed = true;
        release();
        res.destroy();
      };
      const send = boundedSseWriter(res, () => {
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        // Flush the bounded prefix so a replay larger than the cap advances its cursor.
        res.end();
        flushDeadline = setTimeout(close, 10_000);
        flushDeadline.unref();
      });
      streams.add(close);
      res.on('close', release);
      request.raw.on('close', close);
      send(': stream open\n\n');
      // Replay may synchronously overflow before subscribe returns its disposer.
      unsubscribe = coordinator.subscribe(
        request.params.runId,
        cursor,
        (event: RunEvent) => {
          if (closed) return;
          const frame = `id: ${event.runSeq}\nevent: domain\ndata: ${JSON.stringify(event)}\n\n`;
          if (Buffer.byteLength(frame) <= MAX_SSE_BUFFER_BYTES) {
            send(frame);
            return;
          }
          closed = true;
          clearInterval(heartbeat);
          unsubscribe();
          flushDeadline = setTimeout(close, 10_000);
          flushDeadline.unref();
          void flushSseRecord(res, frame).then(() => res.end(), close);
        },
        close,
        (frame) => {
          if (!closed) send(`event: stream\ndata: ${JSON.stringify(frame)}\n\n`);
        },
      );
      if (closed) unsubscribe();
      else heartbeat = setInterval(() => send(': ping\n\n'), HEARTBEAT_MS);
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
      await resources.disposeAsync();
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
