import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, it } from 'vitest';
import { PreviewService } from '../src/preview/service.ts';
import { PreviewToolsBroker } from '../src/preview/tools.ts';
import { CommandRuntime } from '../src/processes/runtime.ts';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
}, 30000);

it.skipIf(!process.env.CORRAL_BROWSER_EXECUTABLE)(
  'model preview actions use the same lease, execute once and retain immutable evidence',
  async () => {
    const { root, service } = await setup();
    await writeFile(
      join(root, 'site', 'index.html'),
      "<button onclick=\"const p=document.querySelector('p');p.textContent='Count: '+(Number(p.textContent.split(': ')[1])+1)\">Add</button><p>Count: 0</p>",
    );
    const broker = new PreviewToolsBroker(service, {
      directory: join(root, '.corral-preview-test'),
      browserExecutable: process.env.CORRAL_BROWSER_EXECUTABLE,
      sessionOfRun: (runId) => (runId === 'run_1' || runId === 'run_2' ? 'session_1' : null),
    });
    cleanup.push(() => broker.dispose());
    const cancellation = { aborted: false, onCancel: () => () => {} };
    const base = { runId: 'run_1', executionId: 'exec_1', attemptNo: 1 };
    const created = await broker.execute(
      { ...base, effectId: 'create', name: 'preview_file', args: { path: 'site/index.html' } },
      cancellation,
    );
    const leaseId = String(created.leaseId);
    const call = (effectId: string, tool: string, args: Record<string, unknown>) =>
      broker.execute(
        { ...base, effectId, name: 'preview_action', args: { leaseId, tool, args } },
        cancellation,
      );
    const snapshot = await call('snapshot', 'browser_snapshot', {});
    expect(JSON.stringify(snapshot)).toContain('Count: 0');
    for (const tool of snapshot.browserTools as { inputSchema: { properties: object } }[])
      expect(
        Object.keys(tool.inputSchema.properties).some((key) =>
          ['filename', 'paths', 'time'].includes(key),
        ),
      ).toBe(false);
    const ref = /button.*?Add.*?\[ref=([^\]]+)\]/.exec(JSON.stringify(snapshot))?.[1];
    if (!ref) throw new Error('real browser button reference missing');
    await call('click', 'browser_click', { element: 'Add', target: ref });
    await call('click', 'browser_click', { element: 'Add', target: ref });
    const verified = await call('assert', 'browser_verify_text_visible', { text: 'Count: 1' });
    expect((verified.result as { isError?: boolean }).isError).not.toBe(true);
    await expect(
      broker.execute(
        {
          ...base,
          runId: 'run_2',
          effectId: 'foreign',
          name: 'preview_action',
          args: { leaseId, tool: 'browser_snapshot', args: {} },
        },
        cancellation,
      ),
    ).rejects.toThrow();
    const captured = await call('capture', 'browser_take_screenshot', {});
    const images = (captured.result as { content: { type: string; evidenceId?: string }[] })
      .content;
    const imageId = images.find((item) => item.type === 'image')?.evidenceId;
    expect(imageId).toMatch(/^[a-f0-9]{64}$/);
    const evidence = await broker.evidence('session_1', String(imageId));
    expect(evidence?.contentType).toBe('image/png');
    expect(evidence?.bytes.length).toBeGreaterThan(100);
    expect(await broker.evidence('other_session', String(imageId))).toBeNull();
    await broker.closeExecution('run_1', 'exec_1');
    expect(await service.desktopTarget('session_1', leaseId)).toBeNull();
    expect(await broker.evidence('session_1', String(captured.evidenceId))).not.toBeNull();
  },
  45000,
);
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'corral-preview-'));
  cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  await mkdir(join(root, 'site'));
  await writeFile(
    join(root, 'site', 'index.html'),
    '<title>Working copy</title><img src="image.svg"><button onclick="this.textContent=\'Done\'">Try</button>',
  );
  await writeFile(join(root, 'site', 'image.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  let trusted = true;
  const service = new PreviewService({
    resolveRoot: async (sessionId) => {
      if (sessionId !== 'session_1' || !trusted) throw new Error('untrusted session');
      return root;
    },
  });
  cleanup.push(() => service.dispose());
  return {
    root,
    service,
    revoke: () => {
      trusted = false;
    },
  };
}

it('serves the real copy and relative assets; refresh reads edits and stop revokes the URL', async () => {
  const { root, service } = await setup();
  const preview = await service.start('session_1', { path: 'site/index.html' });
  expect(new URL(preview.url).hostname).toBe('127.0.0.2');
  const response = await fetch(preview.url);
  expect(await response.text()).toContain('Working copy');
  expect(response.headers.get('content-security-policy')).toContain('sandbox');
  expect(response.headers.get('content-security-policy')).not.toContain('allow-scripts');
  expect(response.headers.get('content-security-policy')).not.toContain('allow-same-origin');
  expect((await fetch(new URL('image.svg', preview.url))).status).toBe(200);
  await writeFile(join(root, 'site', 'index.html'), '<title>Updated</title>');
  expect(await (await fetch(preview.url)).text()).toContain('Updated');
  expect(service.list('session_2')).toEqual([]);
  await expect(service.stop('session_2', preview.leaseId)).rejects.toThrow();
  await service.stop('session_1', preview.leaseId);
  expect(service.list('session_1')[0]?.state).toBe('stopped');
  await expect(fetch(preview.url)).rejects.toThrow();
});

it('refuses traversal, private files, unsupported content, foreign paths and revoked trust', async () => {
  const { service, root, revoke } = await setup();
  for (const path of [
    '../outside.html',
    '.git/config',
    'C:/private.html',
    '.corral/token',
    '.env',
    'file:///x.html',
  ])
    await expect(service.start('session_1', { path })).rejects.toThrow();
  const preview = await service.start('session_1', { path: 'site/index.html' });
  expect((await fetch(`${preview.origin}/site/index.html`)).status).toBe(404);
  expect((await fetch(preview.url, { method: 'POST' })).status).toBe(405);
  const link = join(root, 'site', 'escape');
  await symlink(root, link, process.platform === 'win32' ? 'junction' : 'dir');
  expect((await fetch(new URL('escape/site/index.html', preview.url))).status).toBe(404);
  await writeFile(
    join(root, 'site', 'index.html'),
    '<meta http-equiv="refresh" content="0;url=http://localhost:1234"><script>location.href="http://localhost:1234"</script><a href="http://localhost:1234">outside</a><img src="image.svg" onerror="alert(1)">',
  );
  const sanitized = await (await fetch(preview.url)).text();
  expect(sanitized).not.toMatch(/localhost|onerror|http-equiv|<script/);
  expect(sanitized).toContain('src="image.svg"');
  revoke();
  expect((await fetch(preview.url)).status).toBe(404);
});

it('a reader preview serves its pinned snapshot while a writer changes the live copy', async () => {
  const { root } = await setup();
  const service = new PreviewService({
    resolveRoot: async () => root,
    readSnapshot: async (_session, runId, path) => {
      if (runId !== 'reader' || path !== 'site/index.html')
        throw new Error('snapshot asset unavailable');
      return Buffer.from('<h1>Pinned input</h1>');
    },
  });
  cleanup.push(() => service.dispose());
  const lease = await service.start('session_1', { path: 'site/index.html', runId: 'reader' });
  await writeFile(join(root, 'site', 'index.html'), '<h1>New writer content</h1>');
  const text = await (await fetch(lease.url)).text();
  expect(text).toContain('Pinned input');
  expect(text).not.toContain('New writer content');
  expect((await fetch(new URL('image.svg', lease.url))).status).toBe(404);
});

it('remote delegation is distinct, short lived, renewable and revoked with its lease', async () => {
  const { root } = await setup();
  let now = 1000;
  const service = new PreviewService({ resolveRoot: async () => root, now: () => now });
  cleanup.push(() => service.dispose());
  const lease = await service.start('session_1', { path: 'site/index.html' });
  const base = await service.desktopTarget('session_1', lease.leaseId);
  const delegated = await service.delegate('session_1', lease.leaseId);
  expect(delegated.target.headers).not.toEqual(base?.headers);
  expect(service.list('session_1')[0]).not.toHaveProperty('headers');
  const response = await fetch(delegated.target.url, { headers: delegated.target.headers });
  expect(await response.text()).toContain('onclick');
  now += 30_000;
  const renewed = await service.delegate('session_1', lease.leaseId, delegated.delegationId);
  expect(renewed.target.headers).toEqual(delegated.target.headers);
  now += 60_001;
  expect((await fetch(delegated.target.url, { headers: delegated.target.headers })).status).toBe(
    403,
  );
  await expect(
    service.delegate('session_1', lease.leaseId, delegated.delegationId),
  ).rejects.toThrow();
  const next = await service.delegate('session_1', lease.leaseId);
  expect(next.target.headers).not.toEqual(delegated.target.headers);
  await service.stop('session_1', lease.leaseId);
  await expect(service.delegate('session_1', lease.leaseId)).rejects.toThrow();
});

it.skipIf(!['win32', 'linux'].includes(process.platform))(
  'owned HTTP and HMR sockets attest the actual service job and revoke together',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'corral-preview-service-'));
    cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    const runtime = new CommandRuntime();
    cleanup.push(() => runtime.close());
    await writeFile(
      join(root, 'app.cjs'),
      `
const http=require('node:http'), fs=require('node:fs'), crypto=require('node:crypto');
const server=http.createServer((req,res)=>{if(req.url==='/redirect'){res.writeHead(302,{location:'http://127.0.0.1:1/'});return res.end();}if(req.url==='/headers'){res.setHeader('set-cookie','appSession=owned; HttpOnly; Domain=127.0.0.1');return res.end(JSON.stringify({cookie:req.headers.cookie,authorization:req.headers.authorization,privateHeader:req.headers['x-corral-preview']}));}res.end('<h1>Owned live app</h1>');});
server.on('connection', socket=>socket.on('error',()=>{}));
server.on('upgrade',(req,socket)=>{const accept=crypto.createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: '+accept+'\\r\\n\\r\\n');socket.on('data',data=>socket.write(data));});
server.listen(0,'127.0.0.1',()=>fs.writeFileSync('port.json',JSON.stringify(server.address().port)));
`,
    );
    runtime.startService(
      {
        operationId: 'preview_app',
        owner: {
          hostId: 'local',
          sessionId: 'session_1',
          runId: 'run_1',
          executionId: 'exec_1',
          attemptNo: 1,
          effectId: 'preview_app',
        },
        directory: root,
        command: { shellId: 'powershell', executable: process.execPath, args: ['app.cjs'] },
        timeoutMs: 30000,
      },
      { aborted: false, onCancel: () => () => {} },
    );
    let port = 0;
    for (let attempt = 0; attempt < 100 && !port; attempt++) {
      try {
        port = JSON.parse(await readFile(join(root, 'port.json'), 'utf8'));
      } catch {
        await delay(50);
      }
    }
    expect(port).toBeGreaterThan(0);
    const service = new PreviewService({
      resolveRoot: async () => root,
      operationRun: async (sessionId, operationId) => {
        const op = runtime
          .list({ sessionId })
          .find((item) => item.operationId === operationId && item.state === 'running');
        if (!op) throw new Error('no live owned operation');
        return op.owner.runId;
      },
      attestConnection: async (_sessionId, operationId, serverPort, peerPort) =>
        runtime.attestConnection(operationId, serverPort, peerPort),
    });
    cleanup.push(() => service.dispose());
    await expect(
      service.start('another_session', { operationId: 'preview_app', port }),
    ).rejects.toThrow();
    const lease = await service.start('session_1', { operationId: 'preview_app', port });
    const target = await service.desktopTarget('session_1', lease.leaseId);
    if (!target) throw new Error('owned service unavailable');
    expect((await fetch(target.url)).status).toBe(403);
    expect(await (await fetch(target.url, { headers: target.headers })).text()).toContain(
      'Owned live app',
    );
    const appHeaders = await fetch(`${target.origin}/headers`, {
      headers: {
        ...target.headers,
        cookie: 'appSession=owned',
        authorization: 'Bearer local-app',
      },
    });
    expect(await appHeaders.json()).toEqual({
      cookie: 'appSession=owned',
      authorization: 'Bearer local-app',
    });
    expect(appHeaders.headers.get('set-cookie')).toBe('appSession=owned; HttpOnly');
    expect((await fetch(`${target.origin}/redirect`, { headers: target.headers })).status).toBe(
      403,
    );
    const socket = await new Promise<import('node:stream').Duplex>((resolve, reject) => {
      const req = request(target.url, {
        headers: {
          ...target.headers,
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        },
      });
      req.on('error', reject);
      req.on('upgrade', (_res, stream) => resolve(stream));
      req.on('response', (res) => {
        res.resume();
        reject(new Error(`upgrade refused: ${res.statusCode}`));
      });
      req.end();
    });
    socket.on('error', () => {});
    const message = new Promise<string>((resolve) =>
      socket.once('data', (data: Buffer) => resolve(data.toString())),
    );
    socket.write('hmr-change');
    expect(await message).toBe('hmr-change');
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    await service.stop('session_1', lease.leaseId);
    await closed;
    expect(await service.desktopTarget('session_1', lease.leaseId)).toBeNull();
    expect(runtime.list({ sessionId: 'session_1' })[0]?.state).toBe('running');
    await runtime.stop('preview_app');
    await expect(
      service.start('session_1', { operationId: 'preview_app', port }),
    ).rejects.toThrow();
  },
  40000,
);
