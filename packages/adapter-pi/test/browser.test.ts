import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { RegisteredMcpServer } from '@corral/contracts';
import { McpClient } from '@earendil-works/pi-mcp';
import { expect, it } from 'vitest';
import {
  assertBrowserCall,
  assertOwnedBrowserOrigin,
  PreviewBrowserTarget,
} from '../src/browser-policy.ts';
import { createCorralMcpTransport, createPreviewBrowserTransport } from '../src/mcp-transport.ts';

it('[TC-ABS-004-N] preview attachment cannot turn user MCP config into an arbitrary origin capability', () => {
  const target = {
    url: 'http://127.0.0.2:51234/lease/index.html',
    origin: 'http://127.0.0.2:51234',
    pathPrefix: '/lease/',
    webSocketOrigins: ['ws://127.0.0.2:51234'],
    headers: { 'x-corral-preview': 'private-preview-credential-123456789' },
  };
  expect(PreviewBrowserTarget.safeParse(target).success).toBe(true);
  for (const patch of [
    { origin: 'http://127.0.0.1:51234', url: 'http://127.0.0.1:51234/lease/' },
    { webSocketOrigins: ['ws://127.0.0.2:51235'] },
    { url: 'http://127.0.0.2:51234/unowned/index.html' },
    { headers: { authorization: 'arbitrary-token' } },
  ])
    expect(PreviewBrowserTarget.safeParse({ ...target, ...patch }).success).toBe(false);
  expect(
    RegisteredMcpServer.safeParse({
      id: 'untrusted',
      name: 'Untrusted',
      transport: 'stdio',
      argv: ['node'],
      timeoutMs: 5000,
      exposure: 'direct',
      preview: target,
    }).success,
  ).toBe(false);
});

