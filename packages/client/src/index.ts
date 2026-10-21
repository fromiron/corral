import type {
  CheckpointRestore,
  CheckpointRestorePlan,
  DocumentCommand,
  DocumentOperation,
  FileCheckpoint,
  FileDocument,
  GitDiff,
  GitDiffRequest,
  GitStatus,
  ProfileContextOverrides,
  ProfileContextPolicy,
  ProfileContextResolution,
  ReasoningCapabilities,
  RestoreCheckpoint,
  SkillAdoption,
  SkillAdoptRequest,
  SkillEvaluationRequest,
  SkillEvaluationView,
  SkillFileComparison,
  SkillKey,
  SkillRollbackRequest,
  SkillUpdatePreview,
  TerminalAck,
  TerminalControllerChange,
  TerminalCreate,
  TerminalIdentity,
  TerminalInput,
  TerminalList,
  TerminalResize,
  TerminalView,
} from '@corral/contracts';
import { canonicalJson } from '@corral/core';
import type { CommandRecovery, StartRecovery } from './recovery.ts';
import { VaultClient } from './vault-api.ts';

export type {
  DocumentCommand,
  DocumentOperation,
  DocumentVersion,
  FileDocument,
  GitDiff,
  GitDiffRequest,
  GitFileSide,
  GitHead,
  GitStatus,
  GitStatusEntry,
  TerminalAck,
  TerminalControllerChange,
  TerminalCreate,
  TerminalIdentity,
  TerminalInput,
  TerminalList,
  TerminalResize,
  TerminalStreamMessage,
  TerminalView,
  UserGitTarget,
  WorkspaceTarget,
} from '@corral/contracts';
export type {
  ModelCatalogMetadata,
  ModelImportCommit,
  ModelImportPreview,
  ModelImportSource,
} from './models-import.ts';
export type { StartPreviewInput, WorkspacePreview } from './preview.ts';
export { type CommandRecovery, createStartRecovery, type StartRecovery } from './recovery.ts';
export type * from './vault.ts';
export { VaultClient } from './vault-api.ts';
export type {
  VoiceCall,
  VoiceClient,
  VoiceConfiguration,
  VoiceProfile,
  VoiceStartInput,
  VoiceTarget,
  VoiceTranscript,
  VoiceTranscriptReceipt,
} from './voice.ts';

import {
  type AutoModelChoice,
  type AutoRoute,
  type CorralDefinition,
  type CreateRunRequest,
  type EffectiveHarnessSnapshot,
  type ErrorCode,
  type HarnessBindingRef,
  type HarnessDefault,
  type HarnessDocumentDraft,
  type HarnessEntryKey,
  type HarnessEntryView,
  type HarnessManagementState,
  type HarnessProfile,
  type HarnessProfileRevision,
  type HarnessProfileView,
  type HarnessPublish,
  type HarnessResource,
  type HarnessResourceView,
  type LspProposal,
  type LspProposalSummary,
  type ManagedHook,
  type McpServerDraft,
  type ProjectToolConfig,
  type ProjectToolConfigRevision,
  type Receipt,
  type RegisteredCheck,
  type RegisteredMcpServer,
  type ReviewRecipeRevision,
  type RunCommand,
  RunEvent,
  type RunReference,
  type StartFrom,
  type StartRunRequest,
  type StreamFrame,
  type TeamPlan,
  TerminalStreamMessage,
  type UltraSelection,
  type VerificationReport,
} from '@corral/contracts';
import type {
  AutoStartResult,
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
  SessionEntryChange,
  SessionResult,
  StartRunResult,
  TransportHandlers,
  WorkSession,
} from '@corral/core';

/** POST /api/v1/runs/auto (CR-024). */
export interface AutoRunStart {
  harness?: import('@corral/contracts').HarnessBindingRef;
  permissionMode?: import('@corral/contracts').PermissionMode;
  ultra?: UltraSelection;
  qualityPreset?: 'default' | 'ultra';
  taskScope?: 'work' | 'review_only';
  verificationScope?: 'targeted' | 'release';
  commandId: string;
  sessionId: string;
  brief: string;
  choice: AutoModelChoice;
  mode: 'mock' | 'live';
  startFrom?: StartFrom;
  references?: RunReference[];
}

export interface AutoCancelRequest {
  commandId: string;
  sessionId: string;
  cancelCommandId: string;
}

export interface AutoCancelResult {
  start: AutoStartResult | null;
  cancellation: Receipt | null;
}

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
    if (init.body !== undefined && !headers.has('content-type'))
      headers.set('content-type', 'application/json');
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

export class VoiceApi {
  private readonly http: Http;
  constructor(options: HttpOptions) {
    this.http = new Http(options);
  }
  configuration(): Promise<import('./voice.ts').VoiceConfiguration> {
    return this.http.json('/voice');
  }
  start(
    input: import('./voice.ts').VoiceStartInput,
    signal?: AbortSignal,
  ): Promise<import('./voice.ts').VoiceCall> {
    return this.http.json('/voice/calls', {
      method: 'POST',
      body: JSON.stringify(input),
      ...(signal ? { signal } : {}),
    });
  }
  async stop(callId: string): Promise<void> {
    const response = await this.http.request(`/voice/calls/${encodeURIComponent(callId)}`, {
      method: 'DELETE',
    });
    if (!response.ok) throw await apiError(response);
  }
}

export class RunModesApi {
  private readonly http: Http;
  constructor(options: HttpOptions) {
    this.http = new Http(options);
  }
  read(): Promise<{ workspaceId: string; modes: Record<string, 'mock' | 'live'> }> {
    return this.http.json('/run-modes');
  }
  async set(key: string, mode: 'mock' | 'live'): Promise<void> {
    await this.http.json('/run-modes', { method: 'PUT', body: JSON.stringify({ key, mode }) });
  }
}

