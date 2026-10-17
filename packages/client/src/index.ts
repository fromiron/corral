import {
  type CorralDefinition,
  type CreateRunRequest,
  type ErrorCode,
  type Receipt,
  type RunCommand,
  RunEvent,
  type StartRunRequest,
  type StreamFrame,
  type TeamPlan,
} from '@corral/contracts';
import type {
  CorralRecord,
  CorralRepository,
  CorralSummary,
  NewSessionEntry,
  ProjectChange,
  ProjectResult,
  ProjectSummary,
  RunArchive,
  RunProjection,
  RunSummary,
  RuntimeTransport,
  SaveRequest,
  SaveResult,
  SessionChange,
  SessionEntryState,
  SessionResult,
  StartRunResult,
  TransportHandlers,
  WorkSession,
} from '@corral/core';

// Studio's side of the local server (C-015, ADR-016). Same contracts as the in-process
// runtime: the transport runs the shared RuntimeTransport suite against a real server.
// Requests carry the session cookie (same origin); nothing here holds a credential.

export interface HttpOptions {
  /** Origin of the local server; '' in the browser (same origin). */
  baseUrl: string;
  /** Injected for tests and non-browser callers. */
  fetch?: typeof fetch;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode | 'UNKNOWN';

  constructor(status: number, code: ErrorCode | 'UNKNOWN', message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

class Http {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private csrfToken: string | null = null;

  constructor(options: HttpOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  }

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const method = (init.method ?? 'GET').toUpperCase();
    const needsCsrf = path !== '/session' && !['GET', 'HEAD', 'OPTIONS'].includes(method);
    if (needsCsrf && !this.csrfToken) {
      const session = await this.request('/session');
      if (!session.ok) throw await apiError(session);
      const body = (await session.json()) as { csrfToken?: string };
      if (!body.csrfToken) throw new ApiError(403, 'SESSION_INVALID', 'session has no CSRF token');
      this.csrfToken = body.csrfToken;
    }
    const headers = new Headers(init.headers);
    if (needsCsrf && this.csrfToken) headers.set('x-corral-csrf', this.csrfToken);
    if (init.body !== undefined) headers.set('content-type', 'application/json');
    headers.set('accept', headers.get('accept') ?? 'application/json');
    return this.fetchImpl(`${this.baseUrl}/api/v1${path}`, {
      ...init,
      headers,
      credentials: 'same-origin',
    });
  }

  async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.request(path, init);
    if (!response.ok) throw await apiError(response);
    return (await response.json()) as T;
  }
}

async function apiError(response: Response): Promise<ApiError> {
  try {
    const body = (await response.json()) as { error?: { code?: ErrorCode; message?: string } };
    return new ApiError(
      response.status,
      body.error?.code ?? 'UNKNOWN',
      body.error?.message ?? response.statusText,
    );
  } catch {
    return new ApiError(response.status, 'UNKNOWN', response.statusText);
  }
}

export interface ServerHealth {
  ok: true;
  schemaVersion: string;
  version: string;
  backendSessionId: string;
  /** Whether this server can run real models (signed in or not). */
  live: boolean;
}

/** The local server, if this page was served by one; null for the in-browser runtime. */
export async function probeServer(options: HttpOptions): Promise<ServerHealth | null> {
  try {
    const response = await new Http(options).request('/health');
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
      return null;
    }
    const body = (await response.json()) as Partial<ServerHealth>;
    return body.ok === true ? (body as ServerHealth) : null;
  } catch {
    return null;
  }
}

/** Trades the one-time bootstrap token for a session cookie. */
export async function openSession(options: HttpOptions, token: string): Promise<boolean> {
  const response = await new Http(options).request('/session', {
    method: 'POST',
    body: JSON.stringify({ token }),
  });
  return response.status === 204;
}

/** True when the session cookie is still accepted (a server restart ends sessions). */
export async function hasSession(options: HttpOptions): Promise<boolean> {
  const response = await new Http(options).request('/session');
  return response.ok;
}

// ── runtime transport ────────────────────────────────────────────────────────