it('[TC-ABS-004-N] browser origins require the exact owned HTTP origin and an explicit WebSocket origin', () => {
  const policy = {
    origin: 'http://127.0.0.1:51234',
    webSocketOrigins: ['ws://127.0.0.1:51234'],
  };
  expect(assertOwnedBrowserOrigin(`${policy.origin}/assets/index.js`, policy).pathname).toBe(
    '/assets/index.js',
  );
  expect(assertOwnedBrowserOrigin('ws://127.0.0.1:51234/hmr', policy, 'websocket').pathname).toBe(
    '/hmr',
  );
  for (const url of [
    'http://localhost:51234',
    'http://127.0.0.1:51235',
    'http://user:password@127.0.0.1:51234',
    'https://127.0.0.1:51234',
    'file:///C:/private.txt',
    'data:text/html,hello',
    'http://127.0.0.1:51234.example.com',
  ])
    expect(() => assertOwnedBrowserOrigin(url, policy)).toThrow();
  expect(() => assertOwnedBrowserOrigin('ws://127.0.0.1:51234/hmr', policy)).toThrow();
  expect(() =>
    assertOwnedBrowserOrigin('ws://127.0.0.1:51234/hmr', { origin: policy.origin }, 'websocket'),
  ).toThrow();
  expect(() => assertOwnedBrowserOrigin('ws://127.0.0.1:51235/hmr', policy, 'websocket')).toThrow();
  const scoped = { origin: policy.origin, pathPrefix: '/lease/opaque/' };
  expect(() =>
    assertOwnedBrowserOrigin(`${policy.origin}/lease/opaque/index.html`, scoped),
  ).not.toThrow();
  for (const path of [
    '/lease/another/index.html',
    '/lease/opaque-escape/index.html',
    '/lease/opaque/../another/index.html',
    '/lease/opaque/%2e%2e/another/index.html',
  ])
    expect(() => assertOwnedBrowserOrigin(`${policy.origin}${path}`, scoped)).toThrow();
});

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
  for (const executablePath of ['C:\\Program Files\\Chrome\\chrome.exe', 'D:/Chrome/chrome.exe'])
    expect(
      RegisteredMcpServer.safeParse({
        id: 'browser',
        name: 'Browser',
        transport: 'stdio',
        argv: ['node', 'fixture.mjs'],
        timeoutMs: 5000,
        exposure: 'direct',
        browser: { ...config, executablePath },
      }).success,
    ).toBe(true);
  for (const executablePath of ['C:chrome.exe', 'chrome.exe', '\\\\host\\share\\chrome.exe'])
    expect(
      RegisteredMcpServer.safeParse({
        id: 'browser',
        name: 'Browser',
        transport: 'stdio',
        argv: ['node', 'fixture.mjs'],
        timeoutMs: 5000,
        exposure: 'direct',
        browser: { ...config, executablePath },
      }).success,
    ).toBe(false);
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
  '[TC-ABS-004-H] [TC-ABS-004-N] the browser attaches to the same owned preview with HTTP/WS credentials and rejects expired leases',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'corral-preview-browser-'));
    const sockets = new Set<Duplex>();
    const secret = 'private-preview-credential-123456789';
    let externalHits = 0;
    const external = createHttpServer((_req, res) => {
      externalHits++;
      res.end('unowned');
    });
    external.on('upgrade', (_req, socket) => {
      externalHits++;
      socket.destroy();
    });
    await new Promise<void>((resolve) => external.listen(0, '127.0.0.1', resolve));
    const outside = external.address();
    if (!outside || typeof outside === 'string') throw new Error('fixture port missing');
    const outsideOrigin = `http://127.0.0.1:${outside.port}`;
    const seenHeaders: string[] = [];
    let origin = '';
    const server = createHttpServer((req, res) => {
      seenHeaders.push(String(req.headers['x-corral-preview']));
      if (req.headers['x-corral-preview'] !== secret) {
        res.writeHead(403).end();
        return;
      }
      if (req.url === '/lease/redirect') {
        res.writeHead(302, { location: outsideOrigin }).end();
        return;
      }
      res.end(`<button onclick="document.querySelector('#count').textContent='Count: 1'">Add</button><p id="count">Count: 0</p><p id="ws">Connecting</p><script>
        new WebSocket(${JSON.stringify(origin.replace('http:', 'ws:') + '/lease/hmr')}).onmessage=e=>document.querySelector('#ws').textContent=e.data;
        new WebSocket(${JSON.stringify(outsideOrigin.replace('http:', 'ws:'))});
        fetch(${JSON.stringify(outsideOrigin)}).catch(()=>{});
      </script>`);
    });
    server.on('upgrade', (req, socket) => {
      seenHeaders.push(String(req.headers['x-corral-preview']));
      if (req.headers['x-corral-preview'] !== secret) {
        socket.destroy();
        return;
      }
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => {});
      socket.on('data', () => {});
      const accept = createHash('sha1')
        .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest('base64');
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      const payload = Buffer.from('Live preview ready');
      socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.2', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture port missing');
    origin = `http://127.0.0.2:${address.port}`;
    const target = {
      url: `${origin}/lease/index.html`,
      origin,
      pathPrefix: '/lease/',
      webSocketOrigins: [origin.replace('http:', 'ws:')],
      headers: { 'x-corral-preview': secret },
    };
    let active = true,
      validations = 0;
    const transport = createPreviewBrowserTransport(target, {
      executablePath: process.env.CORRAL_BROWSER_EXECUTABLE!,
      cwd: root,
      directory: join(root, 'private'),
      leaseDirectory: join(root, 'leases'),
      revalidate: async () => {
        validations++;
        return active ? target : null;
      },
    });
    const client = new McpClient({
      name: 'Preview browser',
      version: '1',
      requestTimeoutMs: 20000,
    });
    try {
      await client.connect(transport);
      const navigation = await client.callTool('browser_navigate', { url: target.url });
      expect(navigation.isError, JSON.stringify(navigation)).not.toBe(true);
      expect(
        (await client.callTool('browser_wait_for', { text: 'Live preview ready' })).isError,
      ).not.toBe(true);
      expect(seenHeaders.length).toBeGreaterThanOrEqual(2);
      expect(seenHeaders.every((header) => header === secret)).toBe(true);
      await expect(
        client.callTool('browser_navigate', { url: `${origin}/other/` }),
      ).rejects.toThrow();
      expect(
        (await client.callTool('browser_navigate', { url: `${origin}/lease/redirect` })).isError,
      ).toBe(true);
      expect(externalHits).toBe(0);
      expect(validations).toBeGreaterThanOrEqual(4);
      active = false;
      await expect(client.callTool('browser_snapshot', {})).rejects.toThrow();
      expect((await fetch(target.url, { headers: target.headers })).status).toBe(200);
    } finally {
      await client.close();
      await transport.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => external.close(() => resolve()));
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
  45000,
);

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
      expect(navigation.isError, JSON.stringify(navigation)).not.toBe(true);
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

import { createHash } from 'node:crypto';
