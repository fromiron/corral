import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { probeMcp } from '../src/mcp-probe.ts';

it('a real HTTP probe preserves status and discards the remote response body', async () => {
  const root = mkdtempSync(join(tmpdir(), 'corral-probe-status-'));
  const server = createServer((_request, response) => {
    response.writeHead(503);
    response.end('private server diagnostic');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  try {
    await expect(
      probeMcp({
        server: {
          id: 'remote',
          name: 'Remote',
          transport: 'http',
          auth: { kind: 'none' },
          url: `http://127.0.0.1:${address.port}/mcp`,
          exposure: 'direct',
          timeoutMs: 5000,
        },
        leaseDirectory: join(root, 'leases'),
        signal: new AbortController().signal,
        authorization: async () => undefined,
      }),
    ).rejects.toThrow(/^MCP server returned HTTP 503$/);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(root, { recursive: true, force: true });
  }
});