const RECONNECT_DELAYS_MS = [250, 500, 1000, 2000, 4000];

export class HttpSseTransport implements RuntimeTransport {
  private readonly http: Http;

  constructor(options: HttpOptions) {
    this.http = new Http(options);
  }

  async startRun(request: StartRunRequest | CreateRunRequest): Promise<StartRunResult> {
    if ('definition' in request) {
      return {
        runId: null,
        receipt: refused(request.commandId, 'SCHEMA_INVALID', 'save the Corral first'),
      };
    }
    const response = await this.http.request('/runs', {
      method: 'POST',
      body: JSON.stringify(request),
    });
    const body = (await response.json()) as Partial<StartRunResult> & { error?: ApiError };
    if (!body.receipt) throw await apiErrorFrom(response, body);
    return { runId: body.runId ?? null, receipt: body.receipt };
  }

  async sendCommand(command: RunCommand): Promise<Receipt> {
    const response = await this.http.request(
      `/runs/${encodeURIComponent(command.runId)}/commands`,
      {
        method: 'POST',
        body: JSON.stringify(command),
      },
    );
    const body = (await response.json()) as Receipt & { error?: unknown };
    if (!('status' in body)) throw await apiErrorFrom(response, body);
    return body;
  }

  async getReceipt(runId: string, commandId: string): Promise<Receipt | null> {
    const response = await this.http.request(
      `/runs/${encodeURIComponent(runId)}/commands/${encodeURIComponent(commandId)}`,
    );
    if (response.status === 404) return null;
    if (!response.ok) throw await apiError(response);
    return (await response.json()) as Receipt;
  }

  getSnapshot(runId: string): Promise<{ projection: RunProjection; seq: number }> {
    return this.http.json(`/runs/${encodeURIComponent(runId)}/snapshot`);
  }

  /** A question about a result as its own run in a session (CR-011). */
  async startExplain(request: {
    commandId: string;
    sessionId: string;
    question: string;
    modelProfile: string;
    mode: 'mock' | 'live';
    startFrom?: { runId: string; artifactVersionId: string };
  }): Promise<StartRunResult> {
    const response = await this.http.request('/runs/explain', {
      method: 'POST',
      body: JSON.stringify(request),
    });
    const body = (await response.json()) as Partial<StartRunResult> & { error?: ApiError };
    if (!body.receipt) throw await apiErrorFrom(response, body);
    return { runId: body.runId ?? null, receipt: body.receipt };
  }

  /** Where an HTML result opens as a sandboxed document (CR-009); framed by Studio only. */
  previewUrl(runId: string, artifactVersionId: string): string {
    return `${this.http.baseUrl}/api/v1/runs/${encodeURIComponent(runId)}/artifact-versions/${encodeURIComponent(artifactVersionId)}/preview`;
  }

  async getArtifactText(runId: string, artifactVersionId: string): Promise<string | null> {
    const response = await this.http.request(
      `/runs/${encodeURIComponent(runId)}/artifact-versions/${encodeURIComponent(artifactVersionId)}`,
    );
    if (response.status === 404) return null;
    if (!response.ok) throw await apiError(response);
    return ((await response.json()) as { text: string }).text;
  }

  listRuns(): Promise<RunSummary[]> {
    return this.http.json('/runs');
  }

  async getRunDefinition(runId: string): Promise<CorralDefinition | null> {
    const response = await this.http.request(`/runs/${encodeURIComponent(runId)}`);
    if (response.status === 404) return null;
    if (!response.ok) throw await apiError(response);
    return ((await response.json()) as { definition: CorralDefinition }).definition;
  }

  exportRun(runId: string, options: { privateTranscript?: boolean } = {}): Promise<RunArchive> {
    return this.http.json(`/runs/${encodeURIComponent(runId)}/export`, {
      method: 'POST',
      body: JSON.stringify(options),
    });
  }

