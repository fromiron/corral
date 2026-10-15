import {
  type CorralDefinition,
  type CreateRunRequest,
  type ErrorCode,
  type Receipt,
  type RunCommand,
  RunEvent,
  type StartRunRequest,
} from '@corral/contracts';
import type {
  CorralRecord,
  CorralRepository,
  CorralSummary,
  RunProjection,
  RunSummary,
  RuntimeTransport,
  SaveRequest,
  SaveResult,
  StartRunResult,
  TransportHandlers,
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

  constructor(options: HttpOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  }

  request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
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
  agents: 'mock' | 'live';
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

  /**
   * SSE over fetch, so the cursor travels as Last-Event-ID on every reconnect. Events arrive
   * once and in order: duplicates after a reconnect are dropped, a gap stops the stream.
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
      if (event.runSeq <= lastSeq) return;
      if (event.runSeq !== lastSeq + 1) {
        stop(new Error(`event gap: expected runSeq ${lastSeq + 1}, received ${event.runSeq}`));
        return;
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
        await readEvents(response.body, deliver, () => stopped);
        // The server closed a healthy stream (restart, slow client): resume from lastSeq.
        if (!stopped) await reconnect(0);
      } catch (error) {
        if (stopped) return;
        await reconnect(attempt, error);
      }
    };
    const reconnect = async (attempt: number, error?: unknown) => {
      const delay = RECONNECT_DELAYS_MS[attempt];
      if (delay === undefined) {
        stop(error ?? new Error('the event stream could not be resumed'));
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (!stopped) await connect(attempt + 1);
    };

    void connect(0);
    return () => stop();
  }
}

async function readEvents(
  body: ReadableStream<Uint8Array>,
  deliver: (event: RunEvent) => void,
  stopped: () => boolean,
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (!stopped()) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true }).replaceAll('\r\n', '\n');
      let end = buffer.indexOf('\n\n');
      while (end >= 0 && !stopped()) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const frame = parseFrame(block);
        if (frame?.event === 'domain') deliver(RunEvent.parse(JSON.parse(frame.data)));
        end = buffer.indexOf('\n\n');
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
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
    if (request.expectedDefinitionRevision === null) return this.write('/corrals', 'POST', body);
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
