import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { type Clock, canonicalJson, WebSourceEvidence } from '@corral/contracts';
import type { Db } from '@corral/storage-sqlite';
import { z } from 'zod';
import {
  InputError,
  MAX_INPUT_BYTES,
  type Network,
  readHttps,
  resolvePublic,
  sourceUrl,
  systemNetwork,
} from './safe-http.ts';
import { extractHtml } from './web-extraction.ts';

const DocumentInput = z.strictObject({
  title: z.string().trim().min(1).max(200),
  mimeType: z.enum(['text/plain', 'text/markdown']),
  text: z.string().min(1),
});
const SourceInput = z.strictObject({ url: z.string().min(1).max(4096) });
export const ImportInput = z.union([DocumentInput, SourceInput]);
const ReadInput = z.union([
  z.strictObject({ documentId: z.string().regex(/^doc_[a-f0-9]{64}$/) }),
  z.strictObject({ sourceId: z.string().regex(/^src_[a-f0-9]{64}$/) }),
]);
const SearchInput = z.strictObject({
  query: z.string().trim().min(1).max(500),
  provider: z.enum(['corpus', 'brave']).default('corpus'),
  limit: z.int().min(1).max(10).default(5),
});
interface InputRow {
  id: string;
  kind: 'document' | 'source';
  title: string;
  mime_type: string;
  text: string;
  url: string | null;
}
export interface LiveSearch {
  enabled: true;
  /** Server memory only. Never copied into workspace config, logs or events. */
  apiKey(): string | undefined;
  /** Total external searches allowed during this server session, including failed attempts. */
  maxRequests: number;
}
export interface InputOptions {
  network?: Network;
  clock?: Pick<Clock, 'nowIso'>;
  liveSearch?: LiveSearch;
}
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const parse = <T>(schema: z.ZodType<T>, input: unknown): T => {
  const result = schema.safeParse(input);
  if (!result.success) throw new InputError('invalid input tool arguments');
  return result.data;
};