  /**
   * SSE over fetch, so the cursor travels as Last-Event-ID on every reconnect. Events arrive
   * once and in order: duplicates are dropped and gaps reconnect at the committed cursor.
   */
  subscribe(runId: string, afterSeq: number, handlers: TransportHandlers): () => void {
    const controller = new AbortController();
    let lastSeq = afterSeq;
    let stopped = false;
    const stop = (error?: unknown) => {
      if (stopped) return;
      stopped = true;
      controller.abort();
      if (error !== undefined) handlers.onError?.(error);
    };

    const deliver = (event: RunEvent) => {
      if (event.runId !== runId) {
        stop(new Error('event belongs to a different run'));
        return;
      }
      if (event.runSeq <= lastSeq) return;
      if (event.runSeq !== lastSeq + 1) {
        throw new Error(`event gap: expected runSeq ${lastSeq + 1}, received ${event.runSeq}`);
      }
      lastSeq = event.runSeq;
      try {
        handlers.onEvent(event);
      } catch (error) {
        stop(error);
      }
    };

    const connect = async (attempt: number): Promise<void> => {
      try {
        const response = await this.http.request(
          `/runs/${encodeURIComponent(runId)}/events?after=${lastSeq}`,
          {
            headers: { accept: 'text/event-stream', 'last-event-id': String(lastSeq) },
            signal: controller.signal,
          },
        );
        if (!response.ok || !response.body) {
          stop(await apiError(response));
          return;
        }
        await readEvents(
          response.body,
          deliver,
          (frame) => handlers.onFrame?.(frame),
          () => stopped,
        );
        // The server closed a healthy stream (restart, slow client): resume from lastSeq.
        if (!stopped) await reconnect(0);
      } catch (error) {
        if (stopped) return;
        if (error instanceof InvalidEventStream) {
          stop(error);
          return;
        }
        await reconnect(attempt, error);
      }
    };
    const reconnect = async (attempt: number, error?: unknown) => {
      const delay = RECONNECT_DELAYS_MS[attempt];
      if (delay === undefined) {
        stop(error ?? new Error('the event stream could not be resumed'));
        return;
      }
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          controller.signal.removeEventListener('abort', finish);
          resolve();
        };
        const timer = setTimeout(finish, delay);
        controller.signal.addEventListener('abort', finish, { once: true });
        if (stopped) finish();
      });
      if (!stopped) await connect(attempt + 1);
    };

    void connect(0);
    return () => stop();
  }
}

async function readEvents(
  body: ReadableStream<Uint8Array>,
  deliver: (event: RunEvent) => void,
  stream: (frame: StreamFrame) => void,
  stopped: () => boolean,
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (!stopped()) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer = (buffer + decoder.decode(value, { stream: true })).replaceAll('\r\n', '\n');
      let end = buffer.indexOf('\n\n');
      while (end >= 0 && !stopped()) {
        const block = buffer.slice(0, end);
        checkFrameSize(block);
        buffer = buffer.slice(end + 2);
        const frame = parseFrame(block);
        if (frame?.event === 'domain') {
          let event: RunEvent;
          try {
            event = RunEvent.parse(JSON.parse(frame.data));
          } catch {
            throw new InvalidEventStream('invalid domain event');
          }
          deliver(event);
        }
        if (frame?.event === 'stream') stream(JSON.parse(frame.data) as StreamFrame);
        end = buffer.indexOf('\n\n');
      }
      checkFrameSize(buffer);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

class InvalidEventStream extends Error {}

function checkFrameSize(block: string) {
  // A committed record can exceed its HTTP input (patches contain before + after).
  const header = /^(?:id: \d+\n)?event: domain\ndata: /.exec(block.slice(0, 128));
  if (header && block.indexOf('\n', header[0].length) === -1) return;
  if (new TextEncoder().encode(block).byteLength > 2 * 1024 * 1024)
    throw new InvalidEventStream('event stream frame exceeds the size limit');
}

function parseFrame(block: string): { event: string; data: string } | null {
  let event = 'message';
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    if (field === 'data') data.push(value);
  }
  return data.length > 0 ? { event, data: data.join('\n') } : null;
}

function refused(commandId: string, code: ErrorCode, message: string): Receipt {
  return {
    commandId,
    runId: 'none',
    status: 'rejected',
    acceptedSeq: null,
    target: 'run:none',
    requestedBoundary: 'immediate',
    relatedEventIds: [],
    error: { code, message },
  };
}

