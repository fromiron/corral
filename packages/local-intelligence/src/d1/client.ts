// HTTP to the managed llama-server on loopback. Every call but the health probe carries the
// instance's key. Responses are read with a size cap; nothing here logs a body.

export interface D1Endpoint {
  base: string;
  key: string;
}

const MAX_BODY = 1 << 20;

export class D1HttpError extends Error {
  readonly status: number;
  constructor(what: string, status: number) {
    super(`${what} returned HTTP ${status}`);
    this.status = status;
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('the Local runtime returned no body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.length;
      if (length > MAX_BODY) throw new Error('the Local runtime response is too large');
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const auth = (endpoint: D1Endpoint) => ({
  Authorization: `Bearer ${endpoint.key}`,
  'Content-Type': 'application/json',
});

/** Tokens in `text` with the model's tokenizer; the signal also ends a stalled body. */
export async function tokenize(
  endpoint: D1Endpoint,
  text: string,
  signal: AbortSignal,
): Promise<number> {
  const response = await fetch(`${endpoint.base}/tokenize`, {
    method: 'POST',
    headers: auth(endpoint),
    body: JSON.stringify({ content: text, add_special: false, parse_special: true }),
    signal,
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new D1HttpError('tokenize', response.status);
  }
  const tokens = ((await boundedJson(response)) as { tokens?: unknown } | null)?.tokens;
  if (!Array.isArray(tokens)) throw new Error('tokenize returned no tokens');
  return tokens.length;
}

/** What an unauthenticated tokenize gets: a build that answers it ignores its key. */
export async function unauthenticatedStatus(base: string, signal: AbortSignal): Promise<number> {
  const response = await fetch(`${base}/tokenize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'a', add_special: false, parse_special: true }),
    signal,
  });
  await response.body?.cancel().catch(() => {});
  return response.status;
}

export async function healthStatus(base: string, signal: AbortSignal): Promise<number> {
  const response = await fetch(`${base}/health`, { signal });
  await response.body?.cancel().catch(() => {});
  return response.status;
}

export interface LoadedModel {
  decisions: boolean;
  size: number | null;
  params: number | null;
}

/** What the server says it loaded: whether it answers decisions, and the tensor size. */
export async function loadedModel(endpoint: D1Endpoint, signal: AbortSignal): Promise<LoadedModel> {
  const response = await fetch(`${endpoint.base}/v1/models`, { headers: auth(endpoint), signal });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new D1HttpError('models', response.status);
  }
  const raw = (await boundedJson(response)) as {
    data?: {
      architecture?: { output_modalities?: unknown };
      meta?: { size?: unknown; n_params?: unknown };
    }[];
  } | null;
  const first = raw?.data?.[0];
  const modalities = first?.architecture?.output_modalities;
  const number = (value: unknown) => (Number.isSafeInteger(value) ? Number(value) : null);
  return {
    decisions: Array.isArray(modalities) && modalities.includes('decisions'),
    size: number(first?.meta?.size),
    params: number(first?.meta?.n_params),
  };
}

export interface SystemOneAnswer {
  choice: unknown;
  probabilities: unknown;
  inputTokens: unknown;
}

/**
 * One System One call, read to the end: the answer, or null for a complete response Corral
 * cannot read. It has no caller signal: a caller that stops waiting leaves it running, and only
 * the owner ending the child stops it. HTTP errors and broken connections throw.
 */
export async function systemOne(
  endpoint: D1Endpoint,
  body: unknown,
): Promise<SystemOneAnswer | null> {
  const response = await fetch(`${endpoint.base}/v1/systemone`, {
    method: 'POST',
    headers: auth(endpoint),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new D1HttpError('System One', response.status);
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.length;
    // The server already finished; an oversized answer is complete and unusable.
    if (length > MAX_BODY) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(next.value);
  }
  let raw: {
    answers?: { effort?: { choice?: unknown; probabilities?: unknown } };
    usage?: { input_tokens?: unknown };
  } | null;
  try {
    raw = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
  return {
    choice: raw?.answers?.effort?.choice,
    probabilities: raw?.answers?.effort?.probabilities,
    inputTokens: raw?.usage?.input_tokens,
  };
}