/** Immutable registered input IDs; tools never accept filesystem paths or raw URLs. */
export class InputRegistry {
  private readonly db: Db;
  private readonly network: Network;
  private readonly liveSearch: LiveSearch | undefined;
  private searched = 0;
  private readonly clock: Pick<Clock, 'nowIso'>;
  constructor(db: Db, options: InputOptions = {}) {
    this.db = db;
    this.network = options.network ?? systemNetwork;
    this.liveSearch = options.liveSearch;
    this.clock = options.clock ?? { nowIso: () => new Date().toISOString() };
    if (
      this.liveSearch &&
      (!Number.isInteger(this.liveSearch.maxRequests) ||
        this.liveSearch.maxRequests < 1 ||
        this.liveSearch.maxRequests > 100)
    ) {
      throw new InputError('live search request limit must be 1..100');
    }
  }
  list() {
    return (
      this.db
        .prepare(
          'SELECT id, kind, title, mime_type, length(CAST(text AS BLOB)) AS bytes FROM imported_inputs ORDER BY id',
        )
        .all() as (Pick<InputRow, 'id' | 'kind' | 'title' | 'mime_type'> & { bytes: number })[]
    ).map(({ id, kind, title, mime_type, bytes }) => ({
      id,
      kind,
      title,
      mimeType: mime_type,
      bytes,
    }));
  }
  importDocument(input: unknown) {
    const document = parse(DocumentInput, input);
    if (Buffer.byteLength(document.text) > MAX_INPUT_BYTES || document.text.includes('\u0000'))
      throw new InputError('document must be text of at most 1 MiB');
    const documentId = `doc_${hash(JSON.stringify(document))}`;
    this.insert({
      id: documentId,
      kind: 'document',
      title: document.title,
      mime_type: document.mimeType,
      text: document.text,
      url: null,
    });
    return { documentId, ...document };
  }
  async importSource(input: unknown, signal = AbortSignal.timeout(30_000)) {
    const url = sourceUrl(parse(SourceInput, input).url);
    await resolvePublic(url, this.network, signal);
    signal.throwIfAborted();
    const sourceId = `src_${hash(url.href)}`;
    this.insert({
      id: sourceId,
      kind: 'source',
      title: url.hostname,
      mime_type: '',
      text: '',
      url: url.href,
    });
    return { sourceId, title: url.hostname };
  }
  private insert(row: InputRow, rawBytes = 0) {
    if (this.db.prepare('SELECT id FROM imported_inputs WHERE id = ?').get(row.id)) return;
    this.db.transaction(() => {
      const usage = this.db
        .prepare(
          'SELECT count(*) AS count, coalesce(sum(length(CAST(text AS BLOB))), 0) + (SELECT coalesce(sum(length(raw_body)), 0) FROM web_source_evidence) AS bytes FROM imported_inputs',
        )
        .get() as { count: number; bytes: number };
      if (
        usage.count >= 1000 ||
        usage.bytes + Buffer.byteLength(row.text) + rawBytes > 32 * MAX_INPUT_BYTES
      )
        throw new InputError('workspace input capacity reached');
      this.db
        .prepare(
          'INSERT INTO imported_inputs(id, kind, title, mime_type, text, url) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(row.id, row.kind, row.title, row.mime_type, row.text, row.url);
    })();
  }
  async read(
    input: unknown,
    mode: 'mock' | 'live',
    signal = AbortSignal.timeout(30_000),
  ): Promise<Record<string, unknown>> {
    const ref = parse(ReadInput, input);
    const id = 'documentId' in ref ? ref.documentId : ref.sourceId;
    const row = this.db.prepare('SELECT * FROM imported_inputs WHERE id = ?').get(id) as
      | InputRow
      | undefined;
    if (!row) throw new InputError('input is not registered');
    signal.throwIfAborted();
    if (row.kind === 'document') {
      const source = this.sourceEvidence(id)?.metadata;
      return {
        documentId: id,
        title: row.title,
        mimeType: row.mime_type,
        text: row.text,
        ...(source ? { sourceId: source.sourceId, source } : {}),
      };
    }
    if (mode !== 'live') throw new InputError('mock runs read imported documents only');
    const loaded = await readHttps(row.url ?? '', { network: this.network, signal, html: true });
    const extracted =
      loaded.mimeType === 'text/html' ? await extractHtml(loaded.text, signal) : null;
    signal.throwIfAborted();
    const document = parse(DocumentInput, {
      title: extracted?.title || row.title.slice(0, 200),
      mimeType: extracted ? 'text/plain' : loaded.mimeType,
      text: extracted?.text ?? loaded.text,
    });
    const source = WebSourceEvidence.parse({
      version: 1,
      sourceId: id,
      originalUrl: row.url,
      finalUrl: loaded.finalUrl,
      fetchedAt: this.clock.nowIso(),
      rawMime: loaded.mimeType,
      rawHash: hash(loaded.rawBody),
      contentHash: hash(document.text),
      rawBytes: loaded.rawBody.length,
      requests: loaded.requests,
      extractor: extracted ? 'corral-html-1/parse5-8.0.1' : 'corral-text-1',
      publishedAt: extracted?.publishedAt ?? null,
      modifiedAt: extracted?.modifiedAt ?? null,
      lastModified: loaded.lastModified,
      trust: 'untrusted',
    });
    const documentId = `doc_${hash(canonicalJson({ document, source }))}`;
    this.db.transaction(() => {
      this.insert(
        {
          id: documentId,
          kind: 'document',
          title: document.title,
          mime_type: document.mimeType,
          text: document.text,
          url: null,
        },
        loaded.rawBody.length,
      );
      this.db
        .prepare(
          'INSERT OR IGNORE INTO web_source_evidence(document_id, metadata_json, raw_body) VALUES (?, ?, ?)',
        )
        .run(documentId, canonicalJson(source), loaded.rawBody);
    })();
    return { sourceId: id, documentId, ...document, source };
  }
  sourceEvidence(documentId: string) {
    if (!/^doc_[a-f0-9]{64}$/.test(documentId)) throw new InputError('invalid document ID');
    const row = this.db
      .prepare('SELECT metadata_json, raw_body FROM web_source_evidence WHERE document_id = ?')
      .get(documentId) as { metadata_json: string; raw_body: Uint8Array } | undefined;
    if (!row) return null;
    const metadata = WebSourceEvidence.parse(JSON.parse(row.metadata_json));
    if (hash(row.raw_body) !== metadata.rawHash || row.raw_body.length !== metadata.rawBytes)
      throw new InputError('source evidence integrity check failed');
    return {
      metadata,
      rawText: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(row.raw_body),
    };
  }
  async search(
    input: unknown,
    mode: 'mock' | 'live',
    signal = AbortSignal.timeout(30_000),
  ): Promise<Record<string, unknown>> {
    const { query, provider, limit } = parse(SearchInput, input);
    signal.throwIfAborted();
    if (provider === 'corpus') {
      const terms = [...new Set(query.toLocaleLowerCase().split(/\s+/))];
      const rows = this.db
        .prepare("SELECT * FROM imported_inputs WHERE kind = 'document' ORDER BY id")
        .all() as InputRow[];
      const scored = [];
      for (const row of rows) {
        const text = `${row.title}\n${row.text}`.toLocaleLowerCase();
        scored.push({ row, score: terms.filter((term) => text.includes(term)).length });
        // Let control requests and cancellation run between bounded document scans.
        await setImmediate(undefined, { signal });
      }
      const results = scored
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score || a.row.id.localeCompare(b.row.id))
        .slice(0, limit)
        .map(({ row }) => ({
          documentId: row.id,
          title: row.title,
          snippet: row.text.slice(0, 500),
        }));
      return { provider, results };
    }
    const config = this.liveSearch;
    if (mode !== 'live' || !config?.enabled)
      throw new InputError('Brave search requires explicit live search opt-in');
    const key = config.apiKey();
    if (!key) throw new InputError('Brave search is not configured');
    if (this.searched >= config.maxRequests)
      throw new InputError('live search request limit reached');
    this.searched++;
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(limit));
    const response = await readHttps(url.href, {
      network: this.network,
      signal,
      json: true,
      headers: { accept: 'application/json', 'x-subscription-token': key },
    });
    let json: unknown;
    try {
      json = JSON.parse(response.text);
    } catch {
      throw new InputError('invalid search response');
    }
    const parsed = z
      .object({
        web: z
          .object({
            results: z
              .array(
                z.object({
                  title: z.string().max(500),
                  url: z.string().max(4096),
                  description: z.string().max(10_000).optional(),
                }),
              )
              .max(20),
          })
          .optional(),
      })
      .safeParse(json);
    if (!parsed.success) throw new InputError('invalid search response');
    const results = [];
    for (const item of (parsed.data.web?.results ?? []).slice(0, limit)) {
      signal.throwIfAborted();
      try {
        const source = await this.importSource({ url: item.url }, signal);
        results.push({
          ...source,
          title: item.title,
          snippet: item.description?.slice(0, 500) ?? '',
        });
      } catch (error) {
        if (signal.aborted || !(error instanceof InputError)) throw error;
      }
    }
    return { provider, results };
  }
  async execute(
    input: {
      name: 'search' | 'read_document';
      args: Record<string, unknown>;
      mode: 'mock' | 'live';
    },
    cancellation: { readonly aborted: boolean; onCancel(fn: () => void): () => void },
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
    const off = cancellation.onCancel(() => controller.abort());
    if (cancellation.aborted) controller.abort();
    try {
      return input.name === 'search'
        ? await this.search(input.args, input.mode, signal)
        : await this.read(input.args, input.mode, signal);
    } finally {
      off();
    }
  }
}
