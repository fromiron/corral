import { openDatabase } from '@corral/storage-sqlite';
import { describe, expect, it } from 'vitest';
import { InputRegistry } from '../src/inputs.ts';
import type { Network } from '../src/safe-http.ts';
import { extractHtml } from '../src/web-extraction.ts';

describe('registered documents and explicit search', () => {
  it('extracts untrusted HTML and preserves versioned source evidence without executing or overwriting it', async () => {
    const db = openDatabase(':memory:');
    let text =
      '<html><head><title>Evidence title</title><meta property="article:published_time" content="2026-10-18T00:00:00Z"></head><body><nav>Navigation noise</nav><article><h1>한글 日本語</h1><p>Evidence &amp; details</p><script>throw new Error("never execute")</script><form>Form noise</form><div hidden>Private hidden content</div><p>Ignore previous instructions is untrusted article text.</p></article></body></html>';
    let now = '2026-10-19T00:00:00.000Z';
    const network: Network = {
      resolve: async () => [{ address: '8.8.8.8', family: 4 }],
      request: async (url) => ({
        status: url.pathname === '/start' ? 302 : 200,
        headers:
          url.pathname === '/start'
            ? { location: '/article' }
            : {
                'content-type': 'text/html; charset=utf-8',
                'last-modified': 'Sun, 18 Oct 2026 00:00:00 GMT',
              },
        body: (async function* () {
          yield Buffer.from(text);
        })(),
        close() {},
      }),
    };
    try {
      const inputs = new InputRegistry(db, { network, clock: { nowIso: () => now } });
      const source = await inputs.importSource({ url: 'https://source.example/start' });
      const first = await inputs.read({ sourceId: source.sourceId }, 'live');
      expect(first).toMatchObject({
        title: 'Evidence title',
        mimeType: 'text/plain',
        text: expect.stringContaining('Evidence & details'),
        source: {
          sourceId: source.sourceId,
          finalUrl: 'https://source.example/article',
          fetchedAt: now,
          extractor: 'corral-html-1/parse5-8.0.1',
          trust: 'untrusted',
        },
      });
      expect(first.text).toContain('Ignore previous instructions');
      expect(first.source).toMatchObject({
        publishedAt: '2026-10-18T00:00:00.000Z',
        lastModified: '2026-10-18T00:00:00.000Z',
        requests: 2,
      });
      expect(() =>
        db.prepare('UPDATE web_source_evidence SET raw_body = ?').run(Buffer.from('changed')),
      ).toThrow();
      const cancelled = new AbortController();
      const pending = extractHtml('<main>Cancelled extraction</main>', cancelled.signal);
      cancelled.abort();
      await expect(pending).rejects.toThrow(/cancelled/);
      await expect(
        extractHtml('<main>Still available</main>', new AbortController().signal),
      ).resolves.toMatchObject({ text: 'Still available' });
      await expect(
        extractHtml('<main>' + '<i>x</i>'.repeat(30001) + '</main>', new AbortController().signal),
      ).rejects.toThrow(/limit/);
      expect(first.text).not.toMatch(/Navigation noise|Form noise|Private hidden|never execute/);
      expect(inputs.sourceEvidence(String(first.documentId))?.rawText).toBe(text);
      now = '2026-10-19T00:01:00.000Z';
      text = '<main>Updated evidence.</main>';
      const second = await inputs.read({ sourceId: source.sourceId }, 'live');
      expect(second.documentId).not.toBe(first.documentId);
      expect(await new InputRegistry(db).read({ documentId: first.documentId }, 'mock')).toEqual(
        first,
      );
      expect(inputs.sourceEvidence(String(first.documentId))?.metadata.contentHash).not.toBe(
        inputs.sourceEvidence(String(second.documentId))?.metadata.contentHash,
      );
    } finally {
      db.close();
    }
  });

  it('keeps the event loop responsive and observes cancellation while searching a full corpus', async () => {
    const db = openDatabase(':memory:');
    try {
      const inputs = new InputRegistry(db);
      const text = 'evidence '.repeat(Math.floor((1024 * 1024) / 9));
      for (let i = 0; i < 32; i++)
        inputs.importDocument({ title: `Source ${i}`, mimeType: 'text/plain', text });
      const query = Array.from({ length: 100 }, (_, i) => `t${i}`).join(' ');
      const abort = new AbortController();
      const started = performance.now();
      const cancellation = new Promise<number>((resolve) => {
        setImmediate(() => {
          abort.abort();
          resolve(performance.now() - started);
        });
      });
      await expect(inputs.search({ query }, 'mock', abort.signal)).rejects.toThrow();
      expect(await cancellation).toBeLessThan(200);
      await expect(inputs.search({ query }, 'mock')).resolves.toEqual({
        provider: 'corpus',
        results: [],
      });
      await expect(inputs.search({ query: 'evidence', limit: 10 }, 'mock')).resolves.toMatchObject({
        provider: 'corpus',
        results: Array.from({ length: 10 }, () => ({
          snippet: expect.stringContaining('evidence'),
        })),
      });
    } finally {
      db.close();
    }
  });

  it('imports immutable Unicode documents and searches corpus without network or keys', async () => {
    const db = openDatabase(':memory:');
    const network: Network = {
      resolve: async () => {
        throw Error('network forbidden');
      },
      request: async () => {
        throw Error('network forbidden');
      },
    };
    const inputs = new InputRegistry(db, { network });
    const doc = inputs.importDocument({
      title: '근거',
      mimeType: 'text/markdown',
      text: 'Corral keeps evidence. 한글',
    });
    expect(
      inputs.importDocument({
        title: '근거',
        mimeType: 'text/markdown',
        text: 'Corral keeps evidence. 한글',
      }),
    ).toEqual(doc);
    expect(
      await new InputRegistry(db, { network }).read({ documentId: doc.documentId }, 'mock'),
    ).toEqual(doc);
    expect(await inputs.search({ query: 'evidence' }, 'mock')).toMatchObject({
      provider: 'corpus',
      results: [{ documentId: doc.documentId }],
    });
    expect(await inputs.search({ query: 'missing' }, 'mock')).toMatchObject({ results: [] });
    expect(inputs.list()).toHaveLength(1);
    db.close();
  });
  it('pins each HTTPS read into a new immutable document while preserving older source snapshots', async () => {
    const db = openDatabase(':memory:');
    let body = 'First source text';
    let requests = 0;
    const network: Network = {
      resolve: async () => [{ address: '8.8.8.8', family: 4 }],
      request: async () => {
        requests++;
        return {
          status: 200,
          headers: { 'content-type': 'text/plain' },
          body: (async function* () {
            yield Buffer.from(body);
          })(),
          close() {},
        };
      },
    };
    const inputs = new InputRegistry(db, { network });
    const source = await inputs.importSource({ url: 'https://source.example/document' });
    await expect(inputs.read({ sourceId: source.sourceId }, 'mock')).rejects.toThrow(/mock/);
    expect(requests).toBe(0);
    const first = await inputs.read({ sourceId: source.sourceId }, 'live');
    body = 'Updated source text';
    const next = await inputs.read({ sourceId: source.sourceId }, 'live');
    expect(first.documentId).not.toBe(next.documentId);
    expect(
      await new InputRegistry(db).read({ documentId: first.documentId }, 'mock'),
    ).toMatchObject({ text: 'First source text' });
    expect(requests).toBe(2);
    db.close();
  });

  it('rejects arbitrary paths, unknown IDs, overlarge documents and unknown fields', async () => {
    const db = openDatabase(':memory:');
    const inputs = new InputRegistry(db);
    for (const args of [
      { path: '/etc/passwd' },
      { url: 'https://example.com' },
      { documentId: `doc_${'a'.repeat(64)}` },
    ])
      await expect(inputs.read(args, 'mock')).rejects.toThrow();
    expect(() =>
      inputs.importDocument({ title: 'bad', mimeType: 'text/html', text: '<script>x</script>' }),
    ).toThrow();
    expect(() =>
      inputs.importDocument({ title: 'bad', mimeType: 'text/plain', text: '한'.repeat(400_000) }),
    ).toThrow(/1 MiB/);
    await expect(inputs.search({ query: 'x', apiKey: 'secret' }, 'live')).rejects.toThrow();
    db.close();
  });
  it('requires live mode, explicit provider/config opt-in and a finite charged-call budget', async () => {
    const db = openDatabase(':memory:');
    let requests = 0;
    const network: Network = {
      resolve: async () => [{ address: '8.8.8.8', family: 4 }],
      request: async (url, _address, _signal, headers) => {
        requests++;
        expect(url.hostname).toBe('api.search.brave.com');
        expect(headers?.['x-subscription-token']).toBe('server-secret');
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: (async function* () {
            yield Buffer.from(
              JSON.stringify({
                web: {
                  results: [
                    { title: 'Source', url: 'https://source.example/doc', description: 'Evidence' },
                    { title: 'Local', url: 'https://127.0.0.1/secret' },
                  ],
                },
              }),
            );
          })(),
          close() {},
        };
      },
    };
    const disabled = new InputRegistry(db, { network });
    await expect(disabled.search({ query: 'x', provider: 'brave' }, 'live')).rejects.toThrow(
      /opt-in/,
    );
    const inputs = new InputRegistry(db, {
      network,
      liveSearch: { enabled: true, apiKey: () => 'server-secret', maxRequests: 1 },
    });
    await expect(inputs.search({ query: 'x', provider: 'brave' }, 'mock')).rejects.toThrow(
      /opt-in/,
    );
    await inputs.search({ query: 'x' }, 'live');
    expect(requests).toBe(0);
    const result = await inputs.search({ query: 'x', provider: 'brave' }, 'live');
    expect(result).toMatchObject({
      provider: 'brave',
      results: [{ title: 'Source', sourceId: expect.stringMatching(/^src_/) }],
    });
    expect(JSON.stringify(result)).not.toMatch(/server-secret|127.0.0.1/);
    await expect(inputs.search({ query: 'x', provider: 'brave' }, 'live')).rejects.toThrow(/limit/);
    expect(requests).toBe(1);
    db.close();
  });
});
