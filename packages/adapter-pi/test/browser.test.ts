import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RegisteredMcpServer } from '@corral/contracts';
import { McpClient } from '@earendil-works/pi-mcp';
import { expect, it } from 'vitest';
import { assertBrowserCall } from '../src/browser-policy.ts';
import { createCorralMcpTransport } from '../src/mcp-transport.ts';

it('[TC-BROWSER-001-N] the local fixture policy refuses external origins, arbitrary code and file output', () => {
  const config = {
    origin: 'http://127.0.0.1:51234',
    executablePath: '/fixture/chromium',
    readyText: 'fixture ready',
    fixtureOnly: true,
    backendVersion: '0.0.83',
  };
  expect(
    RegisteredMcpServer.safeParse({
      id: 'browser',
      name: 'Browser',
      transport: 'stdio',
      argv: ['node', 'fixture.mjs'],
      timeoutMs: 5000,
      exposure: 'direct',
      browser: config,
    }).success,
  ).toBe(true);
  expect(() => assertBrowserCall(config, 'browser_navigate', { url: config.origin })).not.toThrow();
  for (const [name, args] of [
    ['browser_navigate', { url: 'https://example.com' }],
    ['browser_evaluate', { function: '() => 1' }],
    ['browser_take_screenshot', { filename: '../escape.png' }],
    ['browser_wait_for', { time: 100 }],
    ['browser_run_code', { code: '' }],
    ['browser_file_upload', { paths: ['/private'] }],
  ] as const)
    expect(() => assertBrowserCall(config, name, args)).toThrow();
});

it.skipIf(!process.env.CORRAL_BROWSER_EXECUTABLE)(
  '[TC-BROWSER-001-H] [TC-BROWSER-001-N] owned Playwright MCP verifies a local interaction, fails a false assertion and reaps the browser/server on cancellation',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'corral-browser-fixture-'));
    const portServer = createServer();
    await new Promise<void>((resolve) => portServer.listen(0, '127.0.0.1', resolve));
    const address = portServer.address();
    if (!address || typeof address === 'string') throw new Error('port unavailable');
    await new Promise<void>((resolve) => portServer.close(() => resolve()));
    const origin = `http://127.0.0.1:${address.port}`;
    let externalHits = 0;
    const external = createHttpServer((_request, response) => {
      externalHits++;
      response.end('unrelated fixture');
    });
    await new Promise<void>((resolve) => external.listen(0, '127.0.0.1', resolve));
    const externalAddress = external.address();
    if (!externalAddress || typeof externalAddress === 'string')
      throw new Error('external fixture port unavailable');
    const externalOrigin = `http://127.0.0.1:${externalAddress.port}`;
    const html = `<title>fixture ready</title><button onclick="document.querySelector('p').textContent='Count: 1'">Add</button><p>Count: 0</p>`;
    writeFileSync(
      join(root, 'fixture.mjs'),
      `import {createServer} from 'node:http';import {writeFileSync} from 'node:fs';writeFileSync('server.pid', String(process.pid));createServer((req,res)=>{if(req.url==='/redirect'){res.writeHead(302,{location:${JSON.stringify(externalOrigin)}});return res.end();}res.end(${JSON.stringify(html)});}).listen(${address.port}, '127.0.0.1');`,
    );

    const server = RegisteredMcpServer.parse({
      id: 'browser',
      name: 'Browser fixture',
      transport: 'stdio',
      argv: [process.execPath, 'fixture.mjs'],
      timeoutMs: 15000,
      exposure: 'direct',
      browser: {
        fixtureOnly: true,
        backendVersion: '0.0.83',
        origin,
        readyText: 'fixture ready',
        executablePath: process.env.CORRAL_BROWSER_EXECUTABLE,
      },
    });
    if (server.transport !== 'stdio' || !server.browser)
      throw new Error('stdio browser fixture required');
    const client = new McpClient({
      name: 'Corral browser fixture',
      version: '1',
      requestTimeoutMs: 20000,
    });
    const transport = createCorralMcpTransport(
      server,
      root,
      join(root, 'private'),
      async () => undefined,
      join(root, 'leases'),
    );
    if (!('stderr' in transport)) throw new Error('stdio transport required');
    try {
      await client.connect(transport);
      const navigation = await client.callTool('browser_navigate', { url: origin });
      expect(navigation.isError).not.toBe(true);
      const observation = await client.callTool('browser_snapshot', {});
      expect(JSON.stringify(observation)).toContain('Count: 0');
      const ready = await client.callTool('browser_verify_element_visible', {
        role: 'button',
        accessibleName: 'Add',
      });
      expect(ready.isError).not.toBe(true);
      const snapshot = JSON.stringify(observation);
      const ref = /button.*?Add.*?\[ref=([^\]]+)\]/.exec(snapshot)?.[1];
      if (!ref) throw new Error('fixture button reference missing');
      expect(
        (await client.callTool('browser_click', { element: 'Add', target: ref })).isError,
      ).not.toBe(true);
      expect(
        (await client.callTool('browser_verify_text_visible', { text: 'Count: 1' })).isError,
      ).not.toBe(true);
      expect(
        (await client.callTool('browser_verify_text_visible', { text: 'Never exists' })).isError,
      ).toBe(true);
      expect(
        (await client.callTool('browser_navigate', { url: `${origin}/redirect` })).isError,
      ).toBe(true);
      expect(externalHits).toBe(0);
      await expect(
        client.callTool('browser_navigate', { url: 'https://example.com' }),
      ).rejects.toThrow();
      const pending = client
        .callTool('browser_wait_for', { text: 'Never appears' })
        .catch(() => null);
      await client.close();
      await pending;
      const pid = Number(readFileSync(join(root, 'server.pid'), 'utf8'));
      expect(() => process.kill(pid, 0)).toThrow();
      await expect(fetch(origin, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
      expect((await fetch(externalOrigin)).status).toBe(200);
      const timed = new McpClient({
        name: 'readiness timeout fixture',
        version: '1',
        requestTimeoutMs: 5000,
      });
      const unavailable = createCorralMcpTransport(
        { ...server, timeoutMs: 1000, browser: { ...server.browser!, readyText: 'Never ready' } },
        root,
        join(root, 'timeout-private'),
        async () => undefined,
        join(root, 'leases'),
      );
      try {
        await expect(timed.connect(unavailable)).rejects.toThrow();
      } finally {
        await timed.close();
        await unavailable.close();
      }
      expect(() =>
        process.kill(Number(readFileSync(join(root, 'server.pid'), 'utf8')), 0),
      ).toThrow();
    } catch (error) {
      throw new Error(`${String(error)} · ${transport.stderr}`, { cause: error });
    } finally {
      await client.close();
      await transport.close();
      await new Promise<void>((resolve) => external.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  },
  45000,
);