async function apiErrorFrom(response: Response, body: unknown): Promise<ApiError> {
  const error = (body as { error?: { code?: ErrorCode; message?: string } }).error;
  return new ApiError(
    response.status,
    error?.code ?? 'UNKNOWN',
    error?.message ?? response.statusText,
  );
}

// ── Corral repository ────────────────────────────────────────────────────────

export class RestCorralRepository implements CorralRepository {
  private readonly http: Http;

  constructor(options: HttpOptions) {
    this.http = new Http(options);
  }

  list(): Promise<CorralSummary[]> {
    return this.http.json('/corrals');
  }

  async get(corralId: string): Promise<CorralRecord | null> {
    const response = await this.http.request(`/corrals/${encodeURIComponent(corralId)}`);
    if (response.status === 404) return null;
    if (!response.ok) throw await apiError(response);
    return (await response.json()) as CorralRecord;
  }

  save(request: SaveRequest): Promise<SaveResult> {
    const body = { definition: request.definition, layout: request.layout };
    if (request.expectedDefinitionRevision === null)
      return this.write('/corrals', 'POST', {
        ...body,
        ...(request.projectId ? { projectId: request.projectId } : {}),
      });
    return this.write(`/corrals/${encodeURIComponent(request.definition.id)}`, 'PUT', body, {
      'if-match': `"${request.expectedDefinitionRevision}"`,
    });
  }

  duplicate(corralId: string, name: string): Promise<SaveResult> {
    return this.write(`/corrals/${encodeURIComponent(corralId)}/duplicate`, 'POST', { name });
  }

  async remove(corralId: string): Promise<void> {
    const response = await this.http.request(`/corrals/${encodeURIComponent(corralId)}`, {
      method: 'DELETE',
    });
    if (!response.ok && response.status !== 404) throw await apiError(response);
  }

  listProjects(): Promise<ProjectSummary[]> {
    return this.http.json('/projects');
  }

  createProject(input: { name: string; description?: string }): Promise<ProjectResult> {
    return this.projectWrite('/projects', 'POST', input) as Promise<ProjectResult>;
  }

  updateProject(projectId: string, change: ProjectChange): Promise<ProjectResult> {
    return this.projectWrite(
      `/projects/${encodeURIComponent(projectId)}`,
      'PATCH',
      change,
    ) as Promise<ProjectResult>;
  }

  moveCorral(corralId: string, projectId: string): Promise<SaveResult> {
    return this.write(`/corrals/${encodeURIComponent(corralId)}/project`, 'PUT', { projectId });
  }

  listSessions(projectId: string): Promise<WorkSession[]> {
    return this.http.json(`/sessions?projectId=${encodeURIComponent(projectId)}`);
  }

  async getSession(sessionId: string): Promise<WorkSession | null> {
    const response = await this.http.request(`/sessions/${encodeURIComponent(sessionId)}`);
    if (response.status === 404) return null;
    if (!response.ok) throw await apiError(response);
    return (await response.json()) as WorkSession;
  }

  createSession(input: {
    projectId: string;
    title: string;
    objective?: string;
    corralId?: string | null;
  }): Promise<SessionResult> {
    return this.projectWrite('/sessions', 'POST', input) as Promise<SessionResult>;
  }

  updateSession(sessionId: string, change: SessionChange): Promise<SessionResult> {
    return this.projectWrite(
      `/sessions/${encodeURIComponent(sessionId)}`,
      'PATCH',
      change,
    ) as Promise<SessionResult>;
  }

  addSessionEntry(sessionId: string, entry: NewSessionEntry): Promise<SessionResult> {
    return this.projectWrite(
      `/sessions/${encodeURIComponent(sessionId)}/entries`,
      'POST',
      entry,
    ) as Promise<SessionResult>;
  }

  updateSessionEntry(
    sessionId: string,
    entryId: string,
    change: { state: SessionEntryState; runId?: string | null; detail?: string | null },
  ): Promise<SessionResult> {
    return this.projectWrite(
      `/sessions/${encodeURIComponent(sessionId)}/entries/${encodeURIComponent(entryId)}`,
      'PATCH',
      change,
    ) as Promise<SessionResult>;
  }

