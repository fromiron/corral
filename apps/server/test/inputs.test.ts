import { openDatabase } from '@corral/storage-sqlite';
import { describe, expect, it } from 'vitest';
import { InputRegistry } from '../src/inputs.ts';
import type { Network } from '../src/safe-http.ts';

describe('registered documents and explicit search (C-043, C-044)', () => {
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

  it('[TC-DX-003-H] imports immutable Unicode documents and searches corpus without network or keys', async () => {
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
  it('[TC-DX-003-N] requires live mode, explicit provider/config opt-in and a finite charged-call budget', async () => {
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
