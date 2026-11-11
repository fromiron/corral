import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { ensurePrivateDirectory } from '../private-files.ts';
import { type EndpointProbeResult, probeKind } from './endpoint-probe.ts';

// The model list of an added OpenAI-compatible endpoint (features/model-connections.md,
// 엔드포인트 모델 가져오기). One GET to the saved address's `/models`, never a caller's URL,
// with the key bound to that origin only and no redirects. Only the listed fields are read;
// the cache keeps, by address, the time and each model's id, limits and abilities.

export const ENDPOINT_MODEL_LIMITS = {
  timeoutMs: 10_000,
  maxBytes: 2 * 1024 * 1024,
  maxModels: 2_000,
} as const;

/** Limits and abilities of one model, as far as one source knows them. */
export interface ModelValues {
  contextWindow?: number;
  maxOutput?: number;
  reasoning?: boolean;
  imageInput?: boolean;
}

export interface FetchedModel extends ModelValues {
  id: string;
}

export interface EndpointFetchResult {
  kind: EndpointProbeResult['kind'];
  status: number | null;
  /** The list, only when it was read in full and within the limits. */
  models: FetchedModel[] | null;
}

const CONTEXT_MAX = 10_000_000;
const OUTPUT_MAX = 1_000_000;

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const limit = (max: number, ...values: unknown[]) => {
  const valid = values.filter(
    (value): value is number =>
      Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= max,
  );
  return valid.length ? Math.min(...valid) : undefined;
};

/** The models of a `/models` answer; throws when it is not a list Corral reads. */
export function parseModelList(text: string): FetchedModel[] {
  const data = record(JSON.parse(text)).data;
  if (!Array.isArray(data)) throw new Error('no model list');
  if (data.length > ENDPOINT_MODEL_LIMITS.maxModels) throw new Error('too many models');
  const models = new Map<string, FetchedModel>();
  for (const raw of data) {
    const entry = record(raw);
    const id = entry.id;
    if (typeof id !== 'string' || id.length < 1 || id.length > 200 || models.has(id)) continue;
    const parameters = entry.supported_parameters;
    const modalities = record(entry.architecture).input_modalities;
    const contextWindow = limit(CONTEXT_MAX, entry.context_length, entry.context_window);
    const maxOutput = limit(
      OUTPUT_MAX,
      record(entry.top_provider).max_completion_tokens,
      entry.max_output_tokens,
    );
    models.set(id, {
      id,
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(maxOutput !== undefined ? { maxOutput } : {}),
      ...(Array.isArray(parameters)
        ? { reasoning: parameters.includes('reasoning') || parameters.includes('reasoning_effort') }
        : {}),
      ...(Array.isArray(modalities) ? { imageInput: modalities.includes('image') } : {}),
    });
  }
  return [...models.values()];
}

async function readLimited(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('response too large');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) throw new Error('response too large');
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** One GET of `<baseUrl>/models`; the body is read, parsed and dropped. */
export async function fetchEndpointModels(options: {
  baseUrl: string;
  apiKey?: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<EndpointFetchResult> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? ENDPOINT_MODEL_LIMITS.timeoutMs);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(`${options.baseUrl.replace(/\/+$/, '')}/models`, {
      method: 'GET',
      redirect: 'manual',
      signal,
      headers: options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {},
    });
  } catch {
    return { kind: 'connection', status: null, models: null };
  }
  const status = response.status;
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    return { kind: probeKind(status), status, models: null };
  }
  let text: string;
  try {
    text = await readLimited(response, ENDPOINT_MODEL_LIMITS.maxBytes);
  } catch {
    return {
      kind: signal.aborted ? 'connection' : 'unsupported',
      status: signal.aborted ? null : status,
      models: null,
    };
  }
  try {
    return { kind: 'connected', status, models: parseModelList(text) };
  } catch {
    return { kind: 'unsupported', status, models: null };
  }
}

const Values = z.strictObject({
  contextWindow: z.int().min(1).max(CONTEXT_MAX).optional(),
  maxOutput: z.int().min(1).max(OUTPUT_MAX).optional(),
  reasoning: z.boolean().optional(),
  imageInput: z.boolean().optional(),
});
const CachedEndpointSchema = z.strictObject({
  fetchedAt: z.iso.datetime(),
  models: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(200),
        /** What `/models` said. */
        response: Values,
        /** What models.dev said for the same id when the list was fetched. */
        catalog: Values,
      }),
    )
    .max(ENDPOINT_MODEL_LIMITS.maxModels),
});
export type CachedEndpoint = z.infer<typeof CachedEndpointSchema>;
/** Lists by the address they were fetched from; a file in an earlier shape is no cache. */
const CacheFile = z.strictObject({
  version: z.literal(2),
  endpoints: z.record(z.string().min(1).max(600), CachedEndpointSchema),
});

/** The address a list belongs to: the saved base URL, as its `/models` request is built. */
export function endpointAddress(baseUrl: string): string {
  return new URL(baseUrl).href.replace(/\/+$/, '');
}

/** Where an endpoint's last fetched list is read from, by the endpoint's saved base URL. */
export interface EndpointModelSource {
  read(baseUrl: string): CachedEndpoint | null;
}

/**
 * Fetched endpoint lists in the user's config directory, outside the workspace and apart from
 * the credentials file. Read when the server starts; a list belongs to the address it was
 * fetched from, whatever endpoint id names that address, and is not used for another. A write
 * merges its one entry into the file's current content, so lists other servers wrote stay.
 */
export class EndpointModelCache implements EndpointModelSource {
  private readonly file: string;
  private entries: Record<string, CachedEndpoint>;

  constructor(file: string) {
    this.file = file;
    this.entries = this.load();
  }

  private load(): Record<string, CachedEndpoint> {
    try {
      if (!existsSync(this.file) || statSync(this.file).size > 16 * 1024 * 1024) return {};
      const parsed = CacheFile.safeParse(JSON.parse(readFileSync(this.file, 'utf8')));
      return parsed.success ? parsed.data.endpoints : {};
    } catch {
      /* An unreadable cache is no cache; the next fetch writes a new one. */
      return {};
    }
  }

  read(baseUrl: string): CachedEndpoint | null {
    const address = endpointAddress(baseUrl);
    return Object.hasOwn(this.entries, address) ? (this.entries[address] ?? null) : null;
  }

  write(baseUrl: string, entry: CachedEndpoint) {
    const parsed = CachedEndpointSchema.parse(entry);
    const next = { ...this.load(), [endpointAddress(baseUrl)]: parsed };
    // Kept in use until the server stops even if the file cannot be written.
    this.entries = next;
    ensurePrivateDirectory(dirname(this.file));
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 2, endpoints: next }), {
      mode: 0o600,
      flag: 'wx',
    });
    renameSync(temporary, this.file);
  }
}