  /** Same body, errors mapped like project writes (sessions and projects share codes). */
  private async projectWrite(
    path: string,
    method: string,
    body: unknown,
  ): Promise<ProjectResult | SessionResult> {
    let response: Response;
    try {
      response = await this.http.request(path, { method, body: JSON.stringify(body) });
    } catch (error) {
      return {
        ok: false,
        error: 'storage_unavailable',
        message: `Could not save: ${String(error)}`,
      };
    }
    if (response.ok) return (await response.json()) as ProjectResult | SessionResult;
    const error = await apiError(response);
    const kind =
      response.status === 404
        ? 'not_found'
        : response.status === 409
          ? 'revision_conflict'
          : response.status === 400
            ? 'invalid'
            : 'storage_unavailable';
    return { ok: false, error: kind, message: error.message };
  }

  private async write(
    path: string,
    method: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<SaveResult> {
    let response: Response;
    try {
      response = await this.http.request(path, { method, headers, body: JSON.stringify(body) });
    } catch (error) {
      return {
        ok: false,
        error: 'storage_unavailable',
        message: `Could not save: ${String(error)}`,
      };
    }
    if (response.ok) return (await response.json()) as SaveResult;
    const error = await apiError(response);
    if (response.status === 404) return { ok: false, error: 'not_found', message: error.message };
    if (response.status === 409) {
      return { ok: false, error: 'revision_conflict', message: error.message };
    }
    return { ok: false, error: 'storage_unavailable', message: error.message };
  }
}

// ── models (C-058) ───────────────────────────────────────────────────────────

export interface LoginView {
  state: 'waiting' | 'exchanging' | 'failed';
  authUrl: string | null;
  error: string | null;
}

export interface ProviderAuthView {
  providerId: string;
  name: string;
  signedIn: boolean;
  method: 'oauth' | 'api_key' | 'none' | null;
  /** Ways this provider can be signed in to here (CR-005). */
  methods: { oauth: boolean; apiKey: boolean };
  /** host[:port] of an OpenAI-compatible endpoint; null for built-in providers. */
  endpoint: string | null;
  /** A key was entered for another address than the one the workspace names now. */
  endpointChanged: boolean;
  subscription: boolean;
  expiresAt: string | null;
  login: LoginView | null;
  /** Where the sign-in comes from: Corral's own, or the Codex CLI login read only (CR-004). */
  source: 'corral' | 'codex-cli' | 'environment' | null;
  /** False when the borrowed Codex login file is readable by other users. */
  permissionsOk: boolean;
}

export interface ModelProfileView {
  profileId: string;
  provider: string;
  providerName: string;
  modelId: string;
  modelName: string | null;
  available: boolean;
  reasoning: boolean | null;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  method: 'oauth' | 'api_key' | 'none' | null;
  keyConfigured: boolean;
  /** Whether a subscription sign-in may use this model; null when no list is known. */
  subscriptionSupported: boolean | null;
}

/** A provider and its models, for the profile editor (CR-008). No credentials or status. */
export interface CatalogProvider {
  providerId: string;
  name: string;
  /** An OpenAI-compatible endpoint from the workspace config. */
  endpoint: boolean;
  methods: { oauth: boolean; apiKey: boolean };
  /** `cost`: list prices in USD per million tokens, for estimates (roadmap 15). */
  models: {
    id: string;
    name: string;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  }[];
}

export interface ProfileConfig {
  id: string;
  provider: string;
  model: string;
}

export interface EndpointConfig {
  id: string;
  name: string;
  baseUrl: string;
  access: 'api_key' | 'none';
  models: {
    id: string;
    name?: string;
    contextWindow?: number;
    maxOutput?: number;
    reasoning?: boolean;
  }[];
}

/** `.corral/config.json`'s model keys, with the revision a save must start from (CR-008). */
export interface ModelConfig {
  modelProfiles: ProfileConfig[];
  modelProviders: EndpointConfig[];
  /** No profiles are configured; the defaults are in use. */
  usingDefaults: boolean;
  revision: string;
}

/** Sign-in status and model profiles. Answers carry status and expiry only, never tokens. */
export class ModelsApi {
  private readonly http: Http;