export class VaultApi extends VaultClient {
  constructor(options: HttpOptions) {
    super(new Http(options));
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
  private readonly recovery?: { commands: CommandRecovery; starts: StartRecovery };
  private readonly pendingAutoIds = new Map<string, string>();

  constructor(
    options: HttpOptions,
    recovery?: { commands: CommandRecovery; starts: StartRecovery },
  ) {
    this.http = new Http(options);
    this.recovery = recovery;
  }

  private async recoverStart(
    path: string,
    request: { commandId: string },
  ): Promise<(StartRunResult & { autoRoute?: AutoRoute | null }) | null> {
    if (!this.recovery) return null;
    this.recovery.starts.pending(path, request);
    const response = await this.http.request(
      `/start-commands/${encodeURIComponent(request.commandId)}`,
    );
    if (response.status === 404) return null;
    if (!response.ok) throw await apiError(response);
    const result = (await response.json()) as StartRunResult & { autoRoute?: AutoRoute | null };
    if (result.receipt?.commandId !== request.commandId)
      throw new Error('Start receipt identity mismatch.');
    this.recovery.starts.confirmed(request.commandId);
    return result;
  }

  async startRun(request: StartRunRequest | CreateRunRequest): Promise<StartRunResult> {
    if ('definition' in request) {
      return {
        runId: null,
        receipt: refused(request.commandId, 'SCHEMA_INVALID', 'save the Corral first'),
      };
    }
    // Standalone Editor RunControls creates a new view/ID after reload. Recover the exact
    // unresolved saved-revision request before considering it a new Run.
    request = this.recovery?.starts.prepare('/runs', request) ?? request;
    const recovered = await this.recoverStart('/runs', request);
    if (recovered) return recovered;
    const response = await this.http.request('/runs', {
      method: 'POST',
      body: JSON.stringify(request),
    });
    const body = (await response.json()) as Partial<StartRunResult> & { error?: ApiError };
    if (!body.receipt) throw await apiErrorFrom(response, body);
    this.recovery?.starts.confirmed(request.commandId);
    return { runId: body.runId ?? null, receipt: body.receipt };
  }

  async sendCommand(command: RunCommand): Promise<Receipt> {
    if (this.recovery) {
      const prior = this.recovery.commands
        .commands(command.runId)
        .find(
          (candidate) =>
            canonicalJson({ ...candidate, commandId: '' }) ===
            canonicalJson({ ...command, commandId: '' }),
        );
      if (prior) command = prior;
      this.recovery.commands.pending(command);
      const receipt = await this.getReceipt(command.runId, command.commandId);
      if (receipt) {
        this.recovery.commands.confirmed(command.runId, command.commandId);
        return receipt;
      }
    }
    const response = await this.http.request(
      `/runs/${encodeURIComponent(command.runId)}/commands`,
      {
        method: 'POST',
        body: JSON.stringify(command),
      },
    );
    const body = (await response.json()) as Receipt & { error?: unknown };
    if (!('status' in body)) throw await apiErrorFrom(response, body);
    this.recovery?.commands.confirmed(command.runId, command.commandId);
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
    request = this.recovery?.starts.prepare('/runs/explain', request) ?? request;
    const recovered = await this.recoverStart('/runs/explain', request);
    if (recovered) return recovered;
    const response = await this.http.request('/runs/explain', {
      method: 'POST',
      body: JSON.stringify(request),
    });
    const body = (await response.json()) as Partial<StartRunResult> & { error?: ApiError };
    if (!body.receipt) throw await apiErrorFrom(response, body);
    this.recovery?.starts.confirmed(request.commandId);
    return { runId: body.runId ?? null, receipt: body.receipt };
  }

  /** A request in an auto session (CR-024): the runtime chooses the template and starts it. */
  async startAuto(
    request: AutoRunStart,
    signal?: AbortSignal,
  ): Promise<StartRunResult & { autoRoute: AutoRoute | null }> {
    const callerId = request.commandId;
    request = this.recovery?.starts.prepare('/runs/auto', request) ?? request;
    if (callerId !== request.commandId) this.pendingAutoIds.set(callerId, request.commandId);
    try {
      const recovered = await this.recoverStart('/runs/auto', request);
      if (recovered) return { ...recovered, autoRoute: recovered.autoRoute ?? null };
      const response = await this.http.request('/runs/auto', {
        method: 'POST',
        body: JSON.stringify({ schemaVersion: '0.1', ...request }),
        ...(signal ? { signal } : {}),
      });
      const body = (await response.json()) as Partial<StartRunResult> & {
        autoRoute?: AutoRoute | null;
        error?: ApiError;
      };
      if (!body.receipt) throw await apiErrorFrom(response, body);
      this.recovery?.starts.confirmed(request.commandId);
      return {
        runId: body.runId ?? null,
        receipt: body.receipt,
        autoRoute: body.autoRoute ?? null,
      };
    } finally {
      this.pendingAutoIds.delete(callerId);
    }
  }

  cancelAuto({ commandId, ...body }: AutoCancelRequest): Promise<AutoCancelResult> {
    commandId = this.pendingAutoIds.get(commandId) ?? commandId;
    return this.http.json(`/runs/auto/${encodeURIComponent(commandId)}/cancel`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
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
  return readSse(
    body,
    (frame) => {
      if (frame.event === 'domain') {
        let event: RunEvent;
        try {
          event = RunEvent.parse(JSON.parse(frame.data));
        } catch {
          throw new InvalidEventStream('invalid domain event');
        }
        deliver(event);
      }
      if (frame.event === 'stream') stream(JSON.parse(frame.data) as StreamFrame);
    },
    stopped,
    true,
  );
}

async function readSse(
  body: ReadableStream<Uint8Array>,
  receive: (frame: { event: string; data: string }) => void | Promise<void>,
  stopped: () => boolean,
  allowLargeDomain = false,
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
        checkFrameSize(block, allowLargeDomain);
        buffer = buffer.slice(end + 2);
        const frame = parseFrame(block);
        if (frame) await receive(frame);
        end = buffer.indexOf('\n\n');
      }
      checkFrameSize(buffer, allowLargeDomain);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

class InvalidEventStream extends Error {}

function checkFrameSize(block: string, allowLargeDomain: boolean) {
  // A committed record can exceed its HTTP input (patches contain before + after).
  const header = /^(?:id: \d+\n)?event: domain\ndata: /.exec(block.slice(0, 128));
  if (allowLargeDomain && header && block.indexOf('\n', header[0].length) === -1) return;
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

/** User PTYs use authenticated HTTP controls and an output-only resumable stream. */
export class TerminalsApi {
  private readonly http: Http;
  constructor(options: HttpOptions) {
    this.http = new Http(options);
  }
  private path(sessionId: string, terminalId?: string) {
    return `/sessions/${encodeURIComponent(sessionId)}/terminals${terminalId === undefined ? '' : `/${encodeURIComponent(terminalId)}`}`;
  }
  list(sessionId: string): Promise<TerminalList> {
    return this.http.json(this.path(sessionId));
  }
  read(sessionId: string, terminalId: string): Promise<TerminalView> {
    return this.http.json(this.path(sessionId, terminalId));
  }
  create(sessionId: string, input: TerminalCreate): Promise<TerminalView> {
    return this.http.json(this.path(sessionId), { method: 'POST', body: JSON.stringify(input) });
  }
  control(
    sessionId: string,
    terminalId: string,
    input: TerminalControllerChange,
  ): Promise<TerminalView> {
    return this.http.json(`${this.path(sessionId, terminalId)}/control`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }
  input(sessionId: string, terminalId: string, input: TerminalInput): Promise<TerminalAck> {
    return this.http.json(`${this.path(sessionId, terminalId)}/input`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }
  resize(sessionId: string, terminalId: string, input: TerminalResize): Promise<TerminalAck> {
    return this.http.json(`${this.path(sessionId, terminalId)}/resize`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }
  stop(sessionId: string, terminalId: string, input: TerminalIdentity): Promise<TerminalView> {
    return this.http.json(`${this.path(sessionId, terminalId)}/stop`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }
  subscribe(
    sessionId: string,
    terminalId: string,
    cursor: { generation: string; after: number },
    handlers: {
      onEvent: (event: TerminalStreamMessage) => void | Promise<void>;
      onError?: (error: unknown) => void;
    },
  ): () => void {
    const controller = new AbortController();
    let lastSequence = cursor.after;
    let stopped = false;
    const stop = (error?: unknown) => {
      if (stopped) return;
      stopped = true;
      controller.abort();
      if (error !== undefined) handlers.onError?.(error);
    };
    const connect = async (attempt: number): Promise<void> => {
      let failure: unknown;
      try {
        const query = new URLSearchParams({
          generation: cursor.generation,
          after: String(lastSequence),
        });
        const response = await this.http.request(
          `${this.path(sessionId, terminalId)}/events?${query}`,
          {
            headers: { accept: 'text/event-stream', 'last-event-id': String(lastSequence) },
            signal: controller.signal,
          },
        );
        if (!response.ok || !response.body) return stop(await apiError(response));
        await readSse(
          response.body,
          async (frame) => {
            if (frame.event !== 'terminal') return;
            let event: TerminalStreamMessage;
            try {
              event = TerminalStreamMessage.parse(JSON.parse(frame.data));
            } catch {
              throw new InvalidEventStream('invalid terminal event');
            }
            const generation =
              event.type === 'status' ? event.terminal.generation : event.generation;
            if (
              generation !== cursor.generation ||
              (event.type === 'status' &&
                (event.terminal.terminalId !== terminalId ||
                  event.terminal.target.sessionId !== sessionId))
            )
              throw new InvalidEventStream('terminal event identity does not match');
            if (event.type !== 'status') {
              if (event.sequence <= lastSequence) return;
              if (event.sequence !== lastSequence + 1) throw new Error('terminal output gap');
            }
            try {
              await handlers.onEvent(event);
            } catch {
              throw new InvalidEventStream('terminal rendering failed');
            }
            if (event.type !== 'status') lastSequence = event.sequence;
          },
          () => stopped,
        );
        attempt = 0;
      } catch (error) {
        if (stopped) return;
        if (error instanceof InvalidEventStream) return stop(error);
        failure = error;
      }
      if (stopped) return;
      const delay = RECONNECT_DELAYS_MS[attempt];
      if (delay === undefined)
        return stop(failure ?? new Error('terminal stream could not be resumed'));
      handlers.onError?.(failure ?? new Error('terminal stream disconnected'));
      if (stopped) return;
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
    autoTitle?: boolean;
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
    change: SessionEntryChange,
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
  /** True only when borrowed login permissions are verified private; false includes unknown. */
  permissionsOk: boolean;
}

export interface ReasoningSettings {
  apply: boolean;
  available: boolean;
  version: string | null;
  reason: string | null;
  revision: string;
}

export interface ModelProfileView {
  profileId: string;
  provider: string;
  providerName: string;
  modelId: string;
  modelName: string | null;
  available: boolean;
  reasoning: boolean | null;
  reasoningCapabilities?: ReasoningCapabilities;
  contextWindow: number | null;
  contextPolicy?: ProfileContextPolicy;
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

export interface ProfileConfig extends ProfileContextOverrides {
  id: string;
  provider: string;
  model: string;
  workerIsolation?: 'linux-bwrap';
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
  effectiveProfiles?: Record<string, ProfileContextResolution>;
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

  reasoning(): Promise<ReasoningSettings> {
    return this.http.json('/models/reasoning');
  }
  setReasoning(apply: boolean, revision: string): Promise<ReasoningSettings> {
    return this.http.json('/models/reasoning', {
      method: 'PUT',
      body: JSON.stringify({ apply, revision }),
    });
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

  importPreview(
    source: import('./models-import.ts').ModelImportSource,
    path?: string,
  ): Promise<import('./models-import.ts').ModelImportPreview> {
    return this.http.json('/model-imports/preview', {
      method: 'POST',
      body: JSON.stringify({ source, ...(path ? { path } : {}) }),
    });
  }

  importCommit(
    change: import('./models-import.ts').ModelImportCommit,
  ): Promise<
    Pick<ModelConfig, 'revision' | 'modelProfiles' | 'modelProviders'> & { keyFailures: string[] }
  > {
    return this.http.json('/model-imports/commit', {
      method: 'POST',
      body: JSON.stringify(change),
    });
  }

  catalogMetadata(): Promise<import('./models-import.ts').ModelCatalogMetadata | null> {
    return this.http.json('/model-catalog/metadata');
  }

  refreshCatalogMetadata(): Promise<import('./models-import.ts').ModelCatalogMetadata | null> {
    return this.http.json('/model-catalog/metadata/refresh', { method: 'POST' });
  }

  config(): Promise<ModelConfig> {
    return this.http.json('/model-config');
  }
  previewConfig(
    change: Pick<ModelConfig, 'modelProfiles' | 'modelProviders' | 'revision'>,
    signal?: AbortSignal,
  ): Promise<{ revision: string; effectiveProfiles: Record<string, ProfileContextResolution> }> {
    return this.http.json('/model-config/preview', {
      method: 'POST',
      body: JSON.stringify(change),
      ...(signal ? { signal } : {}),
    });
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
  setApiKey(providerId: string, key: string, revision?: string): Promise<ProviderAuthView[]> {
    return this.http.json(`/model-auth/${encodeURIComponent(providerId)}/api-key`, {
      method: 'PUT',
      body: JSON.stringify({ key, ...(revision ? { revision } : {}) }),
    });
  }

  logout(providerId: string): Promise<ProviderAuthView[]> {
    return this.http.json(`/model-auth/${encodeURIComponent(providerId)}`, { method: 'DELETE' });
  }
}

// ── work folders and file changes (CR-012) ──────────────────────────────────

export interface HarnessPreview {
  snapshot: EffectiveHarnessSnapshot;
  sections: { source: 'skill'; name: string; text: string }[];
  dynamic: boolean;
}

export interface McpProbeResult {
  operationId: string;
  configRevision: number;
  fingerprint: string;
  observedAt: string;
  tools: { name: string; title: string; description: string; schemaHash: string }[];
}

export class HarnessApi {
  registerPackageMcp(
    hash: string,
    contributionId: string,
    projectId: string,
    expectedRevision: number,
    operationId: string,
  ): Promise<import('@corral/contracts').ProjectToolConfigRevision> {
    return this.http.json(`/harness/packages/${encodeURIComponent(hash)}/mcp`, {
      method: 'POST',
      body: JSON.stringify({ contributionId, projectId, expectedRevision, operationId }),
    });
  }
  packages(): Promise<import('@corral/contracts').PackageView[]> {
    return this.http.json('/harness/packages');
  }
  reviewPackage(
    kind: 'local' | 'package',
    source: string,
    previousHash?: string,
  ): Promise<import('@corral/contracts').PackageReview> {
    return this.http.json('/harness/packages/review', {
      method: 'POST',
      body: JSON.stringify({ kind, source, ...(previousHash ? { previousHash } : {}) }),
    });
  }
  managePackage(
    hash: string,
    expectedRevision: number,
    status: 'enabled' | 'disabled' | 'removed',
    operationId: string,
  ): Promise<import('@corral/contracts').PackageView> {
    return this.http.json(`/harness/packages/${encodeURIComponent(hash)}`, {
      method: 'PUT',
      body: JSON.stringify({ expectedRevision, status, operationId }),
    });
  }
  private readonly http: Http;
  constructor(options: HttpOptions) {
    this.http = new Http(options);
  }
  mcpAuthStatus(
    projectId: string,
    serverId: string,
  ): Promise<{
    state: 'ready' | 'missing' | 'not_required';
    kind: 'none' | 'bearer' | 'oauth';
    expiresAt?: number;
  }> {
    return this.http.json(
      `/harness/projects/${encodeURIComponent(projectId)}/mcp-servers/${encodeURIComponent(serverId)}/auth`,
    );
  }
  saveMcpBearer(
    projectId: string,
    serverId: string,
    fingerprint: string,
    token: string,
  ): ReturnType<HarnessApi['mcpAuthStatus']> {
    return this.http.json(
      `/harness/projects/${encodeURIComponent(projectId)}/mcp-servers/${encodeURIComponent(serverId)}/auth`,
      { method: 'POST', body: JSON.stringify({ action: 'bearer', fingerprint, token }) },
    );
  }
  signInMcp(
    projectId: string,
    serverId: string,
    fingerprint: string,
  ): Promise<{ loginId: string; url: string }> {
    return this.http.json(
      `/harness/projects/${encodeURIComponent(projectId)}/mcp-servers/${encodeURIComponent(serverId)}/auth`,
      { method: 'POST', body: JSON.stringify({ action: 'sign_in', fingerprint }) },
    );
  }
  signOutMcp(
    projectId: string,
    serverId: string,
    fingerprint: string,
    configRevision?: number,
  ): ReturnType<HarnessApi['mcpAuthStatus']> {
    return this.http.json(
      `/harness/projects/${encodeURIComponent(projectId)}/mcp-servers/${encodeURIComponent(serverId)}/auth`,
      { method: 'POST', body: JSON.stringify({ action: 'sign_out', fingerprint, configRevision }) },
    );
  }
  mcpLoginStatus(
    loginId: string,
  ): Promise<{ state: 'pending' | 'ready' | 'failed' | 'cancelled' }> {
    return this.http.json(`/harness/mcp-logins/${encodeURIComponent(loginId)}`);
  }
  cancelMcpLogin(loginId: string): Promise<{ ok: boolean }> {
    return this.http.json(`/harness/mcp-logins/${encodeURIComponent(loginId)}`, {
      method: 'DELETE',
    });
  }
  inspectMcpServer(
    projectId: string,
    serverId: string,
    options: { revision?: number; sessionId?: string } = {},
  ): Promise<{
    server: RegisteredMcpServer;
    configRevision: number;
    fingerprint: string;
    trustedAt: string | null;
  }> {
    return this.http.json(
      `/harness/projects/${encodeURIComponent(projectId)}/mcp-servers/${encodeURIComponent(serverId)}/launch?${new URLSearchParams(
        Object.entries(options)
          .filter(([, value]) => value !== undefined)
          .map(([key, value]): [string, string] => [key, String(value)]),
      )}`,
    );
  }
  trustMcpServer(
    projectId: string,
    serverId: string,
    fingerprint: string,
    trusted: boolean,
    sessionId?: string,
  ): Promise<{ fingerprint: string; trustedAt: string | null }> {
    return this.http.json(
      `/harness/projects/${encodeURIComponent(projectId)}/mcp-servers/${encodeURIComponent(serverId)}/trust`,
      { method: 'PUT', body: JSON.stringify({ fingerprint, trusted, sessionId }) },
    );
  }
  resources(): Promise<HarnessResourceView[]> {
    return this.http.json('/harness/resources');
  }
  resource(hash: string): Promise<HarnessResourceView> {
    return this.http.json(`/harness/resources/${encodeURIComponent(hash)}`);
  }
  entries(): Promise<HarnessEntryView[]> {
    return this.http.json('/harness/entries');
  }
  saveMcp(
    projectId: string,
    expectedRevision: number,
    operationId: string,
    draft: McpServerDraft,
    serverId?: string,
  ): Promise<ProjectToolConfigRevision> {
    return this.http.json(`/harness/projects/${encodeURIComponent(projectId)}/mcp`, {
      method: 'POST',
      body: JSON.stringify({ expectedRevision, operationId, draft, serverId }),
    });
  }
  removeMcp(
    projectId: string,
    serverId: string,
    expectedRevision: number,
    operationId: string,
    restoreRevision?: number,
  ): Promise<ProjectToolConfigRevision> {
    return this.http.json(
      `/harness/projects/${encodeURIComponent(projectId)}/mcp-servers/${encodeURIComponent(serverId)}/remove`,
      { method: 'POST', body: JSON.stringify({ expectedRevision, operationId, restoreRevision }) },
    );
  }
  mcpHistory(projectId: string): Promise<
    {
      server: RegisteredMcpServer;
      configRevision: number;
      canRestore: boolean;
      fingerprint: string | null;
    }[]
  > {
    return this.http.json(`/harness/projects/${encodeURIComponent(projectId)}/mcp-history`);
  }
  mcpUsages(
    projectId: string,
    serverId: string,
  ): Promise<
    {
      id: string;
      binding: HarnessBindingRef;
      scope: 'personal' | 'project' | 'role';
      name: string;
    }[]
  > {
    return this.http.json(
      `/harness/projects/${encodeURIComponent(projectId)}/mcp-servers/${encodeURIComponent(serverId)}/usages`,
    );
  }
  probeMcp(
    projectId: string,
    serverId: string,
    input: { operationId: string; configRevision: number; fingerprint: string; sessionId?: string },
  ): Promise<McpProbeResult> {
    return this.http.json(
      `/harness/projects/${encodeURIComponent(projectId)}/mcp-servers/${encodeURIComponent(serverId)}/probe`,
      { method: 'POST', body: JSON.stringify(input) },
    );
  }
  cancelMcpProbe(operationId: string): Promise<{ ok: boolean }> {
    return this.http.json(`/harness/mcp-probes/${encodeURIComponent(operationId)}`, {
      method: 'DELETE',
    });
  }
  skillPreview(candidate: SkillKey, baseline?: SkillKey): Promise<SkillUpdatePreview> {
    return this.http.json('/harness/skill-quality/preview', {
      method: 'POST',
      body: JSON.stringify({ candidate, baseline }),
    });
  }
  skillAdoptions(candidate: SkillKey): Promise<SkillAdoption[]> {
    return this.http.json('/harness/skill-quality/adoptions', {
      method: 'POST',
      body: JSON.stringify(candidate),
    });
  }
  skillFile(
    candidate: SkillKey,
    baseline: SkillKey | undefined,
    path: string,
  ): Promise<SkillFileComparison> {
    return this.http.json('/harness/skill-quality/file', {
      method: 'POST',
      body: JSON.stringify({ candidate, baseline, path }),
    });
  }
  skillEvaluations(candidate: SkillKey): Promise<SkillEvaluationView[]> {
    return this.http.json('/harness/skill-quality/history', {
      method: 'POST',
      body: JSON.stringify(candidate),
    });
  }
  evaluateSkill(request: SkillEvaluationRequest): Promise<SkillEvaluationView> {
    return this.http.json('/harness/skill-quality/evaluations', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }
  skillEvaluation(id: string): Promise<SkillEvaluationView> {
    return this.http.json(`/harness/skill-quality/evaluations/${encodeURIComponent(id)}`);
  }
  cancelSkillEvaluation(id: string): Promise<SkillEvaluationView> {
    return this.http.json(`/harness/skill-quality/evaluations/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }
  adoptSkill(request: SkillAdoptRequest): Promise<SkillAdoption> {
    return this.http.json('/harness/skill-quality/adopt', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }
  rollbackSkill(request: SkillRollbackRequest): Promise<HarnessDefault> {
    return this.http.json('/harness/skill-quality/rollback', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }
  readEntry(key: HarnessEntryKey): Promise<{ content: string; hook: ManagedHook | null }> {
    return this.http.json('/harness/entries/read', { method: 'POST', body: JSON.stringify(key) });
  }
  reviewDocument(draft: HarnessDocumentDraft): ReturnType<HarnessApi['review']> {
    return this.http.json('/harness/documents/review', {
      method: 'POST',
      body: JSON.stringify(draft),
    });
  }
  cancelReview(reviewId: string): Promise<{ ok: boolean }> {
    return this.http.json(`/harness/reviews/${encodeURIComponent(reviewId)}`, { method: 'DELETE' });
  }
  archiveEntry(
    key: HarnessEntryKey,
    expectedRevision: number,
    archived: boolean,
    operationId: string,
  ): Promise<HarnessManagementState> {
    return this.http.json('/harness/entries/archive', {
      method: 'PUT',
      body: JSON.stringify({ key, expectedRevision, archived, operationId }),
    });
  }
  profileManagement(): Promise<HarnessProfileView[]> {
    return this.http.json('/harness/profile-management');
  }
  archiveProfile(
    profileId: string,
    expectedRevision: number,
    archived: boolean,
    operationId: string,
  ): Promise<HarnessManagementState> {
    return this.http.json(`/harness/profile-management/${encodeURIComponent(profileId)}`, {
      method: 'PUT',
      body: JSON.stringify({ expectedRevision, archived, operationId }),
    });
  }
  publish(
    input: HarnessPublish,
  ): Promise<{ profile: HarnessProfileRevision; target: HarnessDefault | null }> {
    return this.http.json('/harness/publish', { method: 'POST', body: JSON.stringify(input) });
  }
  projectTools(projectId: string): Promise<ProjectToolConfigRevision | null> {
    return this.http.json(`/harness/projects/${encodeURIComponent(projectId)}/tools`);
  }
  criteriaFiles(
    projectId: string,
    paths: string[],
  ): Promise<ReviewRecipeRevision['criteriaFiles']> {
    return this.http.json(`/harness/projects/${encodeURIComponent(projectId)}/criteria-files`, {
      method: 'POST',
      body: JSON.stringify({ paths }),
    });
  }
  saveProjectTools(
    projectId: string,
    expectedRevision: number,
    config: ProjectToolConfig,
  ): Promise<ProjectToolConfigRevision> {
    return this.http.json(`/harness/projects/${encodeURIComponent(projectId)}/tools`, {
      method: 'PUT',
      body: JSON.stringify({ expectedRevision, config }),
    });
  }
  inspectProjectTool(
    projectId: string,
    kind: 'check' | 'lsp',
    commandId: string,
  ): Promise<{
    command: RegisteredCheck;
    configRevision: number;
    fingerprint: string;
    trustedAt: string | null;
  }> {
    return this.http.json(
      `/harness/projects/${encodeURIComponent(projectId)}/${kind === 'check' ? 'checks' : 'lsp-servers'}/${encodeURIComponent(commandId)}/launch`,
    );
  }
  trustProjectTool(
    projectId: string,
    kind: 'check' | 'lsp',
    commandId: string,
    fingerprint: string,
    trusted: boolean,
  ): Promise<{ fingerprint: string; trustedAt: string | null }> {
    return this.http.json(
      `/harness/projects/${encodeURIComponent(projectId)}/${kind === 'check' ? 'checks' : 'lsp-servers'}/${encodeURIComponent(commandId)}/trust`,
      { method: 'PUT', body: JSON.stringify({ fingerprint, trusted }) },
    );
  }
  profiles(): Promise<HarnessProfileRevision[]> {
    return this.http.json('/harness/profiles');
  }
  profile(binding: HarnessBindingRef): Promise<HarnessProfileRevision> {
    return this.http.json(
      `/harness/profiles/${encodeURIComponent(binding.profileId)}/${binding.revision}`,
    );
  }
  review(
    kind: 'local' | 'package' | 'pi-home' | 'builtin',
    source: string,
  ): Promise<{ reviewId: string; resource: HarnessResource }> {
    return this.http.json('/harness/reviews', {
      method: 'POST',
      body: JSON.stringify(kind === 'pi-home' ? { kind } : { kind, source }),
    });
  }
  install(reviewId: string): Promise<HarnessResourceView> {
    return this.http.json('/harness/resources', {
      method: 'POST',
      body: JSON.stringify({ reviewId }),
    });
  }
  trust(hash: string, trusted: boolean): Promise<HarnessResourceView> {
    return this.http.json(`/harness/resources/${encodeURIComponent(hash)}/trust`, {
      method: 'PUT',
      body: JSON.stringify({ trusted }),
    });
  }
  save(
    profileId: string,
    expectedRevision: number,
    profile: HarnessProfile,
  ): Promise<HarnessProfileRevision> {
    return this.http.json(`/harness/profiles/${encodeURIComponent(profileId)}`, {
      method: 'PUT',
      body: JSON.stringify({ expectedRevision, profile }),
    });
  }
  preview(
    binding: HarnessBindingRef,
    projectId: string,
    runOverride?: HarnessBindingRef,
  ): Promise<HarnessPreview> {
    return this.http.json('/harness/preview', {
      method: 'POST',
      body: JSON.stringify({ binding, projectId, ...(runOverride ? { runOverride } : {}) }),
    });
  }
  default(scope: HarnessDefault['scope'], scopeId: string): Promise<HarnessDefault> {
    return this.http.json(`/harness/defaults/${scope}/${encodeURIComponent(scopeId)}`);
  }
  setDefault(current: HarnessDefault, binding: HarnessBindingRef | null): Promise<HarnessDefault> {
    return this.http.json(
      `/harness/defaults/${current.scope}/${encodeURIComponent(current.scopeId)}`,
      { method: 'PUT', body: JSON.stringify({ expectedRevision: current.revision, binding }) },
    );
  }
}

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
  bindingId: string;
  copyGeneration: number;
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

export type FileBrowseScope = { kind: 'project' | 'session'; id: string };
export interface PathSearchView {
  items: { path: string; kind: 'file' | 'folder' }[];
  truncated: boolean;
}

export interface FileListView {
  files: { path: string; bytes: number }[];
  truncated: boolean;
}

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
  report?: VerificationReport | null;
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

export interface WorktreeCommandView {
  id: string;
  run_id: string;
  state: 'running' | 'completed' | 'failed' | 'cancelled' | 'uncertain';
  cwd: string;
  shellId: string;
  mode?: 'foreground' | 'service';
  command: string | null;
  created_at: string;
  updated_at: string;
}

/** Folders, working copies, changes and checks on the local server (CR-012). */
export class WorkspacesApi {
  private readonly http: Http;

  constructor(options: HttpOptions) {
    this.http = new Http(options);
  }
  commands(sessionId: string): Promise<WorktreeCommandView[]> {
    return this.send(`/sessions/${encodeURIComponent(sessionId)}/processes`);
  }
  commandReport(
    sessionId: string,
    operationId: string,
  ): Promise<import('@corral/contracts').CommandReport> {
    return this.send(
      `/sessions/${encodeURIComponent(sessionId)}/processes/${encodeURIComponent(operationId)}`,
    );
  }
  commandOutput(
    sessionId: string,
    operationId: string,
    offset = 0,
  ): Promise<{ text: string; nextOffset: number; bytes: number; truncated: boolean }> {
    return this.send(
      `/sessions/${encodeURIComponent(sessionId)}/processes/${encodeURIComponent(operationId)}/output?offset=${offset}`,
    );
  }
  stopCommand(
    sessionId: string,
    operationId: string,
  ): Promise<import('@corral/contracts').CommandReport> {
    return this.send(
      `/sessions/${encodeURIComponent(sessionId)}/processes/${encodeURIComponent(operationId)}/stop`,
      'POST',
    );
  }
  previews(sessionId: string): Promise<import('./preview.ts').WorkspacePreview[]> {
    return this.send(`/sessions/${encodeURIComponent(sessionId)}/previews`);
  }
  startPreview(
    sessionId: string,
    input: import('./preview.ts').StartPreviewInput,
  ): Promise<import('./preview.ts').WorkspacePreview> {
    return this.send(`/sessions/${encodeURIComponent(sessionId)}/previews`, 'POST', input);
  }
  stopPreview(sessionId: string, leaseId: string): Promise<void> {
    return this.send(
      `/sessions/${encodeURIComponent(sessionId)}/previews/${encodeURIComponent(leaseId)}`,
      'DELETE',
    );
  }
  uploadImage(
    sessionId: string,
    name: string,
    body: Blob,
    signal?: AbortSignal,
  ): Promise<import('@corral/contracts').ImageAttachment> {
    return this.http.json(
      `/sessions/${encodeURIComponent(sessionId)}/images?${new URLSearchParams({ name })}`,
      { method: 'POST', headers: { 'content-type': 'image/png' }, body, signal },
    );
  }
  imageUrl(sessionId: string, imageId: string): string {
    return `${this.http.baseUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/images/${encodeURIComponent(imageId)}`;
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
  private browsePath(scope: FileBrowseScope) {
    const id = encodeURIComponent(scope.id);
    return scope.kind === 'project' ? `/projects/${id}/workspace` : `/sessions/${id}/worktree`;
  }
  gitStatus(scope: FileBrowseScope): Promise<GitStatus> {
    return this.send(`${this.browsePath(scope)}/git/status`);
  }
  gitDiff(scope: FileBrowseScope, input: GitDiffRequest): Promise<GitDiff> {
    const query = new URLSearchParams({
      target: JSON.stringify(input.target),
      side: input.side,
      path: input.path,
      head: input.head ?? '',
      indexHash: input.indexHash,
    });
    return this.send(`${this.browsePath(scope)}/git/diff?${query}`);
  }
  listFiles(scope: FileBrowseScope, path = ''): Promise<FileListView> {
    return this.send(`${this.browsePath(scope)}/files?${new URLSearchParams({ path })}`);
  }
  /** CR-016: files and folders whose path matches `query`, best first; names only. */
  searchFiles(scope: FileBrowseScope, query: string, limit = 20): Promise<PathSearchView> {
    return this.send(
      `${this.browsePath(scope)}/search?${new URLSearchParams({ q: query, limit: String(limit) })}`,
    );
  }
  readFile(scope: FileBrowseScope, path: string): Promise<{ path: string; content: FileSideView }> {
    return this.send(`${this.browsePath(scope)}/file?${new URLSearchParams({ path })}`);
  }
  readDocument(sessionId: string, path: string): Promise<FileDocument> {
    return this.send(
      `/sessions/${encodeURIComponent(sessionId)}/worktree/document?${new URLSearchParams({ path })}`,
    );
  }
  changeDocument(sessionId: string, command: DocumentCommand): Promise<DocumentOperation> {
    return this.send(
      `/sessions/${encodeURIComponent(sessionId)}/worktree/documents`,
      'POST',
      command,
    );
  }
  documentOperation(sessionId: string, operationId: string): Promise<DocumentOperation> {
    return this.send(
      `/sessions/${encodeURIComponent(sessionId)}/worktree/document-operations/${encodeURIComponent(operationId)}`,
    );
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
  hunks(
    sessionId: string,
    input: import('@corral/contracts').HunkRequest,
  ): Promise<import('@corral/contracts').HunkSet> {
    return this.send(`/sessions/${encodeURIComponent(sessionId)}/hunks/preview`, 'POST', input);
  }
  planHunks(
    sessionId: string,
    input: import('@corral/contracts').HunkPlanRequest,
  ): Promise<CheckpointRestorePlan> {
    return this.send(`/sessions/${encodeURIComponent(sessionId)}/hunks/plan`, 'POST', input);
  }
  branchPreview(
    point: import('@corral/contracts').MessageBranchPoint,
  ): Promise<import('@corral/contracts').MessageBranchPreview> {
    return this.send('/runs/branch/preview', 'POST', point);
  }
  branchMessage(
    request: import('@corral/contracts').MessageBranchRequest,
  ): Promise<StartRunResult & { sessionId: string | null }> {
    return this.send('/runs/branch', 'POST', request);
  }
  messageBranches(
    runId: string,
    artifactId: string,
  ): Promise<{ sessionId: string; runId: string | null; title: string }[]> {
    return this.send(
      `/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}/branches`,
    );
  }
  searchSessions(
    request: import('@corral/contracts').SessionSearchRequest,
  ): Promise<import('@corral/contracts').SessionSearchResult> {
    return this.send('/sessions/search', 'POST', request);
  }
  rebuildSessionSearch(): Promise<null> {
    return this.send('/sessions/search/rebuild', 'POST', {});
  }
  runtimeCheckpoints(runId: string): Promise<import('@corral/contracts').RuntimeCheckpointView[]> {
    return this.send(`/runs/${encodeURIComponent(runId)}/runtime-checkpoints`);
  }
  resumeRuntime(
    request: import('@corral/contracts').ResumeRuntimeRequest,
  ): Promise<StartRunResult> {
    const { sourceRunId, ...body } = request;
    return this.send(`/runs/${encodeURIComponent(sourceRunId)}/resume-runtime`, 'POST', body);
  }
  checkpoints(
    sessionId: string,
  ): Promise<{ checkpoints: FileCheckpoint[]; restores: CheckpointRestore[] }> {
    return this.send(`/sessions/${encodeURIComponent(sessionId)}/checkpoints`);
  }
  captureCheckpoint(
    sessionId: string,
    input: { checkpointId: string; label: string },
  ): Promise<FileCheckpoint> {
    return this.send(`/sessions/${encodeURIComponent(sessionId)}/checkpoints`, 'POST', input);
  }
  pinCheckpoint(sessionId: string, checkpointId: string, pinned: boolean): Promise<null> {
    return this.send(`/sessions/${encodeURIComponent(sessionId)}/checkpoints/pin`, 'POST', {
      checkpointId,
      pinned,
    });
  }
  pruneCheckpoints(sessionId: string): Promise<{ expired: string[] }> {
    return this.send(`/sessions/${encodeURIComponent(sessionId)}/checkpoints/prune`, 'POST', {});
  }
  planCheckpointRestore(
    sessionId: string,
    checkpointId: string,
    manifestHash: string,
  ): Promise<CheckpointRestorePlan> {
    return this.send(`/sessions/${encodeURIComponent(sessionId)}/checkpoints/plan`, 'POST', {
      checkpointId,
      manifestHash,
    });
  }
  restoreCheckpoint(sessionId: string, input: RestoreCheckpoint): Promise<CheckpointRestore> {
    return this.send(
      `/sessions/${encodeURIComponent(sessionId)}/checkpoints/restore`,
      'POST',
      input,
    );
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
  lspProposals(sessionId: string): Promise<LspProposalSummary[]> {
    return this.send(`/sessions/${encodeURIComponent(sessionId)}/lsp-proposals`);
  }
  lspProposal(sessionId: string, id: string): Promise<LspProposal> {
    return this.send(
      `/sessions/${encodeURIComponent(sessionId)}/lsp-proposals/${encodeURIComponent(id)}`,
    );
  }
  applyLspProposal(sessionId: string, id: string, hash: string): Promise<LspProposal> {
    return this.send(
      `/sessions/${encodeURIComponent(sessionId)}/lsp-proposals/${encodeURIComponent(id)}/apply`,
      'POST',
      { hash },
    );
  }
  dismissLspProposal(sessionId: string, id: string, hash: string): Promise<LspProposal> {
    return this.send(
      `/sessions/${encodeURIComponent(sessionId)}/lsp-proposals/${encodeURIComponent(id)}/dismiss`,
      'POST',
      { hash },
    );
  }
  markReviewed(sessionId: string): Promise<null> {
    return this.send(`/sessions/${encodeURIComponent(sessionId)}/reviewed`, 'POST');
  }
  verifications(sessionId: string): Promise<VerificationResultView[]> {
    return this.send(`/sessions/${encodeURIComponent(sessionId)}/verifications`);
  }
  cancelVerification(sessionId: string, verificationId: string): Promise<void> {
    return this.send(
      `/sessions/${encodeURIComponent(sessionId)}/verifications/${encodeURIComponent(verificationId)}/cancel`,
      'POST',
      {},
    );
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
  /** The linked folder as Git sees it: HEAD → working tree, read only (02-UX-Spec §4). */
  folderChanges(projectId: string): Promise<ChangeSetView & { staged: string[] }> {
    return this.send(`/projects/${encodeURIComponent(projectId)}/workspace/changes`);
  }
  folderFileVersions(
    projectId: string,
    path: string,
  ): Promise<{ path: string; before: FileSideView; after: FileSideView }> {
    return this.send(
      `/projects/${encodeURIComponent(projectId)}/workspace/changes/file?path=${encodeURIComponent(path)}`,
    );
  }
  runSnapshots(
    sessionId: string,
  ): Promise<{ runId: string; phase: 'start' | 'end'; tree: string }[]> {
    return this.send(`${this.s(sessionId)}/run-snapshots`);
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
  kind:
    | 'decision'
    | 'queued'
    | 'uncertain_write'
    | 'integration'
    | 'check_failed'
    | 'unreviewed'
    | 'recipe_stopped'
    | 'lsp_proposal';
  sessionId: string;
  sessionTitle: string;
  runId: string | null;
  detail: string | null;
}
