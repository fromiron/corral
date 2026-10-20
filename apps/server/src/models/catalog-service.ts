import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

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
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('Catalog exceeds size limit.');
  const data = record(JSON.parse(text));
  const models: ModelMetadata[] = [];
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
      if (models.length > 30000) throw new Error('Catalog contains too many models.');
    }
  }
  if (!models.length) throw new Error('Catalog has no valid model metadata.');
  return models;
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
      const models = parseCatalog(saved.body);
      const hash = createHash('sha256').update(saved.body).digest('hex');
      if (saved.hash !== hash) return;
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
      const models = parseCatalog(body);
      const hash = createHash('sha256').update(body).digest('hex');
      const fetchedAt = new Date(this.now()).toISOString();
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.tmp`;
      writeFileSync(temporary, JSON.stringify({ version: 1, hash, fetchedAt, body }), {
        mode: 0o600,
      });
      renameSync(temporary, this.file);
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