  constructor(options: HttpOptions) {
    this.http = new Http(options);
  }

  profiles(): Promise<ModelProfileView[]> {
    return this.http.json('/model-profiles');
  }

  auth(): Promise<ProviderAuthView[]> {
    return this.http.json('/model-auth');
  }

  startLogin(providerId: string): Promise<LoginView> {
    return this.http.json(`/model-auth/${encodeURIComponent(providerId)}/login`, {
      method: 'POST',
    });
  }

  /** The browser's final redirect URL, when the automatic callback could not complete. */
  async submitRedirect(providerId: string, url: string): Promise<boolean> {
    const response = await this.http.request(
      `/model-auth/${encodeURIComponent(providerId)}/login/callback`,
      { method: 'POST', body: JSON.stringify({ url }) },
    );
    return response.ok;
  }

  cancelLogin(providerId: string): Promise<ProviderAuthView[]> {
    return this.http.json(`/model-auth/${encodeURIComponent(providerId)}/login`, {
      method: 'DELETE',
    });
  }

  catalog(): Promise<CatalogProvider[]> {
    return this.http.json('/model-catalog');
  }

  config(): Promise<ModelConfig> {
    return this.http.json('/model-config');
  }

  /** Saves profiles and endpoints; refused with field-named errors, never values (CR-008). */
  saveConfig(
    change: Pick<ModelConfig, 'modelProfiles' | 'modelProviders' | 'revision'>,
  ): Promise<ModelConfig> {
    return this.http.json('/model-config', { method: 'PUT', body: JSON.stringify(change) });
  }

  /** A team plan for a goal from one model request (CR-006); only a checked plan comes back. */
  draftTeam(
    goal: string,
  ): Promise<{ plan: TeamPlan; model: { provider: string; modelId: string } }> {
    return this.http.json('/team-drafts', { method: 'POST', body: JSON.stringify({ goal }) });
  }

  /** Stores an API key on the server (CR-005); the answer never contains it. */
  setApiKey(providerId: string, key: string): Promise<ProviderAuthView[]> {
    return this.http.json(`/model-auth/${encodeURIComponent(providerId)}/api-key`, {
      method: 'PUT',
      body: JSON.stringify({ key }),
    });
  }

  logout(providerId: string): Promise<ProviderAuthView[]> {
    return this.http.json(`/model-auth/${encodeURIComponent(providerId)}`, { method: 'DELETE' });
  }
}

// ── work folders and file changes (CR-012) ──────────────────────────────────

export interface VerifyCommand {
  id: string;
  name: string;
  argv: string[];
  timeoutMs: number;
}

export interface WorkspaceBindingView {
  bindingId: string;
  projectId: string;
  path: string;
  isGit: boolean;
  trusted: boolean;
  verifyCommands: VerifyCommand[];
  status: { branch: string | null; head: string | null; changed: number } | null;
  missing: boolean;
}

export interface WorktreeView {
  sessionId: string;
  baseCommit: string;
  createdAt: string;
  removedAt: string | null;
  reviewed: boolean;
  missing: boolean;
}

export type ChangeScopeQuery =
  | { kind: 'session' }
  | { kind: 'review' }
  | { kind: 'run'; runId: string };

export interface FileChangeView {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'type_changed';
  additions: number | null;
  deletions: number | null;
  binary: boolean;
  provenance: 'managed_agent' | 'external_observed';
  beforeBlob: string | null;
  afterBlob: string | null;
}

export interface ChangeSetView {
  from: string | null;
  to: string | null;
  unavailable: string | null;
  files: FileChangeView[];
}

export type FileSideView =
  | { kind: 'absent' }
  | { kind: 'text'; text: string }
  | { kind: 'binary'; bytes: number }
  | { kind: 'too_large'; bytes: number };

export interface VerificationResultView {
  verificationId: string;
  commandId: string;
  name: string;
  argv: string[];
  tree: string;
  state: 'running' | 'passed' | 'failed' | 'error';
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number | null;
  output: string;
  startedAt: string;
  endedAt: string | null;
  stale: boolean;
}

export interface FileOperationView {
  id: string;
  run_id: string;
  kind: string;
  path: string;
  to_path: string | null;
  state: 'planned' | 'applied' | 'failed' | 'uncertain';
  detail: string | null;
  created_at: string;
}

/** Folders, working copies, changes and checks on the local server (CR-012). */
export class WorkspacesApi {
  private readonly http: Http;

