import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { recoverSdkWorkers } from '@corral/adapter-pi';
import { hasOwnedProcessReservations } from '@corral/adapter-pi/processes';
import {
  type AgentAdapter,
  AutoModelChoice,
  CanvasLayout,
  CaptureCheckpoint,
  type Clock,
  type CommandError,
  ContentHash,
  CorralDefinitionDraft,
  CreateRunRequest,
  canonicalJson,
  type DecisionProvider,
  DocumentCommand,
  type ErrorCode,
  GitDiffRequest,
  GitWriteCommand,
  HarnessBindingRef,
  HunkPlanRequest,
  HunkRequest,
  Identifier,
  type IdFactory,
  IMAGE_MAX_BYTES,
  ImageAttachment,
  ImageAttachments,
  ImageInput,
  MessageBranchPoint,
  MessageBranchRequest,
  PermissionMode,
  QualityPreset,
  type Receipt,
  RestoreCheckpoint,
  ResumeRuntimeRequest,
  type RunEvent,
  RunInput,
  RunReferences,
  SCHEMA_VERSION,
  type Scheduler,
  SchemaVersion,
  SessionSearchRequest,
  StartFrom,
  TaskStart,
  TERMINAL_RUN_STATUSES,
  TextAttachments,
  UltraSelection,
} from '@corral/contracts';
import {
  autoDefinition,
  Coordinator,
  compileDefinition,
  createAutoStarter,
  explainDefinition,
  exportRunArchive,
  type InstallationPolicy,
  judgmentSettings,
  LocalHeuristicProvider,
  openRunArchive,
  type ProjectResult,
  parseWorkspaceConfig,
  planRun,
  type SaveResult,
  SessionEntryAuto,
  type SessionResult,
  ToolRefusal,
} from '@corral/core';
import { LangGraphRunner } from '@corral/runner-langgraph';
import {
  openDatabase,
  SqliteCorralRepository,
  SqliteHarnessStore,
  SqliteRunStore,
} from '@corral/storage-sqlite';
import type { CredentialStore, MutableModels } from '@earendil-works/pi-ai';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import packageJson from '../package.json' with { type: 'json' };
import { ReviewService } from './files/review.ts';
import { type ChangeScope, WorkspaceError, WorkspaceService } from './files/service.ts';
import { McpCredentials } from './harness/mcp-credentials.ts';
import { McpService } from './harness/mcp-service.ts';
import { registerHarnessRoutes } from './harness/routes.ts';
import { HarnessService } from './harness/service.ts';
import { SkillQualityService } from './harness/skill-quality.ts';
import { registerSkillQualityRoutes } from './harness/skill-quality-routes.ts';
import { createHarnessVaultAdapters } from './harness/vault.ts';
import { ImageStore } from './images.ts';
import { ImageProfileStore } from './images-generation/profiles.ts';
import { ImageGenerationService } from './images-generation/service.ts';
import { ImportInput, type InputOptions, InputRegistry } from './inputs.ts';
import { registerModelImportRoutes } from './models/import-routes.ts';
import {
  assertOutsideWorkspace,
  DEFAULT_PROFILES,
  endpointClashes,
  endpointsFrom,
  ModelRegistry,
  type ProfileConfig,
  RegistryError,
  registerEndpoints,
  userConfigDir,
} from './models/index.ts';
import { registerPreviewRoutes } from './preview/routes.ts';
import { PreviewService } from './preview/service.ts';
import { PreviewToolsBroker } from './preview/tools.ts';
import { PTY_INTERACTIVE_ROUTES, registerTerminalRoutes } from './processes/pty-routes.ts';
import { registerProjectRoutes } from './projects/routes.ts';
import { materialsVaultAdapters } from './projects/vault.ts';
import { drainRejectedBody } from './rejected-body.ts';
import { onceResourceCleanup } from './resource-cleanup.ts';
import { RandomIdFactory, systemClock, systemTimers } from './runtime.ts';
import { InputError } from './safe-http.ts';
import { registerScheduleRoutes } from './schedules/routes.ts';
import { ScheduleService } from './schedules/service.ts';
import { ScheduleStore } from './schedules/store.ts';
import { scheduleVaultAdapter } from './schedules/vault.ts';
import {
  assertLoopback,
  boundaryFor,
  InteractiveRequestLimiter,
  newBootstrapToken,
  PREVIEW_HEADERS,
  RequestLimiter,
  SECURITY_HEADERS,
  Sessions,
  sessionCookie,
} from './security.ts';
import { prepareBranchSession } from './session-branches.ts';
import { SessionSearch } from './session-search.ts';
import { boundedSseWriter, flushSseRecord, MAX_SSE_BUFFER_BYTES } from './sse.ts';
import { providersVaultAdapter } from './vault/providers.ts';
import { registerVaultRoutes } from './vault/routes.ts';
import { VaultService } from './vault/service.ts';
import { createSubagentsVaultAdapter } from './vault/subagents.ts';
import { registerVoiceRoutes } from './voice/routes.ts';
import {
  configRevision,
  prepareWorkspace,
  readWorkspaceConfig,
  writeModelConfig,
  writeReasoningApply,
} from './workspace.ts';
import { acquireWorkspaceOwnership } from './workspace-ownership.ts';

// The local server (C-015, C-055, C-057): REST commands and queries, SSE for committed events,
// and Studio's static files, all on one loopback origin. The Coordinator is the only writer.

const PREVIEW_ROUTE = '/api/v1/runs/:runId/artifact-versions/:versionId/preview';

/** Sessions' worktrees: `$CORRAL_DATA_DIR/worktrees`, else the user's data directory. */
function defaultWorktreeRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CORRAL_DATA_DIR) return join(env.CORRAL_DATA_DIR, 'worktrees');
  return join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'corral', 'worktrees');
}
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
  /** Where sessions' git worktrees live (CR-012); outside every linked folder. */
  worktreeRoot?: string;
}

export interface LiveModels {
  /** pi-ai's model catalog, resolving request auth from `credentials`. */
  models: MutableModels;
  credentials: CredentialStore;
  /** The user's config directory holding `credentials`; must be outside the workspace. */
  configDir: string;
  getDeviceId(): string;
  /** Models a subscription sign-in may call (pi-ai's ChatGPT-account catalog for OpenAI). */
  subscriptionModels?: (providerId: string) => ReadonlySet<string> | null;
  /** The agent adapter for live runs; it asks the registry for each request's token. */
  agents(
    registry: ModelRegistry,
    harnesses: HarnessService,
    workerLeaseDirectory: string,
  ): AgentAdapter;
  /** Profiles when the workspace names none; they follow the available sign-in (CR-004). */
  defaultProfiles?: () => Promise<ProfileConfig[]>;
}

/** Simulated agents for mock runs, real ones for live runs (fixed per run in its snapshot). */
function routeByMode(mock: AgentAdapter, live: AgentAdapter | null): AgentAdapter {
  return {
    start: async (input, host) => {
      if (input.mode === 'mock') {
        if (input.harness) {
          if (!host.simulateHarness) throw new Error('harness simulation is unavailable');
          await host.simulateHarness();
        }
        return mock.start(input, host);
      }
      if (!live) return Promise.reject(new Error('this server has no live model connection'));
      return live.start(input, host);
    },
  };
}

export interface CorralServer {
  closeIfIdle(backupForUpdate?: boolean): Promise<boolean>;
  desktopStorageVersion(): number;
  url: string;
  bootstrapUrl: string;
  policy: InstallationPolicy;
  coordinator: Coordinator;
  desktopPreviewTarget(
    sessionId: string,
    leaseId: string,
  ): ReturnType<PreviewService['desktopTarget']>;
  prepareEvaluation(target: {
    projectId: string;
    baseCommit: string;
  }): Promise<{ sessionId: string; baseCommit: string }>;
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
  MODEL_UNAVAILABLE: 502,
};

const HEARTBEAT_MS = 15_000;

const LayoutInput = z.strictObject({
  nodes: CanvasLayout.shape.nodes,
  viewport: CanvasLayout.shape.viewport,
});
const CreateCorral = z.strictObject({
  definition: CorralDefinitionDraft,
  layout: LayoutInput,
  projectId: Identifier.optional(),
});
const EntryState = z.enum(['started', 'queued', 'sent', 'refused', 'undelivered', 'dismissed']);
const CreateSession = z.strictObject({
  projectId: Identifier,
  title: z.string().max(200),
  autoTitle: z.boolean().optional(),
  objective: z.string().max(20_000).optional(),
  corralId: Identifier.nullable().optional(),
});
const UpdateSession = z.strictObject({
  title: z.string().max(200).optional(),
  objective: z.string().max(20_000).optional(),
  corralId: Identifier.nullable().optional(),
  auto: AutoModelChoice.nullable().optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
  expectedRevision: z.int().min(1),
});
const NewEntry = z.strictObject({
  harness: HarnessBindingRef.optional(),
  permissionMode: PermissionMode.optional(),
  ultra: UltraSelection.optional(),
  qualityPreset: QualityPreset.optional(),
  images: ImageAttachments.optional(),
  taskScope: RunInput.shape.taskScope,
  verificationScope: RunInput.shape.verificationScope,
  attachments: TextAttachments.optional(),
  intent: z.enum(['next', 'queue', 'steer', 'explain']),
  text: z.string().max(20_000),
  state: EntryState,
  runId: Identifier.nullable().optional(),
  executionId: Identifier.nullable().optional(),
  detail: z.string().max(2000).nullable().optional(),
  commandId: Identifier.nullable().optional(),
  // The template an auto request ran with (CR-024).
  auto: SessionEntryAuto.nullable().optional(),
});
const EntryChange = z.strictObject({
  state: EntryState,
  runId: Identifier.nullable().optional(),
  detail: z.string().max(2000).nullable().optional(),
  auto: SessionEntryAuto.nullable().optional(),
});
const ExplainRequest = z.strictObject({
  commandId: Identifier,
  sessionId: Identifier,
  question: z.string().min(1).max(12_000),
  modelProfile: Identifier,
  mode: z.enum(['mock', 'live']),
  startFrom: StartFrom.optional(),
});
// CR-024: a request in an auto session; the runtime chooses the template and builds the team.
const AutoRunRequest = z.strictObject({
  harness: HarnessBindingRef.optional(),
  permissionMode: PermissionMode.optional(),
  ultra: UltraSelection.optional(),
  qualityPreset: QualityPreset.optional(),
  taskScope: RunInput.shape.taskScope,
  verificationScope: RunInput.shape.verificationScope,
  schemaVersion: SchemaVersion,
  commandId: Identifier,
  sessionId: Identifier,
  brief: z.string().trim().min(1).max(20_000),
  choice: AutoModelChoice,
  mode: z.enum(['mock', 'live']),
  startFrom: StartFrom.optional(),
  references: RunReferences.optional(),
});
const CreateProject = z.strictObject({
  name: z.string().max(200),
  description: z.string().max(2000).optional(),
});
const UpdateProject = z.strictObject({
  name: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
  archived: z.boolean().optional(),
  expectedRevision: z.int().min(1),
});
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
  assertLoopback(options.host ?? '127.0.0.1');
  const releaseOwnership = acquireWorkspaceOwnership(options.workspace);
  const resources = new AsyncDisposableStack();
  const closeResources = onceResourceCleanup(() => resources.disposeAsync(), releaseOwnership);
  try {
    return await createCorralServer(options, resources, closeResources);
  } catch (error) {
    await closeResources();
    throw error;
  }
}

