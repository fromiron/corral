import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ModelValues } from './endpoint-models.ts';

export interface ModelMetadata {
  provider: string;
  id: string;
  name: string;
  inputCost?: number;
  outputCost?: number;
  contextWindow?: number;
}
export interface CatalogMetadataView {
  source: 'models.dev';
  version: 1;
  hash: string | null;
  fetchedAt: string | null;
  stale: boolean;
  error: string | null;
  models: ModelMetadata[];
}
const MAX_BYTES = 20 * 1024 * 1024;
const STALE_MS = 24 * 60 * 60 * 1000;
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const finite = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

export function parseCatalog(text: string): ModelMetadata[] {
  return parseEntries(text).models;
}

/** A limit in the range a model definition accepts; anything else is not a stated limit. */
const bounded = (value: unknown, max: number) =>
  Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= max
    ? Number(value)
    : undefined;

/**
 * The view's metadata plus, per model id, the limits and abilities models.dev states. Only
 * endpoint models matched by id use the second (features/model-connections.md).
 */
function parseEntries(text: string) {
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('Catalog exceeds size limit.');
  const data = record(JSON.parse(text));
  const models: ModelMetadata[] = [];
  const values = new Map<string, ModelValues[]>();
  for (const [provider, raw] of Object.entries(data)) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(provider)) continue;
    for (const [id, rawModel] of Object.entries(record(record(raw).models))) {
      const model = record(rawModel);
      if (!id || id.length > 200 || typeof model.name !== 'string' || model.name.length > 200)
        continue;
      const cost = record(model.cost);
      const limit = record(model.limit);
      const inputCost = finite(cost.input);
      const outputCost = finite(cost.output);
      const contextWindow = finite(limit.context);
      models.push({
        provider,
        id,
        name: model.name,
        ...(inputCost !== undefined ? { inputCost } : {}),
        ...(outputCost !== undefined ? { outputCost } : {}),
        ...(contextWindow !== undefined ? { contextWindow } : {}),
      });
      const input = record(model.modalities).input;
      const context = bounded(limit.context, 10_000_000);
      const output = bounded(limit.output, 1_000_000);
      values.set(id, [
        ...(values.get(id) ?? []),
        {
          ...(context !== undefined ? { contextWindow: context } : {}),
          ...(output !== undefined ? { maxOutput: output } : {}),
          reasoning: model.reasoning === true,
          imageInput: Array.isArray(input) && input.includes('image'),
        },
      ]);
      if (models.length > 30000) throw new Error('Catalog contains too many models.');
    }
  }
  if (!models.length) throw new Error('Catalog has no valid model metadata.');
  return { models, values };
}

/** Metadata never registers a model or changes capabilities, profiles or pinned Run snapshots. */
export class ModelCatalogService {
  private readonly file: string;
  private readonly request: typeof fetch;
  private readonly now: () => number;
  private snapshot: CatalogMetadataView = {
    source: 'models.dev',
    version: 1,
    hash: null,
    fetchedAt: null,
    stale: true,
    error: null,
    models: [],
  };
  private pending: Promise<CatalogMetadataView> | undefined;
  private values = new Map<string, ModelValues[]>();
  constructor(file: string, request: typeof fetch = fetch, now = Date.now) {
    this.file = file;
    this.request = request;
    this.now = now;
    try {
      const stat = statSync(file);
      if (!stat.isFile() || stat.size > MAX_BYTES * 2 + 4096) return;
      const text = readFileSync(file, 'utf8');
      if (Buffer.byteLength(text) > MAX_BYTES * 2 + 4096) return;
      const saved = JSON.parse(text);
      if (
        saved.version !== 1 ||
        typeof saved.body !== 'string' ||
        !Number.isFinite(Date.parse(saved.fetchedAt))
      )
        return;
      const { models, values } = parseEntries(saved.body);
      const hash = createHash('sha256').update(saved.body).digest('hex');
      if (saved.hash !== hash) return;
      this.values = values;
      this.snapshot = {
        source: 'models.dev',
        version: 1,
        hash,
        fetchedAt: saved.fetchedAt,
        stale: false,
        error: null,
        models,
      };
    } catch {
      /* Empty/corrupt cache is explicitly unavailable until refresh. */
    }
  }
  view(): CatalogMetadataView {
    return {
      ...this.snapshot,
      stale:
        !this.snapshot.fetchedAt || this.now() - Date.parse(this.snapshot.fetchedAt) >= STALE_MS,
    };
  }
  /**
   * models.dev's values for an endpoint model: entries with the same id, or with the id less its
   * `vendor/` prefix. Several entries give the smallest limit and only the abilities all share.
   */
  match(modelId: string): ModelValues {
    const slash = modelId.indexOf('/');
    const candidates = [
      ...(this.values.get(modelId) ?? []),
      ...(slash >= 0 ? (this.values.get(modelId.slice(slash + 1)) ?? []) : []),
    ];
    if (!candidates.length) return {};
    const smallest = (key: 'contextWindow' | 'maxOutput') => {
      const known = candidates.flatMap((entry) => (entry[key] === undefined ? [] : [entry[key]]));
      return known.length ? Math.min(...known) : undefined;
    };
    const contextWindow = smallest('contextWindow');
    const maxOutput = smallest('maxOutput');
    return {
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(maxOutput !== undefined ? { maxOutput } : {}),
      reasoning: candidates.every((entry) => entry.reasoning === true),
      imageInput: candidates.every((entry) => entry.imageInput === true),
    };
  }
  refresh() {
    if (this.pending) return this.pending;
    this.pending = this.load().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  private async load() {
    try {
      const response = await this.request('https://models.dev/api.json', {
        signal: AbortSignal.timeout(15000),
        redirect: 'error',
      });
      if (!response.ok || !response.body) throw new Error();
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > MAX_BYTES) throw new Error();
          chunks.push(next.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      const body = Buffer.concat(chunks).toString('utf8');
      const { models, values } = parseEntries(body);
      const hash = createHash('sha256').update(body).digest('hex');
      const fetchedAt = new Date(this.now()).toISOString();
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.tmp`;
      writeFileSync(temporary, JSON.stringify({ version: 1, hash, fetchedAt, body }), {
        mode: 0o600,
      });
      renameSync(temporary, this.file);
      this.values = values;
      this.snapshot = {
        source: 'models.dev',
        version: 1,
        hash,
        fetchedAt,
        stale: false,
        error: null,
        models,
      };
    } catch {
      this.snapshot = {
        ...this.snapshot,
        error: 'Catalog refresh failed; showing the last verified cache if available.',
      };
    }
    return this.view();
  }
}