  constructor(options: HttpOptions) {
    this.http = new Http(options);
  }

  private async send<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const response = await this.http.request(path, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw await apiError(response);
    return (response.status === 204 ? null : await response.json()) as T;
  }

  async binding(projectId: string): Promise<WorkspaceBindingView | null> {
    const p = encodeURIComponent(projectId);
    return (await this.send<{ binding: WorkspaceBindingView | null }>(`/projects/${p}/workspace`))
      .binding;
  }
  async bind(projectId: string, path: string): Promise<WorkspaceBindingView> {
    const p = encodeURIComponent(projectId);
    return (
      await this.send<{ binding: WorkspaceBindingView }>(`/projects/${p}/workspace`, 'PUT', {
        path,
      })
    ).binding;
  }
  async configure(
    projectId: string,
    change: { trusted?: boolean; verifyCommands?: VerifyCommand[] },
  ): Promise<WorkspaceBindingView> {
    const p = encodeURIComponent(projectId);
    return (
      await this.send<{ binding: WorkspaceBindingView }>(
        `/projects/${p}/workspace`,
        'PATCH',
        change,
      )
    ).binding;
  }
  unbind(projectId: string): Promise<null> {
    return this.send(`/projects/${encodeURIComponent(projectId)}/workspace`, 'DELETE');
  }
  async worktree(sessionId: string): Promise<WorktreeView | null> {
    const s = encodeURIComponent(sessionId);
    return (await this.send<{ worktree: WorktreeView | null }>(`/sessions/${s}/worktree`)).worktree;
  }
  async createWorktree(sessionId: string): Promise<WorktreeView> {
    const s = encodeURIComponent(sessionId);
    return (await this.send<{ worktree: WorktreeView }>(`/sessions/${s}/worktree`, 'POST'))
      .worktree;
  }
  removeWorktree(sessionId: string): Promise<null> {
    return this.send(`/sessions/${encodeURIComponent(sessionId)}/worktree`, 'DELETE');
  }
  changes(sessionId: string, scope: ChangeScopeQuery): Promise<ChangeSetView> {
    const query =
      scope.kind === 'run'
        ? `scope=run&runId=${encodeURIComponent(scope.runId)}`
        : `scope=${scope.kind}`;
    return this.send(`/sessions/${encodeURIComponent(sessionId)}/changes?${query}`);
  }
  fileVersions(
    sessionId: string,
    from: string,
    to: string,
    path: string,
  ): Promise<{ path: string; before: FileSideView; after: FileSideView }> {
    const query = new URLSearchParams({ from, to, path }).toString();
    return this.send(`/sessions/${encodeURIComponent(sessionId)}/changes/file?${query}`);
  }
  markReviewed(sessionId: string): Promise<null> {
    return this.send(`/sessions/${encodeURIComponent(sessionId)}/reviewed`, 'POST');
  }
  verifications(sessionId: string): Promise<VerificationResultView[]> {
    return this.send(`/sessions/${encodeURIComponent(sessionId)}/verifications`);
  }
  verify(sessionId: string, commandId: string): Promise<{ verificationId: string }> {
    return this.send(`/sessions/${encodeURIComponent(sessionId)}/verifications`, 'POST', {
      commandId,
    });
  }
  fileOperations(sessionId: string): Promise<FileOperationView[]> {
    return this.send(`/sessions/${encodeURIComponent(sessionId)}/file-operations`);
  }