async function createCorralServer(
  options: ServerOptions,
  resources: AsyncDisposableStack,
  closeResources: () => Promise<void>,
): Promise<CorralServer> {
  const host = options.host ?? '127.0.0.1';
  assertLoopback(host);
  const workspace = prepareWorkspace(options.workspace);
  const workerLeaseDirectory = join(workspace.root, '.corral', 'sdk-workers');
  await recoverSdkWorkers(workerLeaseDirectory);
  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? new RandomIdFactory();
  const db = openDatabase(workspace.dbPath);
  const images = new ImageStore(db, clock);
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
    const endpoints = endpointsFrom(workspace.config.modelProviders);
    registerEndpoints(options.live.models, endpoints);
    registry = new ModelRegistry(
      options.live.models,
      workspace.config.modelProfiles ??
        (await options.live.defaultProfiles?.()) ??
        DEFAULT_PROFILES,
      {
        credentials: options.live.credentials,
        getDeviceId: options.live.getDeviceId,
        ...(options.live.subscriptionModels
          ? { subscriptionModels: options.live.subscriptionModels }
          : {}),
        endpoints,
        configRevision: workspace.configRevision,
        maxOutputTokensPerCall: workspace.policy.maxOutputTokensPerCall,
      },
    );
    await registry.refreshStatus();
  }
  const decisionProviders = [new LocalHeuristicProvider(), ...(options.decisionProviders ?? [])];
  // A configured, installed provider loads ahead of the first judgment (the local model takes
  // a few seconds to load). A failed load only makes its judgments fail; the server keeps going.
  for (const id of new Set([
    ...judgmentSettings(workspace.config).reasoning_effort.providers,
    ...(workspace.config.decisions?.reasoning_effort.apply ? ['local-model'] : []),
  ])) {
    const provider = decisionProviders.find((p) => p.id === id) as
      | (DecisionProvider & { warmUp?: () => Promise<unknown> })
      | undefined;
    if (provider?.available() === true) void provider.warmUp?.().catch(() => {});
  }
  const store = new SqliteRunStore(db);
  const inputs = new InputRegistry(db, { ...options.inputs, clock });
  // CR-012: linked folders, session worktrees and the file broker.
  const files = new WorkspaceService({
    db,
    clock,
    hostId: workspace.id,
    worktreeRoot: options.worktreeRoot ?? defaultWorktreeRoot(),
    forbidden: [join(workspace.root, '.corral'), userConfigDir()],
    timers: options.timers ?? systemTimers,
  });
  // Startup has already confirmed termination of recovered SDK workers above. Only leases
  // without unresolved file, command, or checkpoint effects may now be released.
  files.confirmWorkerRecovery();
  resources.defer(() => files.dispose());

  const previews = new PreviewService({
    readSnapshot: (_sessionId, runId, path) => files.readPreviewSnapshot(runId, path),
    attestConnection: (sessionId, operationId, port, peerPort) =>
      files.attestCommandConnection(sessionId, operationId, port, peerPort),
    // A Run's command, or a person's development task (CR-046 P15), which has no Run.
    operationRun: async (sessionId, operationId) => {
      const operation = files.listCommands(sessionId).find((item) => item.id === operationId);
      if (operation?.state === 'running') return operation.run_id;
      if (files.userTaskRunning(sessionId, operationId)) return undefined;
      throw new WorkspaceError('TARGET_NOT_FOUND', 'the preview process is not running');
    },
    resolveRoot: async (sessionId, runId) => {
      if (
        !(await corrals.getSession(sessionId)) ||
        (runId && files.sessionOfRun(runId) !== sessionId)
      )
        throw new WorkspaceError('TARGET_NOT_FOUND', 'the preview session or run is unavailable');
      return files.resolvePreviewRoot(sessionId);
    },
  });
  resources.defer(() => previews.dispose());
  const previewTools = new PreviewToolsBroker(previews, {
    sessionOfRun: (runId) => files.sessionOfRun(runId),
    directory: join(workspace.root, '.corral', 'previews'),
  });
  resources.defer(() => previewTools.dispose());

  const review = new ReviewService({ db, clock, files });
  const mcpConfigDir = options.live?.configDir ?? userConfigDir();
  assertOutsideWorkspace(mcpConfigDir, workspace.root);
  const mcpCredentials = new McpCredentials({
    directory: join(mcpConfigDir, 'mcp', createHash('sha256').update(workspace.root).digest('hex')),
  });
  resources.defer(() => mcpCredentials.dispose());
  const mcp = new McpService(files, mcpCredentials, {
    store: new SqliteHarnessStore(db, clock),
    clock,
    leaseDirectory: workerLeaseDirectory,
  });
  resources.defer(() => mcp.cancelProbe());
  const harnesses = new HarnessService({
    mcp,
    db,
    clock,
    root: join(workspace.root, '.corral', 'harness'),
  });
  resources.defer(() => harnesses.dispose());

  const judgmentConfig = {
    providers: decisionProviders,
    settings: judgmentSettings(workspace.config),
  };
  const imageProfiles = new ImageProfileStore(db, () => registry);
  const imageGeneration = new ImageGenerationService(
    db,
    async (id) => imageProfiles.resolve(id),
    () => clock.nowIso(),
  );
  imageGeneration.cleanupOrphans();
  const coordinator = new Coordinator({
    previewTools,
    imageGeneration: {
      read: (runId, versionId) => {
        const stored = imageGeneration.read(runId, versionId);
        if (!stored) return null;
        const image = ImageInput.safeParse({
          kind: 'image_attachment',
          imageId: versionId,
          name: 'generated.png',
          mime: stored.media.mime,
          bytes: stored.media.bytes,
          width: stored.media.width,
          height: stored.media.height,
          sha256: stored.media.sha256,
          data: stored.bytes.toString('base64'),
        });
        return image.success ? image.data : null;
      },
      resolve: (id) => imageProfiles.resolve(id)?.profile ?? null,
      generate: (owner, args, profile, cancellation, reservedCostUsd, referenceImages) =>
        imageGeneration.generate(
          owner,
          args,
          cancellation,
          reservedCostUsd,
          profile,
          referenceImages,
        ),
    },
    runtimeRecovery: {
      confirm: async () => {
        await recoverSdkWorkers(workerLeaseDirectory);
        files.confirmWorkerRecovery();
      },
    },
    images,
    clock,
    ids,
    timers: options.timers ?? systemTimers,
    agents: routeByMode(
      options.agents,
      registry && options.live
        ? options.live.agents(registry, harnesses, workerLeaseDirectory)
        : null,
    ),
    ...(registry ? { models: registry } : {}),
    store,
    tools: inputs,
    files,
    harnesses,
    runner: new LangGraphRunner(),
    corrals,
    policy: workspace.policy,
    sessionId: backendSessionId,
    judgments: judgmentConfig,
  });

  const token = options.bootstrapToken ?? newBootstrapToken();
  const sessions = new Sessions(token);
  let port = options.port ?? 0;
  const boundary = boundaryFor(() => port, options.extraOrigins);
  const streams = new Set<() => void>();
  const limiter = new RequestLimiter(() => clock.monotonicMs());
  const terminalLimiter = new InteractiveRequestLimiter(() => clock.monotonicMs());

  const requestTimeoutMs = 30_000;
  const app = Fastify({
    logger: false,
    bodyLimit: 2 * 1024 * 1024,
    requestTimeout: requestTimeoutMs,
    forceCloseConnections: true,
    return503OnClosing: true,
  });
  resources.defer(() => app.close());
  let restartClosing = false;
  const mutations = new Set<FastifyRequest>();
  const handling = new WeakSet<FastifyRequest>();
  app.addHook('onResponse', async (request) => {
    mutations.delete(request);
  });
  app.addHook('preHandler', async (request) => {
    handling.add(request);
  });

  app.addHook('onRequest', async (request, reply) => {
    if (restartClosing)
      return reply
        .code(503)
        .send({ error: { code: 'STORAGE_UNAVAILABLE', message: 'The server is restarting.' } });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      mutations.add(request);
      request.raw.once('aborted', () => {
        if (!handling.has(request)) mutations.delete(request);
      });
    }
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
      const interactive = request.method === 'POST' && PTY_INTERACTIVE_ROUTES.includes(path);
      if (!interactive && !limiter.allow(!safe)) {
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
  app.addHook('onSend', async (request, reply, payload) => {
    const headers =
      request.routeOptions.url === PREVIEW_ROUTE && reply.statusCode === 200
        ? PREVIEW_HEADERS
        : SECURITY_HEADERS;
    for (const [name, value] of Object.entries(headers)) reply.header(name, value);
    return payload;
  });
  app.setErrorHandler(async (error: { statusCode?: number; code?: string }, request, reply) => {
    if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      // Closing with unread upload bytes can reset TCP before the client receives 413.
      // Discard within bounded byte/time allowances; never parse or retain rejected data.
      const drained = await drainRejectedBody(request.raw, {
        bodyLimit: request.routeOptions.bodyLimit,
        requestTimeoutMs,
        elapsedMs: reply.elapsedTime,
      });
      if (drained !== 'drained') {
        reply.hijack();
        reply.raw.destroy();
        mutations.delete(request);
        return;
      }
    }
    if (error.statusCode === 413)
      return reply.code(413).send({
        error: { code: 'SCHEMA_INVALID', message: 'request body exceeds its size limit' },
      });
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
  // Stored with the workspace so a new loopback port does not reset an explicit choice.
  const modeChoices = z.record(z.string().min(1).max(512), z.enum(['mock', 'live']));
  const modesPath = join(workspace.root, '.corral', 'run-modes.json');
  const readModes = (): Record<string, 'mock' | 'live'> => {
    try {
      return modeChoices.parse(JSON.parse(readFileSync(modesPath, 'utf8')));
    } catch {
      return {};
    }
  };
  app.get('/api/v1/run-modes', async () => ({ workspaceId: workspace.id, modes: readModes() }));
  app.put('/api/v1/run-modes', async (request, reply) => {
    const choice = z
      .strictObject({ key: z.string().min(1).max(512), mode: z.enum(['mock', 'live']) })
      .safeParse(request.body);
    if (!choice.success) return fail(reply, 'SCHEMA_INVALID', 'invalid run mode selection');
    const modes = readModes();
    modes[choice.data.key] = choice.data.mode;
    writeFileSync(`${modesPath}.tmp`, JSON.stringify(modes), { mode: 0o600 });
    renameSync(`${modesPath}.tmp`, modesPath);
    return { ok: true };
  });
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
  // ── Projects (CR-010) ───────────────────────────────────────────────────────
  const projectReply = (reply: FastifyReply, result: ProjectResult, created: boolean) => {
    if (result.ok) return reply.code(created ? 201 : 200).send(result);
    const code: ErrorCode =
      result.error === 'not_found'
        ? 'TARGET_NOT_FOUND'
        : result.error === 'revision_conflict'
          ? 'REVISION_CONFLICT'
          : result.error === 'invalid'
            ? 'SCHEMA_INVALID'
            : 'STORAGE_UNAVAILABLE';
    return fail(reply, code, result.message);
  };
  app.get('/api/v1/projects', async () => corrals.listProjects());
  app.post('/api/v1/projects', async (request, reply) => {
    const body = parse(CreateProject, request, reply);
    if (!body) return reply;
    return projectReply(reply, await corrals.createProject(body), true);
  });
  app.patch<{ Params: { projectId: string } }>(
    '/api/v1/projects/:projectId',
    async (request, reply) => {
      const body = parse(UpdateProject, request, reply);
      if (!body) return reply;
      return projectReply(
        reply,
        await corrals.updateProject(request.params.projectId, body),
        false,
      );
    },
  );
  app.put<{ Params: { corralId: string } }>(
    '/api/v1/corrals/:corralId/project',
    async (request, reply) => {
      const body = parse(z.strictObject({ projectId: Identifier }), request, reply);
      if (!body) return reply;
      return saveReply(
        reply,
        await corrals.moveCorral(request.params.corralId, body.projectId),
        false,
      );
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
  app.get<{ Params: { documentId: string } }>(
    '/api/v1/documents/:documentId/source',
    async (request, reply) => {
      reply.header('cache-control', 'no-store').header('x-content-type-options', 'nosniff');
      if (!/^doc_[a-f0-9]{64}$/.test(request.params.documentId))
        return fail(reply, 'SCHEMA_INVALID', 'invalid document ID');
      const source = inputs.sourceEvidence(request.params.documentId);
      return source ?? fail(reply, 'TARGET_NOT_FOUND', 'source evidence not found');
    },
  );
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

  registerHarnessRoutes(app, harnesses, files);
  const skillQuality = new SkillQualityService({
    db,
    clock,
    harness: harnesses,
    coordinator,
    timers: options.timers ?? systemTimers,
  });
  resources.defer(() => skillQuality.close());
  registerSkillQualityRoutes(app, skillQuality);

  // ── models (C-058) ─────────────────────────────────────────────────────────
  // Status and expiry only; tokens never appear in these answers (ADR-019).
  app.get('/api/v1/model-profiles', async () => registry?.profilesView() ?? []);
  app.get('/api/v1/model-auth', async () => registry?.authView() ?? []);
  type ProviderParams = { Params: { providerId: string } };
  const registryFailure = (reply: FastifyReply, error: unknown) =>
    error instanceof RegistryError && error.code === 'unsupported'
      ? fail(reply, 'COMMAND_NOT_SUPPORTED', error.message)
      : fail(reply, 'TARGET_NOT_FOUND', 'no model profile uses this provider');
  const noLive = (reply: FastifyReply) =>
    fail(reply, 'COMMAND_NOT_SUPPORTED', 'this server has no live model connection');
  app.post<ProviderParams>('/api/v1/model-auth/:providerId/login', async (request, reply) => {
    if (!registry) return noLive(reply);
    try {
      return reply.code(202).send(await registry.startLogin(request.params.providerId));
    } catch (error) {
      return registryFailure(reply, error);
    }
  });
  // CR-005: a key typed under Settings → Models; stored on this computer, never sent back.
  app.put<ProviderParams>('/api/v1/model-auth/:providerId/api-key', async (request, reply) => {
    if (!registry) return noLive(reply);
    const body = parse(
      z.strictObject({
        key: z.string().trim().min(1).max(1000),
        revision: z.string().min(1).max(100).optional(),
      }),
      request,
      reply,
    );
    if (!body) return reply;
    if (body.revision !== undefined && body.revision !== configRevision(workspace.root))
      return fail(reply, 'REVISION_CONFLICT', 'the config changed before the key was saved');
    try {
      await registry.setApiKey(request.params.providerId, body.key);
    } catch (error) {
      return registryFailure(reply, error);
    }
    return registry.authView();
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

  const reasoningSettings = () => {
    const provider = decisionProviders.find((p) => p.id === 'local-model' && p.privacy === 'local');
    const availability = provider?.available();
    return {
      apply: workspace.config.decisions?.reasoning_effort.apply === true,
      available: availability === true,
      version: provider?.version ?? null,
      reason:
        availability === true ? null : 'Local judge is unavailable. Run corral judge install.',
      revision: configRevision(workspace.root),
    };
  };
  app.get('/api/v1/models/reasoning', async () => reasoningSettings());
  app.put('/api/v1/models/reasoning', async (request, reply) => {
    const parsed = z
      .strictObject({ apply: z.boolean(), revision: z.string().min(1) })
      .safeParse(request.body);
    if (!parsed.success) return fail(reply, 'SCHEMA_INVALID', 'invalid reasoning setting');
    const changed = writeReasoningApply(workspace.root, parsed.data.apply, parsed.data.revision);
    if (!changed.ok)
      return reply
        .code(409)
        .send({ error: { code: 'SCHEMA_INVALID', message: 'config changed; reload settings' } });
    workspace.config = changed.config;
    workspace.configRevision = changed.revision;
    registry?.setConfigRevision(changed.revision);
    judgmentConfig.settings = judgmentSettings(changed.config);
    if (parsed.data.apply) {
      const provider = decisionProviders.find((p) => p.id === 'local-model');
      if (
        provider?.available() === true &&
        'warmUp' in provider &&
        typeof provider.warmUp === 'function'
      )
        void provider.warmUp().catch(() => {});
    }
    return reasoningSettings();
  });

  // ── model settings (CR-008) ────────────────────────────────────────────────
  // Providers and models to choose from; never credentials or sign-in status.
  app.get('/api/v1/model-catalog', async () => registry?.catalog() ?? []);
  app.get('/api/v1/model-config', async (_request, reply) => {
    if (!registry) return noLive(reply);
    let snapshot: ReturnType<typeof readWorkspaceConfig>;
    try {
      snapshot = readWorkspaceConfig(workspace.root);
    } catch {
      return fail(reply, 'SCHEMA_INVALID', 'workspace configuration is invalid');
    }
    return {
      modelProfiles:
        snapshot.config.modelProfiles ??
        (await options.live?.defaultProfiles?.()) ??
        DEFAULT_PROFILES,
      modelProviders: snapshot.config.modelProviders ?? [],
      usingDefaults: snapshot.config.modelProfiles === undefined,
      revision: snapshot.revision,
      effectiveProfiles: registry.contextPolicies(
        snapshot.config.modelProfiles ?? registry.profileConfigs(),
        endpointsFrom(snapshot.config.modelProviders),
        snapshot.revision,
      ),
    };
  });
  const modelConfigBody = z.strictObject({
    revision: z.string().min(1).max(100),
    modelProfiles: z.array(z.unknown()).max(20),
    modelProviders: z.array(z.unknown()).max(10),
  });
  app.post('/api/v1/model-config/preview', async (request, reply) => {
    if (!registry) return noLive(reply);
    const body = parse(modelConfigBody, request, reply);
    if (!body) return reply;
    const parsed = parseWorkspaceConfig({
      schemaVersion: '0.1',
      modelProfiles: body.modelProfiles,
      modelProviders: body.modelProviders,
    });
    if (!parsed.ok) return fail(reply, 'SCHEMA_INVALID', parsed.errors.join('; '));
    return {
      revision: body.revision,
      effectiveProfiles: registry.contextPolicies(
        parsed.config.modelProfiles ?? [],
        endpointsFrom(parsed.config.modelProviders),
        body.revision,
      ),
    };
  });
  app.put('/api/v1/model-config', async (request, reply) => {
    const live = options.live;
    if (!registry || !live) return noLive(reply);
    const body = parse(modelConfigBody, request, reply);
    if (!body) return reply;
    const current = registry;
    const written = writeModelConfig(
      workspace.root,
      { modelProfiles: body.modelProfiles, modelProviders: body.modelProviders },
      body.revision,
      (config) => {
        const next = endpointsFrom(config.modelProviders);
        return [
          ...endpointClashes(live.models, next),
          ...current.unknownProviders(config.modelProfiles ?? [], next),
          ...(config.modelProfiles ?? []).flatMap((profile, index) =>
            current
              .contextPolicy(profile, next, body.revision)
              .errors.map((error) => `modelProfiles.${index}: ${error}`),
          ),
        ];
      },
    );
    if (!written.ok) {
      return fail(
        reply,
        written.conflict ? 'REVISION_CONFLICT' : 'SCHEMA_INVALID',
        written.errors.join('; '),
      );
    }
    workspace.config = written.config;
    workspace.configRevision = written.revision;
    const endpoints = endpointsFrom(written.config.modelProviders);
    registerEndpoints(live.models, endpoints);
    await current.reconfigure(
      written.config.modelProfiles ?? DEFAULT_PROFILES,
      endpoints,
      written.revision,
    );
    return {
      modelProfiles: current.profileConfigs(),
      modelProviders: written.config.modelProviders ?? [],
      usingDefaults: false,
      revision: written.revision,
      effectiveProfiles: current.contextPolicies(),
    };
  });

  registerModelImportRoutes(app, { workspace, registry, live: options.live });
  registerPreviewRoutes(app, previews, previewTools);
  const projectServices = registerProjectRoutes(app, { root: workspace.root, repository: corrals });
  registerVoiceRoutes(app, {
    registry,
    hasSession: async (id) => Boolean(await corrals.getSession(id)),
    hasRun: async (sessionId, runId) => files.sessionOfRun(runId) === sessionId,
  });
  app.get<{ Params: { sessionId: string } }>(
    '/api/v1/sessions/:sessionId/processes',
    async (request, reply) => {
      if (!(await corrals.getSession(request.params.sessionId)))
        return fail(reply, 'TARGET_NOT_FOUND', 'no such session');
      return files.listCommands(request.params.sessionId);
    },
  );
  app.get<{ Params: { sessionId: string; operationId: string }; Querystring: { offset?: string } }>(
    '/api/v1/sessions/:sessionId/processes/:operationId/output',
    async (request, reply) => {
      if (!(await corrals.getSession(request.params.sessionId)))
        return fail(reply, 'TARGET_NOT_FOUND', 'no such session');
      const offset = Number(request.query.offset ?? 0);
      if (!Number.isSafeInteger(offset) || offset < 0)
        return fail(reply, 'SCHEMA_INVALID', 'invalid output offset');
      return files.readCommandOutput(request.params.sessionId, request.params.operationId, offset);
    },
  );
  app.get<{ Params: { sessionId: string; operationId: string } }>(
    '/api/v1/sessions/:sessionId/processes/:operationId',
    async (request, reply) => {
      if (!(await corrals.getSession(request.params.sessionId)))
        return fail(reply, 'TARGET_NOT_FOUND', 'no such session');
      return files.commandReport(request.params.sessionId, request.params.operationId);
    },
  );
  app.post<{ Params: { sessionId: string; operationId: string } }>(
    '/api/v1/sessions/:sessionId/processes/:operationId/stop',
    async (request, reply) => {
      if (!(await corrals.getSession(request.params.sessionId)))
        return fail(reply, 'TARGET_NOT_FOUND', 'no such session');
      return files.stopCommand(request.params.sessionId, request.params.operationId);
    },
  );

  // ── team drafts (CR-006) ───────────────────────────────────────────────────
  // One model request for a goal; only a plan that passes the contract comes back.
  app.post('/api/v1/team-drafts', async (request, reply) => {
    if (!registry) return noLive(reply);
    const body = parse(
      z.strictObject({ goal: z.string().trim().min(1).max(2000) }),
      request,
      reply,
    );
    if (!body) return reply;
    const result = await registry.draftTeam(body.goal);
    return result.ok
      ? { plan: result.plan, model: result.model }
      : fail(reply, result.code, result.message);
  });

  // ── runs ───────────────────────────────────────────────────────────────────
  app.get('/api/v1/runs', async () => coordinator.listRuns());
  app.get<{ Params: { commandId: string } }>(
    '/api/v1/start-commands/:commandId',
    async (request, reply) => {
      if (!Identifier.safeParse(request.params.commandId).success)
        return fail(reply, 'SCHEMA_INVALID', 'invalid start command');
      const result = coordinator.startResult(request.params.commandId);
      if (!result) return fail(reply, 'TARGET_NOT_FOUND', 'start command is not recorded');
      return {
        ...result,
        autoRoute: result.runId
          ? (coordinator.getRunSnapshot(result.runId)?.autoRoute ?? null)
          : null,
      };
    },
  );
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
    // CR-011: a run joins a session of its Corral's project only.
    if (parsed.data.sessionId && !resend) {
      const session = await corrals.getSession(parsed.data.sessionId);
      const corral = await corrals.get(parsed.data.corralId);
      if (!session || (corral && corral.projectId !== session.projectId)) {
        const message = 'the session does not exist in this Corral’s project';
        return reply.code(404).send({
          runId: null,
          receipt: refusedStart(request.body, { code: 'TARGET_NOT_FOUND', message }),
        });
      }
    }
    const startTree =
      parsed.data.sessionId && !resend ? await files.currentTree(parsed.data.sessionId) : null;
    const result = coordinator.startRun(parsed.data);
    if (result.runId && startTree && parsed.data.sessionId)
      await trackRunFiles(result.runId, parsed.data.sessionId, startTree);
    const status = result.receipt.error ? STATUS[result.receipt.error.code] : resend ? 200 : 201;
    return reply.code(status).send(result);
  });
  // A question about a result (CR-011): its own one-agent run, in the asking session.
  app.post('/api/v1/runs/explain', async (request, reply) => {
    const body = parse(ExplainRequest, request, reply);
    if (!body) return reply;
    const resend = coordinator.hasStartCommand(body.commandId);
    if (!resend && !(await corrals.getSession(body.sessionId))) {
      return fail(reply, 'TARGET_NOT_FOUND', 'no such session');
    }
    const explainTree = resend ? null : await files.currentTree(body.sessionId);
    const result = coordinator.startRun({
      schemaVersion: SCHEMA_VERSION,
      commandId: body.commandId,
      definition: explainDefinition({
        id: `explain_${body.sessionId.replace(/^session_/, '')}`,
        question: body.question,
        modelProfile: body.modelProfile,
      }),
      mode: body.mode,
      sessionId: body.sessionId,
      ...(body.startFrom ? { startFrom: body.startFrom } : {}),
    });
    if (result.runId && explainTree) await trackRunFiles(result.runId, body.sessionId, explainTree);
    const status = result.receipt.error ? STATUS[result.receipt.error.code] : resend ? 200 : 201;
    return reply.code(status).send(result);
  });

  // An auto session's request (CR-024): one capped choice request, then one run of the chosen
  // template. A resend returns the first start; a dropped connection while choosing starts none.
  const autoStarter = createAutoStarter<AbortSignal>({
    prepareModels: (request) =>
      coordinator.prepareModels(
        request.ultra?.modelProfiles ?? [request.choice.modelProfile],
        request.mode,
      ),
    resolveUltra: (selection, primary, mode, models) =>
      coordinator.resolveUltra(selection, primary, mode, models),
    startRun: async (request, signal, models) => {
      // Choosing can take 30 seconds; edits before the run belong to its starting tree.
      const startTree = request.sessionId ? await files.currentTree(request.sessionId) : null;
      if (signal?.aborted) throw new Error('the auto request was cancelled before a run started');
      const route = request.autoRoute;
      const result = coordinator.startRun(
        route
          ? {
              ...request,
              definition: autoDefinition({
                id: request.definition.id,
                template: route.template,
                ...(route.qualityPreset ? { qualityPreset: route.qualityPreset } : {}),
                ...(route.ultra ? { ultra: route.ultra } : {}),
                brief: request.definition.input.brief,
                criteria: request.definition.input.criteria,
                taskScope: request.definition.input.taskScope,
                verificationScope: request.definition.input.verificationScope,
                choice: {
                  modelProfile: route.modelProfile,
                  ...(route.reasoning ? { reasoning: route.reasoning } : {}),
                },
                fileTools: startTree !== null,
                ...(route.harness ? { harness: route.harness, commandTools: true } : {}),
                ...(route.reasoningChoice ? { routeLevel: route.reasoningChoice.level } : {}),
              }),
            }
          : request,
        models,
      );
      if (result.runId && startTree && request.sessionId)
        await trackRunFiles(result.runId, request.sessionId, startTree);
      return result;
    },
    previousStart: (commandId, requestHash, original) => {
      const result = coordinator.startResult(commandId, requestHash, original);
      if (!result) return null;
      const autoRoute = result.runId
        ? (coordinator.getRunSnapshot(result.runId)?.autoRoute ?? null)
        : null;
      return { ...result, autoRoute };
    },
    precheck: (request) => {
      const error = coordinator.startRefusal(
        request.choice.modelProfile,
        request.mode,
        request.choice.reasoning,
        request.references?.some((reference) => reference.kind === 'image_attachment'),
      );
      return error ? { runId: null, receipt: refusedStart(request, error) } : null;
    },
    levels: (choice, mode) => coordinator.reasoningLevels(choice.modelProfile, mode),
    route: ({ brief, choice, mode, signal, levels, models }) =>
      mode === 'live' && registry
        ? registry.routeAuto(brief, choice, signal, levels, models?.[choice.modelProfile])
        : null,
  });
  type AutoResult = Awaited<ReturnType<typeof autoStarter.start>>;
  const autoRequests = new Map<
    string,
    { sessionId: string; controller: AbortController; work: Promise<AutoResult> }
  >();
  resources.defer(() => {
    for (const pending of autoRequests.values()) pending.controller.abort();
  });
  const cancelledAuto = (commandId: string): AutoResult => ({
    runId: null,
    autoRoute: null,
    receipt: {
      commandId,
      runId: 'none',
      status: 'cancelled',
      acceptedSeq: null,
      target: 'run:none',
      requestedBoundary: 'immediate',
      relatedEventIds: [],
    },
  });
  const recordedAuto = (commandId: string): AutoResult | null => {
    const result = coordinator.startResult(commandId);
    return result
      ? {
          ...result,
          autoRoute: result.runId
            ? (coordinator.getRunSnapshot(result.runId)?.autoRoute ?? null)
            : null,
        }
      : null;
  };
  const schedules = new ScheduleService(new ScheduleStore(db), {
    now: () => clock.nowIso(),
    id: () => `schedule_${crypto.randomUUID().replaceAll('-', '')}`,
    repository: corrals,
    start: (request, signal) => autoStarter.start(request, { fileTools: false, signal }),
    previous: recordedAuto,
    isRunActive: (id) => {
      const run = coordinator.listRuns().find((item) => item.runId === id);
      return Boolean(run && !TERMINAL_RUN_STATUSES.has(run.status));
    },
  });
  registerScheduleRoutes(app, schedules);
  app.addHook('onReady', () => schedules.start());
  resources.defer(() => schedules.stop());
  const vaultDirectory = join(
    mcpConfigDir,
    'vault',
    createHash('sha256').update(workspace.root).digest('hex'),
  );
  const vault = new VaultService({
    directory: vaultDirectory,
    adapters: (bindings) => ({
      automation: scheduleVaultAdapter(schedules),
      ...createHarnessVaultAdapters({
        harness: harnesses,
        ...(bindings.mcp?.projectId ? { projectId: bindings.mcp.projectId } : {}),
      }),
      ...materialsVaultAdapters(projectServices.materials, corrals),
      ...(registry && options.live
        ? { providers: providersVaultAdapter({ workspace, registry, live: options.live }) }
        : {}),
      ...(bindings.subagents?.corralId
        ? {
            subagents: createSubagentsVaultAdapter({
              repository: corrals,
              corralId: bindings.subagents.corralId,
              profiles: async () =>
                (registry?.profilesView() ?? []).map((profile) => ({
                  profileId: profile.profileId,
                  available:
                    profile.available &&
                    profile.method !== null &&
                    !(profile.method === 'oauth' && profile.subscriptionSupported === false),
                })),
              resolveHarness: async (binding, projectId) =>
                harnesses.preview(binding, projectId).snapshot,
            }),
          }
        : {}),
    }),
  });
  registerVaultRoutes(app, { vault, directory: vaultDirectory });
  app.post('/api/v1/runs/auto', async (request, reply) => {
    const body = parse(AutoRunRequest, request, reply);
    if (!body) return reply;
    const dropped = new AbortController();
    const onClose = () => {
      if (!reply.raw.writableEnded) dropped.abort();
    };
    reply.raw.once('close', onClose);
    if (reply.raw.destroyed || request.raw.aborted) dropped.abort();
    try {
      const resend = coordinator.hasStartCommand(body.commandId);
      if (!resend && !(await corrals.getSession(body.sessionId)))
        return fail(reply, 'TARGET_NOT_FOUND', 'no such session');
      const work = autoStarter.start(
        {
          commandId: body.commandId,
          sessionId: body.sessionId,
          brief: body.brief,
          ...(body.qualityPreset ? { qualityPreset: body.qualityPreset } : {}),
          ...(body.ultra ? { ultra: body.ultra } : {}),
          choice: body.choice,
          mode: body.mode,
          ...(body.permissionMode ? { permissionMode: body.permissionMode } : {}),
          ...(body.harness ? { harness: body.harness } : {}),
          ...(body.taskScope ? { taskScope: body.taskScope } : {}),
          ...(body.verificationScope ? { verificationScope: body.verificationScope } : {}),
          ...(body.startFrom ? { startFrom: body.startFrom } : {}),
          ...(body.references ? { references: body.references } : {}),
        },
        { fileTools: false, signal: dropped.signal },
      );
      if (!autoRequests.has(body.commandId)) {
        const pending = { sessionId: body.sessionId, controller: dropped, work };
        autoRequests.set(body.commandId, pending);
        const clear = () => {
          if (autoRequests.get(body.commandId) === pending) autoRequests.delete(body.commandId);
        };
        void work.then(clear, clear);
      }
      const result = await work;
      const status = result.receipt.error ? STATUS[result.receipt.error.code] : resend ? 200 : 201;
      return reply.code(status).send(result);
    } catch (error) {
      if (dropped.signal.aborted) {
        if (reply.raw.destroyed) return reply;
        return reply.send(recordedAuto(body.commandId) ?? cancelledAuto(body.commandId));
      }
      if (recordedAuto(body.commandId)?.receipt.status === 'cancelled')
        return reply.send(recordedAuto(body.commandId) ?? cancelledAuto(body.commandId));
      throw error;
    } finally {
      reply.raw.off('close', onClose);
    }
  });
  app.post<{ Params: { commandId: string } }>(
    '/api/v1/runs/auto/:commandId/cancel',
    async (request, reply) => {
      const body = parse(
        z.strictObject({ sessionId: Identifier, cancelCommandId: Identifier }),
        request,
        reply,
      );
      if (!body) return reply;
      const { commandId } = request.params;
      if (!Identifier.safeParse(commandId).success)
        return fail(reply, 'SCHEMA_INVALID', 'invalid start command');
      if (body.cancelCommandId === commandId)
        return fail(reply, 'SCHEMA_INVALID', 'cancellation needs its own command ID');
      if (!(await corrals.getSession(body.sessionId)))
        return fail(reply, 'TARGET_NOT_FOUND', 'no such session');
      const pending = autoRequests.get(commandId);
      const previous = recordedAuto(commandId);
      const run = previous?.runId
        ? coordinator.listRuns().find((run) => run.runId === previous.runId)
        : null;
      if (
        (pending && pending.sessionId !== body.sessionId) ||
        (run && (run.sessionId !== body.sessionId || !previous?.autoRoute))
      )
        return fail(reply, 'TARGET_NOT_FOUND', 'no such auto request in this session');
      const stopped = coordinator.cancelAutoStart(commandId, body.sessionId);
      pending?.controller.abort();
      if (stopped.receipt.error)
        return fail(reply, stopped.receipt.error.code, stopped.receipt.error.message);
      await pending?.work.catch(() => undefined);
      const start = recordedAuto(commandId);
      if (!start?.runId) return { start: null, cancellation: null };
      const committed = coordinator.listRuns().find((run) => run.runId === start.runId);
      if (committed?.sessionId !== body.sessionId || !start.autoRoute)
        return fail(reply, 'TARGET_NOT_FOUND', 'no such auto request in this session');
      const cancellation =
        !TERMINAL_RUN_STATUSES.has(committed.status) ||
        coordinator.getReceipt(start.runId, body.cancelCommandId)
          ? coordinator.submit({
              schemaVersion: SCHEMA_VERSION,
              commandId: body.cancelCommandId,
              runId: start.runId,
              type: 'cancel',
              payload: { scope: { kind: 'run' }, reason: 'User cancelled the auto request' },
            })
          : null;
      return { start, cancellation };
    },
  );

  // ── Work folders and file changes (CR-012) ───────────────────────────────────
  /** A run's start snapshot is recorded, and its end snapshot taken when it ends. */
  async function trackRunFiles(runId: string, sessionId: string, startTree: string) {
    const baseline = (await files.startBaseline(runId)) ?? startTree;
    await files.recordRunStart(runId, sessionId, baseline);
    const stop = coordinator.subscribe(runId, 0, (event) => {
      if (event.type === 'run.state_changed' && TERMINAL_RUN_STATUSES.has(event.payload.to)) {
        stop();
        void files.snapshotRun(runId, sessionId, 'end').catch(() => undefined);
      }
    });
  }
  const workspaceFail = (reply: FastifyReply, error: unknown) => {
    if (error instanceof WorkspaceError) return fail(reply, error.code, error.message);
    if (error instanceof ToolRefusal) return fail(reply, 'SCHEMA_INVALID', error.message);
    // Git's message can name local paths; only the step is reported.
    return fail(reply, 'STORAGE_UNAVAILABLE', 'the folder operation failed');
  };
  const sessionOr404 = async (reply: FastifyReply, sessionId: string) => {
    const session = await corrals.getSession(sessionId);
    if (!session) void fail(reply, 'TARGET_NOT_FOUND', 'no such session');
    return session;
  };
  registerTerminalRoutes(app, {
    terminals: files.terminals,
    hasSession: async (sessionId) => Boolean(await corrals.getSession(sessionId)),
    fail,
    streams,
    limiter: terminalLimiter,
  });
  const runEnded = (runId: string) => {
    const status = coordinator.listRuns().find((r) => r.runId === runId)?.status;
    return status ? TERMINAL_RUN_STATUSES.has(status) : true;
  };
  type ProjectParams = { Params: { projectId: string } };
  type SessionParams = { Params: { sessionId: string } };

  app.addContentTypeParser(
    'image/png',
    { parseAs: 'buffer', bodyLimit: IMAGE_MAX_BYTES },
    (_request, body, done) => done(null, body),
  );
  app.post<SessionParams & { Querystring: { name?: string } }>(
    '/api/v1/sessions/:sessionId/images',
    { bodyLimit: IMAGE_MAX_BYTES },
    async (request, reply) => {
      try {
        const name = ImageAttachment.shape.name.parse(request.query.name);
        if (request.headers['content-type'] !== 'image/png' || !Buffer.isBuffer(request.body))
          return fail(reply, 'SCHEMA_INVALID', 'normalized PNG input required');
        return reply.code(201).send(images.put(request.params.sessionId, name, request.body));
      } catch {
        return fail(
          reply,
          'SCHEMA_INVALID',
          'image unavailable, invalid, or over its size/dimension/storage limit',
        );
      }
    },
  );
  app.get<{ Params: { sessionId: string; imageId: string } }>(
    '/api/v1/sessions/:sessionId/images/:imageId',
    async (request, reply) => {
      try {
        const image = images.body(request.params.sessionId, request.params.imageId);
        if (!image) return fail(reply, 'TARGET_NOT_FOUND', 'image is unavailable in this session');
        return reply
          .header('cache-control', 'no-store')
          .header('content-type', 'image/png')
          .header('x-content-type-options', 'nosniff')
          .send(image.bytes);
      } catch {
        return fail(reply, 'STORAGE_UNAVAILABLE', 'image integrity could not be verified');
      }
    },
  );

  app.post<SessionParams>('/api/v1/sessions/:sessionId/hunks/preview', async (request, reply) => {
    const body = parse(HunkRequest, request, reply);
    if (!body) return reply;
    try {
      return await files.hunks(request.params.sessionId, body);
    } catch (error) {
      return workspaceFail(reply, error);
    }
  });
  app.post<SessionParams>('/api/v1/sessions/:sessionId/hunks/plan', async (request, reply) => {
    const body = parse(HunkPlanRequest, request, reply);
    if (!body) return reply;
    try {
      return await coordinator.withFileRestore(
        () => files.planHunks(request.params.sessionId, body),
        request.params.sessionId,
      );
    } catch (error) {
      return workspaceFail(reply, error);
    }
  });

  app.get<SessionParams>('/api/v1/sessions/:sessionId/checkpoints', async (request) => ({
    checkpoints: files.checkpoints(request.params.sessionId),
    restores: files.checkpointRestores(request.params.sessionId),
  }));
  app.post<SessionParams>('/api/v1/sessions/:sessionId/checkpoints', async (request, reply) => {
    const body = parse(CaptureCheckpoint, request, reply);
    if (!body) return reply;
    try {
      return await coordinator.withFileRestore(
        () => files.captureCheckpoint(request.params.sessionId, body),
        request.params.sessionId,
      );
    } catch (error) {
      return workspaceFail(reply, error);
    }
  });
  app.post<SessionParams>('/api/v1/sessions/:sessionId/checkpoints/pin', async (request, reply) => {
    const body = parse(
      z.strictObject({ checkpointId: Identifier, pinned: z.boolean() }),
      request,
      reply,
    );
    if (!body) return reply;
    try {
      files.pinCheckpoint(request.params.sessionId, body.checkpointId, body.pinned);
      return reply.code(204).send();
    } catch (error) {
      return workspaceFail(reply, error);
    }
  });
  app.post<SessionParams>(
    '/api/v1/sessions/:sessionId/checkpoints/prune',
    async (request, reply) => {
      const body = parse(z.strictObject({}), request, reply);
      if (!body) return reply;
      try {
        return await coordinator.withFileRestore(
          () => files.pruneCheckpoints(request.params.sessionId),
          request.params.sessionId,
        );
      } catch (error) {
        return workspaceFail(reply, error);
      }
    },
  );
  app.post<SessionParams>(
    '/api/v1/sessions/:sessionId/checkpoints/plan',
    async (request, reply) => {
      const body = parse(
        RestoreCheckpoint.pick({ checkpointId: true, manifestHash: true }),
        request,
        reply,
      );
      if (!body) return reply;
      try {
        return await files.planCheckpointRestore(
          request.params.sessionId,
          body.checkpointId,
          body.manifestHash,
        );
      } catch (error) {
        return workspaceFail(reply, error);
      }
    },
  );
  app.post<SessionParams>(
    '/api/v1/sessions/:sessionId/checkpoints/restore',
    async (request, reply) => {
      const body = parse(RestoreCheckpoint, request, reply);
      if (!body) return reply;
      try {
        return await coordinator.withFileRestore(
          () => files.restoreCheckpoint(request.params.sessionId, body),
          request.params.sessionId,
        );
      } catch (error) {
        return workspaceFail(reply, error);
      }
    },
  );

  const gitFail = (reply: FastifyReply, error: unknown) => {
    if (error instanceof WorkspaceError || error instanceof ToolRefusal)
      return fail(reply, error.code, error.message);
    return fail(reply, 'STORAGE_UNAVAILABLE', 'the Git request failed');
  };
  const GitDiffQuery = GitDiffRequest.omit({ target: true, head: true }).extend({
    target: z.string().max(4096),
    head: z.string().max(64),
  });
  // DW-05: the browser chooses a registered scope, never an absolute filesystem root.
  for (const [kind, base] of [
    ['project', '/api/v1/projects/:id/workspace'],
    ['session', '/api/v1/sessions/:id/worktree'],
  ] as const) {
    app.get<{ Params: { id: string } }>(`${base}/git/status`, async (request, reply) => {
      if (!z.strictObject({}).safeParse(request.query).success)
        return fail(reply, 'SCHEMA_INVALID', 'Git status takes no query parameters');
      try {
        return await files.gitStatus({ kind, id: request.params.id });
      } catch (error) {
        return gitFail(reply, error);
      }
    });
    app.get<{ Params: { id: string } }>(`${base}/git/diff`, async (request, reply) => {
      const query = GitDiffQuery.safeParse(request.query);
      if (!query.success) return fail(reply, 'SCHEMA_INVALID', 'invalid Git diff query');
      let target: unknown;
      try {
        target = JSON.parse(query.data.target);
      } catch {
        return fail(reply, 'SCHEMA_INVALID', 'invalid Git target');
      }
      const input = GitDiffRequest.safeParse({
        ...query.data,
        target,
        head: query.data.head === '' ? null : query.data.head,
      });
      if (!input.success) return fail(reply, 'SCHEMA_INVALID', 'invalid Git diff query');
      try {
        return await files.gitDiff({ kind, id: request.params.id }, input.data);
      } catch (error) {
        return gitFail(reply, error);
      }
    });
    app.get<{ Params: { id: string } }>(`${base}/files`, async (request, reply) => {
      const query = z
        .strictObject({ path: z.string().max(4096).default('') })
        .safeParse(request.query);
      if (!query.success) return fail(reply, 'SCHEMA_INVALID', 'path must be relative');
      try {
        return await files.listFiles({ kind, id: request.params.id }, query.data.path);
      } catch (error) {
        return workspaceFail(reply, error);
      }
    });
    // CR-016: names for an `@` reference, ranked; never file contents.
    app.get<{ Params: { id: string } }>(`${base}/search`, async (request, reply) => {
      const query = z
        .strictObject({
          q: z.string().max(200).default(''),
          limit: z.coerce.number().int().min(1).max(50).default(20),
        })
        .safeParse(request.query);
      if (!query.success) return fail(reply, 'SCHEMA_INVALID', 'q and limit are invalid');
      try {
        return await files.searchPaths(
          { kind, id: request.params.id },
          query.data.q,
          query.data.limit,
        );
      } catch (error) {
        return workspaceFail(reply, error);
      }
    });
    app.get<{ Params: { id: string } }>(`${base}/file`, async (request, reply) => {
      const query = z.strictObject({ path: z.string().min(1).max(4096) }).safeParse(request.query);
      if (!query.success) return fail(reply, 'SCHEMA_INVALID', 'path is required');
      try {
        return await files.readFile({ kind, id: request.params.id }, query.data.path);
      } catch (error) {
        return workspaceFail(reply, error);
      }
    });
  }

  app.get<ProjectParams>('/api/v1/projects/:projectId/workspace', async (request, reply) => {
    try {
      return { binding: await files.view(request.params.projectId) };
    } catch (error) {
      return workspaceFail(reply, error);
    }
  });
  app.put<ProjectParams>('/api/v1/projects/:projectId/workspace', async (request, reply) => {
    const body = parse(z.strictObject({ path: z.string().min(1).max(4096) }), request, reply);
    if (!body) return reply;
    const project = (await corrals.listProjects()).find(
      (p) => p.projectId === request.params.projectId,
    );
    if (!project) return fail(reply, 'TARGET_NOT_FOUND', 'no such project');
    try {
      return reply.code(201).send({ binding: await files.bind(project.projectId, body.path) });
    } catch (error) {
      return workspaceFail(reply, error);
    }
  });
  app.patch<ProjectParams>('/api/v1/projects/:projectId/workspace', async (request, reply) => {
    const body = parse(
      z.strictObject({
        trusted: z.boolean().optional(),
        verifyCommands: z
          .array(
            z.strictObject({
              id: Identifier,
              name: z.string().min(1).max(80),
              argv: z.array(z.string().min(1).max(500)).min(1).max(30),
              timeoutMs: z
                .int()
                .min(1000)
                .max(30 * 60_000),
            }),
          )
          .max(10)
          .optional(),
      }),
      request,
      reply,
    );
    if (!body) return reply;
    try {
      return { binding: await files.configure(request.params.projectId, body) };
    } catch (error) {
      return workspaceFail(reply, error);
    }
  });
  app.delete<ProjectParams>('/api/v1/projects/:projectId/workspace', async (request, reply) => {
    try {
      await files.unbind(request.params.projectId);
      return reply.code(204).send();
    } catch (error) {
      return workspaceFail(reply, error);
    }
  });

  // The linked folder as Git sees it now: read only (02-UX-Spec §4).
  app.get<ProjectParams>(
    '/api/v1/projects/:projectId/workspace/changes',
    async (request, reply) => {
      try {
        return await files.folderChanges(request.params.projectId);
      } catch (error) {
        return workspaceFail(reply, error);
      }
    },
  );
  app.get<ProjectParams & { Querystring: { path?: string } }>(
    '/api/v1/projects/:projectId/workspace/changes/file',
    async (request, reply) => {
      if (!request.query.path) return fail(reply, 'SCHEMA_INVALID', 'path is required');
      try {
        return await files.folderFileVersions(request.params.projectId, request.query.path);
      } catch (error) {
        return workspaceFail(reply, error);
      }
    },
  );
  app.get<SessionParams>('/api/v1/sessions/:sessionId/worktree', async (request, reply) => {
    if (!(await sessionOr404(reply, request.params.sessionId))) return reply;
    return { worktree: files.worktreeView(request.params.sessionId) };
  });
  app.post<SessionParams>('/api/v1/sessions/:sessionId/worktree', async (request, reply) => {
    const session = await sessionOr404(reply, request.params.sessionId);
    if (!session) return reply;
    try {
      return reply
        .code(201)
        .send({ worktree: await files.createWorktree(session.sessionId, session.projectId) });
    } catch (error) {
      return workspaceFail(reply, error);
    }
  });
  app.get<SessionParams>('/api/v1/sessions/:sessionId/worktree/removal', async (request, reply) => {
    if (!(await sessionOr404(reply, request.params.sessionId))) return reply;
    try {
      return await files.removalPlan(request.params.sessionId);
    } catch (error) {
      return workspaceFail(reply, error);
    }
  });
  app.delete<SessionParams>('/api/v1/sessions/:sessionId/worktree', async (request, reply) => {
    const query = z
      .strictObject({ generation: z.coerce.number().int().min(1).optional() })
      .safeParse(request.query);
    if (!query.success)
      return fail(reply, 'SCHEMA_INVALID', 'generation must be a copy generation');
    if (!(await sessionOr404(reply, request.params.sessionId))) return reply;
    try {
      await files.removeWorktree(request.params.sessionId, query.data.generation);
      return reply.code(204).send();
    } catch (error) {
      return workspaceFail(reply, error);
    }
  });
  const documentFail = (reply: FastifyReply, error: unknown) => {
    if (error instanceof WorkspaceError || error instanceof ToolRefusal)
      return fail(reply, error.code, error.message);
    return fail(reply, 'STORAGE_UNAVAILABLE', 'the document operation failed');
  };
  app.get<SessionParams>(
    '/api/v1/sessions/:sessionId/worktree/document',
    async (request, reply) => {
      const query = z.strictObject({ path: z.string().min(1).max(4096) }).safeParse(request.query);
      if (!query.success) return fail(reply, 'SCHEMA_INVALID', 'path is required');
      if (!(await sessionOr404(reply, request.params.sessionId))) return reply;
      try {
        return await files.readDocument(request.params.sessionId, query.data.path);
      } catch (error) {
        return documentFail(reply, error);
      }
    },
  );
  app.post<SessionParams>(
    '/api/v1/sessions/:sessionId/worktree/documents',
    // One MiB of UTF-8 text may require six MiB after JSON escaping, plus the envelope.
    { bodyLimit: 7 * 1024 * 1024 },
    async (request, reply) => {
      const command = DocumentCommand.safeParse(request.body);
      if (!command.success) return fail(reply, 'SCHEMA_INVALID', 'invalid document command');
      if (command.data.target.sessionId !== request.params.sessionId)
        return fail(reply, 'SCHEMA_INVALID', 'document target does not match the session');
      if (!(await sessionOr404(reply, request.params.sessionId))) return reply;
      try {
        return await files.changeDocument(request.params.sessionId, command.data);
      } catch (error) {
        return documentFail(reply, error);
      }
    },
  );
  app.get<{ Params: { sessionId: string; operationId: string } }>(
    '/api/v1/sessions/:sessionId/worktree/document-operations/:operationId',
    async (request, reply) => {
      if (!(await sessionOr404(reply, request.params.sessionId))) return reply;
      try {
        return files.documentOperation(request.params.sessionId, request.params.operationId);
      } catch (error) {
        return documentFail(reply, error);
      }
    },
  );
  // CR-046 P15: development tasks a person starts from the copy's package scripts.
  app.get<{ Params: { sessionId: string } }>(
    '/api/v1/sessions/:sessionId/worktree/tasks',
    async (request, reply) => {
      if (!(await sessionOr404(reply, request.params.sessionId))) return reply;
      try {
        const sessionId = request.params.sessionId;
        return {
          candidates: await files.taskCandidates(sessionId),
          tasks: await files.tasks(sessionId),
        };
      } catch (error) {
        return gitFail(reply, error);
      }
    },
  );
  app.post<{ Params: { sessionId: string } }>(
    '/api/v1/sessions/:sessionId/worktree/tasks',
    async (request, reply) => {
      const input = TaskStart.safeParse(request.body);
      if (!input.success) return fail(reply, 'SCHEMA_INVALID', 'invalid task');
      if (input.data.target.sessionId !== request.params.sessionId)
        return fail(reply, 'SCHEMA_INVALID', 'task target does not match the session');
      if (!(await sessionOr404(reply, request.params.sessionId))) return reply;
      try {
        return await files.startTask(request.params.sessionId, input.data);
      } catch (error) {
        return gitFail(reply, error);
      }
    },
  );
  app.get<{ Params: { sessionId: string; operationId: string }; Querystring: { offset?: string } }>(
    '/api/v1/sessions/:sessionId/worktree/tasks/:operationId/output',
    async (request, reply) => {
      if (!(await sessionOr404(reply, request.params.sessionId))) return reply;
      const offset = Number(request.query.offset ?? 0);
      if (!Number.isSafeInteger(offset) || offset < 0)
        return fail(reply, 'SCHEMA_INVALID', 'invalid output offset');
      try {
        return (
          files.taskOutput(request.params.sessionId, request.params.operationId, offset) ?? {
            text: '',
            nextOffset: offset,
            bytes: 0,
            truncated: false,
          }
        );
      } catch (error) {
        return gitFail(reply, error);
      }
    },
  );
  app.post<{ Params: { sessionId: string; operationId: string } }>(
    '/api/v1/sessions/:sessionId/worktree/tasks/:operationId/stop',
    async (request, reply) => {
      if (!(await sessionOr404(reply, request.params.sessionId))) return reply;
      try {
        return await files.stopTask(request.params.sessionId, request.params.operationId);
      } catch (error) {
        return gitFail(reply, error);
      }
    },
  );
  // CR-046 P13: stage, unstage and commit in a session's managed copy, with a receipt.
  app.post<{ Params: { sessionId: string } }>(
    '/api/v1/sessions/:sessionId/worktree/git/operations',
    async (request, reply) => {
      const command = GitWriteCommand.safeParse(request.body);
      if (!command.success) return fail(reply, 'SCHEMA_INVALID', 'invalid Git command');
      if (command.data.target.sessionId !== request.params.sessionId)
        return fail(reply, 'SCHEMA_INVALID', 'Git target does not match the session');
      if (!(await sessionOr404(reply, request.params.sessionId))) return reply;
      try {
        return await files.changeGit(request.params.sessionId, command.data);
      } catch (error) {
        return gitFail(reply, error);
      }
    },
  );
  app.get<{ Params: { sessionId: string; operationId: string } }>(
    '/api/v1/sessions/:sessionId/worktree/git/operations/:operationId',
    async (request, reply) => {
      if (!(await sessionOr404(reply, request.params.sessionId))) return reply;
      try {
        return await files.resolveGitOperation(
          request.params.sessionId,
          request.params.operationId,
        );
      } catch (error) {
        return gitFail(reply, error);
      }
    },
  );
  app.post<{ Params: { sessionId: string; operationId: string } }>(
    '/api/v1/sessions/:sessionId/worktree/git/operations/:operationId/cancel',
    async (request, reply) => {
      if (!(await sessionOr404(reply, request.params.sessionId))) return reply;
      try {
        return files.cancelGitOperation(request.params.sessionId, request.params.operationId);
      } catch (error) {
        return gitFail(reply, error);
      }
    },
  );
  const ScopeQuery = z.object({
    scope: z.enum(['session', 'review', 'run']).default('session'),
    runId: Identifier.optional(),
  });
  const scopeOf = (query: z.infer<typeof ScopeQuery>): ChangeScope | null =>
    query.scope === 'run'
      ? query.runId
        ? { kind: 'run', runId: query.runId }
        : null
      : { kind: query.scope };
  app.get<SessionParams>('/api/v1/sessions/:sessionId/changes', async (request, reply) => {
    const query = ScopeQuery.safeParse(request.query);
    const scope = query.success ? scopeOf(query.data) : null;
    if (!scope) return fail(reply, 'SCHEMA_INVALID', 'scope=session|review|run (with runId)');
    try {
      return await files.changes(request.params.sessionId, scope, runEnded);
    } catch (error) {
      return workspaceFail(reply, error);
    }
  });
  app.get<SessionParams>('/api/v1/sessions/:sessionId/changes/file', async (request, reply) => {
    const query = z
      .object({
        from: z.string().regex(/^[0-9a-f]{40,64}$/),
        to: z.string().regex(/^[0-9a-f]{40,64}$/),
        path: z.string().min(1).max(500),
      })
      .safeParse(request.query);
    if (!query.success) return fail(reply, 'SCHEMA_INVALID', 'from, to and path are required');
    try {
      return await files.fileVersions(
        request.params.sessionId,
        query.data.from,
        query.data.to,
        query.data.path,
      );
    } catch (error) {
      return workspaceFail(reply, error);
    }
  });
  app.post<SessionParams>('/api/v1/sessions/:sessionId/reviewed', async (request, reply) => {
    try {
      await files.markReviewed(request.params.sessionId);
      return reply.code(204).send();
    } catch (error) {
      return workspaceFail(reply, error);
    }
  });
  app.get<SessionParams>('/api/v1/sessions/:sessionId/verifications', async (request, reply) => {
    try {
      const tree = await files.currentTree(request.params.sessionId);
      return files.verifications(request.params.sessionId, tree);
    } catch (error) {
      return workspaceFail(reply, error);
    }
  });
  app.post<SessionParams>('/api/v1/sessions/:sessionId/verifications', async (request, reply) => {
    const body = parse(z.strictObject({ commandId: Identifier }), request, reply);
    if (!body) return reply;
    const session = await sessionOr404(reply, request.params.sessionId);
    if (!session) return reply;
    try {
      const id = await files.verify(session.sessionId, session.projectId, body.commandId);
      return reply.code(202).send({ verificationId: id });
    } catch (error) {
      return workspaceFail(reply, error);
    }
  });
  app.post<{ Params: { sessionId: string; verificationId: string } }>(
    '/api/v1/sessions/:sessionId/verifications/:verificationId/cancel',
    async (request, reply) => {
      if (!(await sessionOr404(reply, request.params.sessionId))) return reply;
      try {
        files.cancelVerification(request.params.sessionId, request.params.verificationId);
        return reply.code(204).send();
      } catch (error) {
        return workspaceFail(reply, error);
      }
    },
  );
  app.get<SessionParams>('/api/v1/sessions/:sessionId/run-snapshots', async (request) =>
    files.runSnapshots(request.params.sessionId),
  );
  app.get<SessionParams>('/api/v1/sessions/:sessionId/file-operations', async (request) =>
    files.fileOperations(request.params.sessionId),
  );

  app.get<SessionParams>('/api/v1/sessions/:sessionId/lsp-proposals', async (request, reply) => {
    if (!(await sessionOr404(reply, request.params.sessionId))) return reply;
    try {
      return files.lspProposals(request.params.sessionId);
    } catch (error) {
      return workspaceFail(reply, error);
    }
  });
  type ProposalParams = { Params: { sessionId: string; proposalId: string } };
  app.get<ProposalParams>(
    '/api/v1/sessions/:sessionId/lsp-proposals/:proposalId',
    async (request, reply) => {
      if (!(await sessionOr404(reply, request.params.sessionId))) return reply;
      try {
        return files.lspProposal(
          request.params.sessionId,
          Identifier.parse(request.params.proposalId),
        );
      } catch (error) {
        return workspaceFail(reply, error);
      }
    },
  );
  for (const action of ['apply', 'dismiss'] as const)
    app.post<ProposalParams>(
      `/api/v1/sessions/:sessionId/lsp-proposals/:proposalId/${action}`,
      async (request, reply) => {
        if (!(await sessionOr404(reply, request.params.sessionId))) return reply;
        const body = z.strictObject({ hash: ContentHash }).safeParse(request.body);
        if (!body.success)
          return fail(reply, 'SCHEMA_INVALID', 'the reviewed proposal hash is required');
        try {
          const id = Identifier.parse(request.params.proposalId);
          return action === 'apply'
            ? await files.applyLspProposal(request.params.sessionId, id, body.data.hash)
            : files.dismissLspProposal(request.params.sessionId, id, body.data.hash);
        } catch (error) {
          return workspaceFail(reply, error);
        }
      },
    );

  // ── Review comments, decisions, applying and reverting (CR-013) ──────────────
  const Tree = z.string().regex(/^[0-9a-f]{40,64}$/);
  const guarded =
    <T>(
      work: (
        request: FastifyRequest<{ Params: { sessionId: string } }>,
        reply: FastifyReply,
      ) => Promise<T>,
    ) =>
    async (request: FastifyRequest<{ Params: { sessionId: string } }>, reply: FastifyReply) => {
      try {
        return await work(request, reply);
      } catch (error) {
        return workspaceFail(reply, error);
      }
    };
  app.get<SessionParams>(
    '/api/v1/sessions/:sessionId/comments',
    guarded(async (request) => review.comments(request.params.sessionId)),
  );
  app.post<SessionParams>(
    '/api/v1/sessions/:sessionId/comments',
    guarded(async (request, reply) => {
      const body = parse(
        z.strictObject({
          from: Tree,
          to: Tree,
          path: z.string().min(1).max(500),
          side: z.enum(['before', 'after']),
          startLine: z.int().min(1),
          endLine: z.int().min(1),
          quote: z.string().max(10_000),
          body: z.string().min(1).max(10_000),
        }),
        request,
        reply,
      );
      if (!body) return reply;
      return reply.code(201).send(review.addComment(request.params.sessionId, body));
    }),
  );
  app.patch<{ Params: { sessionId: string; commentId: string } }>(
    '/api/v1/sessions/:sessionId/comments/:commentId',
    async (request, reply) => {
      const body = parse(
        z.strictObject({ state: z.enum(['addressed', 'obsolete', 'draft', 'deleted']) }),
        request,
        reply,
      );
      if (!body) return reply;
      try {
        review.setCommentState(request.params.sessionId, request.params.commentId, body.state);
        return reply.code(204).send();
      } catch (error) {
        return workspaceFail(reply, error);
      }
    },
  );
  app.post<SessionParams>(
    '/api/v1/sessions/:sessionId/feedback/text',
    guarded(async (request, reply) => {
      const body = parse(
        z.strictObject({ commentIds: z.array(Identifier).min(1).max(100) }),
        request,
        reply,
      );
      if (!body) return reply;
      return { text: review.batchText(request.params.sessionId, body.commentIds) };
    }),
  );
  app.post<SessionParams>(
    '/api/v1/sessions/:sessionId/feedback',
    guarded(async (request, reply) => {
      const body = parse(
        z.strictObject({
          commentIds: z.array(Identifier).min(1).max(100),
          intent: z.enum(['steer', 'next']),
          runId: Identifier.nullable(),
          executionId: Identifier.nullable(),
          text: z.string().min(1).max(20_000),
          sent: z.boolean(),
          detail: z.string().max(2000).nullable(),
        }),
        request,
        reply,
      );
      if (!body) return reply;
      return reply.code(201).send({ batchId: review.recordBatch(request.params.sessionId, body) });
    }),
  );
  app.get<SessionParams>(
    '/api/v1/sessions/:sessionId/decisions',
    guarded(async (request) => review.decisions(request.params.sessionId)),
  );
  app.post<SessionParams>(
    '/api/v1/sessions/:sessionId/decisions',
    guarded(async (request, reply) => {
      const body = parse(
        z.strictObject({
          from: Tree,
          to: Tree,
          decision: z.enum(['approved', 'changes_requested']),
          note: z.string().max(2000),
        }),
        request,
        reply,
      );
      if (!body) return reply;
      return reply.code(201).send({ decisionId: review.decide(request.params.sessionId, body) });
    }),
  );
  app.get<SessionParams & { Querystring: { decisionId?: string } }>(
    '/api/v1/sessions/:sessionId/integration-plan',
    async (request, reply) => {
      if (!request.query.decisionId) return fail(reply, 'SCHEMA_INVALID', 'decisionId is required');
      try {
        return await review.plan(request.params.sessionId, request.query.decisionId);
      } catch (error) {
        return workspaceFail(reply, error);
      }
    },
  );
  app.get<SessionParams>(
    '/api/v1/sessions/:sessionId/integrations',
    guarded(async (request) => review.integrations(request.params.sessionId)),
  );
  app.post<SessionParams>(
    '/api/v1/sessions/:sessionId/integrations',
    guarded(async (request, reply) => {
      const body = parse(z.strictObject({ decisionId: Identifier }), request, reply);
      if (!body) return reply;
      return reply
        .code(201)
        .send(
          await coordinator.withFileRestore(
            () => review.integrate(request.params.sessionId, body.decisionId),
            request.params.sessionId,
          ),
        );
    }),
  );
  app.post<{ Params: { sessionId: string; integrationId: string } }>(
    '/api/v1/sessions/:sessionId/integrations/:integrationId/revert',
    async (request, reply) => {
      try {
        return await coordinator.withFileRestore(
          () => review.revert(request.params.sessionId, request.params.integrationId),
          request.params.sessionId,
        );
      } catch (error) {
        return workspaceFail(reply, error);
      }
    },
  );
  app.get<ProjectParams>('/api/v1/projects/:projectId/inbox', async (request) => {
    const sessions = await corrals.listSessions(request.params.projectId);
    return review.inbox(
      sessions.filter((x) => !x.archivedAt),
      coordinator.listRuns(),
    );
  });

  // ── Work sessions (CR-011) ───────────────────────────────────────────────────
  const sessionReply = (reply: FastifyReply, result: SessionResult, created: boolean) => {
    if (result.ok) return reply.code(created ? 201 : 200).send(result);
    const code: ErrorCode =
      result.error === 'not_found'
        ? 'TARGET_NOT_FOUND'
        : result.error === 'revision_conflict'
          ? 'REVISION_CONFLICT'
          : result.error === 'invalid'
            ? 'SCHEMA_INVALID'
            : 'STORAGE_UNAVAILABLE';
    return fail(reply, code, result.message);
  };
  app.get<{ Querystring: { projectId?: string } }>('/api/v1/sessions', async (request, reply) => {
    const projectId = request.query.projectId;
    if (!projectId) return fail(reply, 'SCHEMA_INVALID', 'projectId is required');
    return corrals.listSessions(projectId);
  });
  app.post('/api/v1/sessions', async (request, reply) => {
    const body = parse(CreateSession, request, reply);
    if (!body) return reply;
    return sessionReply(reply, await corrals.createSession(body), true);
  });
  app.get<{ Params: { sessionId: string } }>(
    '/api/v1/sessions/:sessionId',
    async (request, reply) => {
      const session = await corrals.getSession(request.params.sessionId);
      return session ?? fail(reply, 'TARGET_NOT_FOUND', 'no such session');
    },
  );
  app.patch<{ Params: { sessionId: string } }>(
    '/api/v1/sessions/:sessionId',
    async (request, reply) => {
      const body = parse(UpdateSession, request, reply);
      if (!body) return reply;
      return sessionReply(
        reply,
        await corrals.updateSession(request.params.sessionId, body),
        false,
      );
    },
  );
  app.post<{ Params: { sessionId: string } }>(
    '/api/v1/sessions/:sessionId/entries',
    async (request, reply) => {
      const body = parse(NewEntry, request, reply);
      if (!body) return reply;
      return sessionReply(
        reply,
        await corrals.addSessionEntry(request.params.sessionId, body),
        true,
      );
    },
  );
  app.patch<{ Params: { sessionId: string; entryId: string } }>(
    '/api/v1/sessions/:sessionId/entries/:entryId',
    async (request, reply) => {
      const body = parse(EntryChange, request, reply);
      if (!body) return reply;
      return sessionReply(
        reply,
        await corrals.updateSessionEntry(request.params.sessionId, request.params.entryId, body),
        false,
      );
    },
  );

  app.post('/api/v1/runs/branch/preview', async (request, reply) => {
    const body = parse(MessageBranchPoint, request, reply);
    if (!body) return reply;
    try {
      return coordinator.branchPreview(body);
    } catch (error) {
      return workspaceFail(reply, error);
    }
  });
  app.post('/api/v1/runs/branch', async (request, reply) => {
    const body = parse(MessageBranchRequest, request, reply);
    if (!body) return reply;
    const resend = coordinator.hasStartCommand(body.commandId);
    const result = await coordinator.branchRun(body, (plan) =>
      prepareBranchSession(db, clock, files, images, body, plan),
    );
    const sessionId = result.runId ? store.getRun(result.runId)?.sessionId : null;
    if (result.runId && sessionId) {
      if (!resend) {
        const tree = coordinator.getRunSnapshot(result.runId)?.branchedFrom?.tree;
        if (tree) await trackRunFiles(result.runId, sessionId, tree);
      }
      const saved = await corrals.addSessionEntry(sessionId, {
        intent: 'next',
        state: 'started',
        text: 'Continue from the selected message',
        runId: result.runId,
        commandId: body.commandId,
      });
      if (!saved.ok)
        return fail(
          reply,
          'STORAGE_UNAVAILABLE',
          'the branch started but its entry could not be saved; retry this request',
        );
    }
    return reply
      .code(result.receipt.error ? STATUS[result.receipt.error.code] : resend ? 200 : 201)
      .send({ ...result, sessionId: sessionId ?? null });
  });
  app.get<{ Params: { runId: string; artifactId: string } }>(
    '/api/v1/runs/:runId/artifacts/:artifactId/branches',
    async (request) =>
      db
        .prepare(
          "SELECT b.session_id AS sessionId,c.run_id AS runId,s.title FROM message_branches b JOIN work_sessions s ON s.id=b.session_id LEFT JOIN commands c ON c.scope='*' AND c.command_id=b.command_id WHERE b.source_run_id=? AND b.artifact_id=? ORDER BY b.created_at",
        )
        .all(request.params.runId, request.params.artifactId),
  );

  const sessionSearch = new SessionSearch(db);
  app.post('/api/v1/sessions/search', async (request, reply) => {
    const body = parse(SessionSearchRequest, request, reply);
    if (!body) return reply;
    return reply.header('cache-control', 'private, no-store').send(sessionSearch.search(body));
  });
  app.post('/api/v1/sessions/search/rebuild', async (_request, reply) => {
    sessionSearch.rebuild();
    return reply.code(204).send();
  });

  type RunParams = { Params: { runId: string } };
  app.get<RunParams>('/api/v1/runs/:runId/runtime-checkpoints', async (request, reply) => {
    try {
      return await coordinator.runtimeCheckpoints(request.params.runId);
    } catch {
      return fail(reply, 'TARGET_NOT_FOUND', 'runtime checkpoints unavailable');
    }
  });
  app.post<RunParams>('/api/v1/runs/:runId/resume-runtime', async (request, reply) => {
    const body = parse(ResumeRuntimeRequest.omit({ sourceRunId: true }), request, reply);
    if (!body) return reply;
    const source = store.getRun(request.params.runId);
    const resend = coordinator.hasStartCommand(body.commandId);
    const tree = source?.sessionId && !resend ? await files.currentTree(source.sessionId) : null;
    const result = await coordinator.resumeRuntime({ ...body, sourceRunId: request.params.runId });
    if (result.runId && source?.sessionId) {
      if (tree) await trackRunFiles(result.runId, source.sessionId, tree);
      const saved = await corrals.addSessionEntry(source.sessionId, {
        intent: 'next',
        state: 'started',
        text: 'Continue from a runtime checkpoint',
        runId: result.runId,
        commandId: body.commandId,
      });
      if (!saved.ok)
        return fail(
          reply,
          'STORAGE_UNAVAILABLE',
          'the new Run started but its session entry could not be saved; retry this request',
        );
    }
    return reply
      .code(result.receipt.error ? STATUS[result.receipt.error.code] : resend ? 200 : 201)
      .send(result);
  });
  app.get('/api/v1/image-profiles', async () => {
    const profiles = imageProfiles.list();
    return {
      profiles,
      statuses: Object.fromEntries(
        profiles.map((profile) => [
          profile.profileId,
          {
            available: Boolean(imageProfiles.resolve(profile.profileId)),
            reason: imageProfiles.resolve(profile.profileId)
              ? null
              : 'Requires a configured OpenAI or compatible model profile with an API key; subscription sign-ins are unsupported.',
          },
        ]),
      ),
    };
  });
  app.put<{ Params: { profileId: string } }>(
    '/api/v1/image-profiles/:profileId',
    async (request, reply) => {
      if ((request.body as { profileId?: unknown })?.profileId !== request.params.profileId)
        return fail(reply, 'SCHEMA_INVALID', 'image profile identity differs from the address');
      try {
        return { profile: imageProfiles.put(request.body) };
      } catch {
        return fail(reply, 'SCHEMA_INVALID', 'invalid image generation profile');
      }
    },
  );
  app.delete<{ Params: { profileId: string } }>(
    '/api/v1/image-profiles/:profileId',
    async (request) => {
      imageProfiles.remove(request.params.profileId);
      return { ok: true };
    },
  );
  app.get<{ Params: { runId: string; versionId: string }; Querystring: { download?: string } }>(
    '/api/v1/runs/:runId/artifact-versions/:versionId/media',
    async (request, reply) => {
      const { runId, versionId } = request.params;
      const artifact = coordinator.findSnapshot(runId)?.projection.artifacts[versionId];
      if (!artifact?.media) return fail(reply, 'TARGET_NOT_FOUND', 'no generated image version');
      const stored = imageGeneration.read(runId, versionId);
      if (!stored || canonicalJson(stored.media) !== canonicalJson(artifact.media))
        return fail(
          reply,
          'STORAGE_UNAVAILABLE',
          'generated image bytes are unavailable or changed',
        );
      return reply
        .type(stored.media.mime)
        .header('Cache-Control', 'no-store')
        .header(
          'Content-Disposition',
          `${request.query.download === '1' ? 'attachment' : 'inline'}; filename="image.png"`,
        )
        .header('X-Content-Type-Options', 'nosniff')
        .send(stored.bytes);
    },
  );
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
          coordinator
            .getRunSnapshot(runId)
            ?.definition.input.images?.some((image) => image.imageId === versionId) ||
          Object.values(projection.modelCalls).some((call) => call.responseRef === versionId) ||
          Object.values(projection.toolCalls).some((call) => call.resultRef === versionId) ||
          projection.currentCriteriaVersionId === versionId ||
          Object.values(projection.patches).some(
            (patch) =>
              patch.kind === 'criteria' &&
              (patch.before.criteriaVersionId === versionId ||
                patch.after.criteriaVersionId === versionId),
          ) ||
          coordinator.getRunSnapshot(runId)?.criteriaVersionId === versionId ||
          store
            .readEvents(runId, 0)
            .some(
              (event) =>
                ((event.type === 'work_plan.updated' ||
                  event.type === 'user_input.requested' ||
                  event.type === 'extension.ui_requested' ||
                  event.type === 'extension.ui_notified') &&
                  event.payload.bodyRef === versionId) ||
                ((event.type === 'user_input.answered' || event.type === 'extension.ui_answered') &&
                  event.payload.answerRef === versionId) ||
                (event.type === 'approval.requested' && event.payload.tool?.bodyRef === versionId),
            ));
      const text = known ? coordinator.getArtifactText(runId, versionId) : null;
      return text === null ? fail(reply, 'TARGET_NOT_FOUND', 'no such version') : { text };
    },
  );
  // An HTML result as its own sandboxed document (CR-009). Only artifact versions qualify,
  // and only whole HTML documents; everything else stays text.
  app.get<{ Params: { runId: string; versionId: string } }>(
    PREVIEW_ROUTE,
    async (request, reply) => {
      const { runId, versionId } = request.params;
      const known = coordinator.findSnapshot(runId)?.projection.artifacts[versionId];
      const text = known ? coordinator.getArtifactText(runId, versionId) : null;
      if (text === null || !/^\s*(?:<!doctype\s+html\b|<html\b)/i.test(text)) {
        return fail(reply, 'TARGET_NOT_FOUND', 'no HTML document for this version');
      }
      return reply.type('text/html; charset=utf-8').send(text);
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
    desktopPreviewTarget: (sessionId, leaseId) => previews.desktopTarget(sessionId, leaseId),
    desktopStorageVersion: () => Number(db.pragma('user_version', { simple: true })),
    async closeIfIdle(backupForUpdate = false) {
      if (
        restartClosing ||
        mutations.size ||
        autoRequests.size ||
        !coordinator.admitting ||
        files.hasPendingProcesses() ||
        hasOwnedProcessReservations() ||
        coordinator.listRuns().some((run) => !TERMINAL_RUN_STATUSES.has(run.status)) ||
        !schedules.pauseIfIdle()
      )
        return false;
      // No await may separate the idle checks and the admission gate.
      restartClosing = true;
      if (backupForUpdate) {
        try {
          const destination = join(
            workspace.root,
            '.corral',
            'update-backups',
            crypto.randomUUID(),
          );
          mkdirSync(destination, { recursive: true, mode: 0o700 });
          await db.backup(join(destination, 'corral.db'));
          const config = join(workspace.root, '.corral', 'config.json');
          if (existsSync(config))
            writeFileSync(join(destination, 'config.json'), readFileSync(config), { mode: 0o600 });
          writeFileSync(
            join(destination, 'snapshot.json'),
            JSON.stringify({
              createdAt: clock.nowIso(),
              workspaceId: workspace.id,
              wireSchemaVersion: SCHEMA_VERSION,
              storageVersion: Number(db.pragma('user_version', { simple: true })),
            }),
            { mode: 0o600 },
          );
        } catch (error) {
          restartClosing = false;
          schedules.resumeAfterIdle();
          throw error;
        }
      }
      for (const close of [...streams]) close();
      await closeResources();
      return true;
    },
    async prepareEvaluation(target) {
      const created = await corrals.createSession({
        projectId: target.projectId,
        title: 'Evaluation',
      });
      if (!created.ok) throw new Error(created.message);
      const copy = await files.createWorktree(
        created.session.sessionId,
        target.projectId,
        target.baseCommit,
      );
      return { sessionId: created.session.sessionId, baseCommit: copy.baseCommit };
    },
    async close() {
      for (const close of [...streams]) close();
      await closeResources();
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
