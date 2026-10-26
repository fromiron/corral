import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { VaultS3Transport } from '../src/vault/s3.ts';

describe('S3 signed revision transport', () => {
  it('uses conditional writes and authoritative GET readback against a real HTTP server', async () => {
    let body: string | null = null;
    let revision = 0;
    const authorizations: string[] = [];
    const server = createServer(async (request, response) => {
      authorizations.push(request.headers.authorization ?? '');
      if (request.method === 'GET') {
        if (body === null) {
          response.writeHead(404).end();
          return;
        }
        response.writeHead(200, { etag: `"${revision}"` }).end(body);
        return;
      }
      if (
        body === null
          ? request.headers['if-none-match'] !== '*'
          : request.headers['if-match'] !== `"${revision}"`
      ) {
        response.writeHead(412).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      body = Buffer.concat(chunks).toString('utf8');
      response.writeHead(200, { etag: `"${++revision}"` }).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error();
      const transport = new VaultS3Transport(
        {
          endpoint: `http://127.0.0.1:${address.port}`,
          region: 'test-1',
          bucket: 'test-bucket',
          key: 'settings/vault.json',
        },
        { accessKeyId: 'TESTACCESS', secretAccessKey: 'test-secret-not-in-headers' },
      );
      expect(await transport.read()).toBeNull();
      expect(await transport.write('encrypted-one', null)).toEqual({ etag: '"1"' });
      await expect(transport.write('stale', null)).rejects.toThrow('changed');
      expect(await transport.write('encrypted-two', '"1"')).toEqual({ etag: '"2"' });
      expect((await transport.read())?.body).toBe('encrypted-two');
      expect(
        authorizations.every((value) =>
          value.startsWith('AWS4-HMAC-SHA256 Credential=TESTACCESS/'),
        ),
      ).toBe(true);
      expect(authorizations.join()).not.toContain('test-secret');
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