  // CR-013: comments, decisions, applying, reverting, inbox.
  private s(sessionId: string) {
    return `/sessions/${encodeURIComponent(sessionId)}`;
  }
  comments(sessionId: string): Promise<ReviewCommentView[]> {
    return this.send(`${this.s(sessionId)}/comments`);
  }
  addComment(
    sessionId: string,
    comment: Omit<ReviewCommentView, 'commentId' | 'state' | 'batchId' | 'createdAt'>,
  ): Promise<ReviewCommentView> {
    return this.send(`${this.s(sessionId)}/comments`, 'POST', comment);
  }
  setCommentState(
    sessionId: string,
    commentId: string,
    state: 'addressed' | 'obsolete' | 'draft' | 'deleted',
  ): Promise<null> {
    return this.send(`${this.s(sessionId)}/comments/${encodeURIComponent(commentId)}`, 'PATCH', {
      state,
    });
  }
  async feedbackText(sessionId: string, commentIds: string[]): Promise<string> {
    return (
      await this.send<{ text: string }>(`${this.s(sessionId)}/feedback/text`, 'POST', {
        commentIds,
      })
    ).text;
  }
  recordFeedback(
    sessionId: string,
    batch: {
      commentIds: string[];
      intent: 'steer' | 'next';
      runId: string | null;
      executionId: string | null;
      text: string;
      sent: boolean;
      detail: string | null;
    },
  ): Promise<{ batchId: string }> {
    return this.send(`${this.s(sessionId)}/feedback`, 'POST', batch);
  }
  decisions(sessionId: string): Promise<ReviewDecisionView[]> {
    return this.send(`${this.s(sessionId)}/decisions`);
  }
  decide(
    sessionId: string,
    decision: {
      from: string;
      to: string;
      decision: 'approved' | 'changes_requested';
      note: string;
    },
  ): Promise<{ decisionId: string }> {
    return this.send(`${this.s(sessionId)}/decisions`, 'POST', decision);
  }
  integrationPlan(sessionId: string, decisionId: string): Promise<IntegrationPlanFile[]> {
    return this.send(
      `${this.s(sessionId)}/integration-plan?decisionId=${encodeURIComponent(decisionId)}`,
    );
  }
  integrate(sessionId: string, decisionId: string): Promise<IntegrationResultView> {
    return this.send(`${this.s(sessionId)}/integrations`, 'POST', { decisionId });
  }
  integrations(sessionId: string): Promise<IntegrationResultView[]> {
    return this.send(`${this.s(sessionId)}/integrations`);
  }
  revert(sessionId: string, integrationId: string): Promise<IntegrationResultView> {
    return this.send(
      `${this.s(sessionId)}/integrations/${encodeURIComponent(integrationId)}/revert`,
      'POST',
    );
  }
  inbox(projectId: string): Promise<InboxItemView[]> {
    return this.send(`/projects/${encodeURIComponent(projectId)}/inbox`);
  }
}

export interface ReviewCommentView {
  commentId: string;
  from: string;
  to: string;
  path: string;
  side: 'before' | 'after';
  startLine: number;
  endLine: number;
  quote: string;
  body: string;
  state: 'draft' | 'submitted' | 'addressed' | 'obsolete';
  batchId: string | null;
  createdAt: string;
}

export interface ReviewDecisionView {
  decisionId: string;
  from: string;
  to: string;
  decision: 'approved' | 'changes_requested';
  note: string;
  createdAt: string;
  stale: boolean;
}

export interface IntegrationPlanFile {
  path: string;
  action: 'write' | 'delete';
  outcome: 'apply' | 'skip' | 'conflict';
  reason: string | null;
}

export interface IntegrationResultView {
  integrationId: string;
  decisionId: string;
  state: 'applying' | 'applied' | 'partial' | 'conflict' | 'reverted' | 'failed';
  createdAt: string;
  files: { path: string; action: string; outcome: string; detail: string | null }[];
}

export interface InboxItemView {
  kind: 'decision' | 'queued' | 'uncertain_write' | 'integration' | 'check_failed' | 'unreviewed';
  sessionId: string;
  sessionTitle: string;
  runId: string | null;
  detail: string | null;
}
