import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as httpServer } from 'node:http';
import { createServer as tcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linuxProcessIdentity } from '@corral/adapter-pi/processes';
import { afterEach, expect, it } from 'vitest';
import { InspectorBridge, launchNode, type OwnedDebuggee } from '../src/files/debug-processes.ts';
import type { PtySessionIdentity } from '../src/processes/pty-session.ts';
import { systemTimers } from '../src/runtime.ts';

const roots: string[] = [];
const processes: OwnedDebuggee[] = [];
const bridges: InspectorBridge[] = [];
afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
  for (const child of processes.splice(0)) expect(await child.close()).toBe(true);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it.skipIf(process.platform !== 'linux')(
  '[TC-WBD-023-H] launches an owned paused Node target and proxies only its attested inspector',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'corral-debug-test-'));
    roots.push(root);
    await writeFile(
      join(root, 'main.cjs'),
      `const fs = require('node:fs');
       const child = require('node:child_process').spawn(process.execPath,
         ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
       fs.writeFileSync('child', String(child.pid)); fs.writeFileSync('ran', 'yes');
       setInterval(() => {}, 1000)`,
    );
    let identity: PtySessionIdentity | undefined;
    const child = await launchNode({
      root,
      cwd: root,
      program: 'main.cjs',
      args: [],
      executable: process.execPath,
      env: {},
      owner: 'debug-test',
      timers: systemTimers,
      onSpawn: (value) => {
        identity = value;
      },
    });
    processes.push(child);
    expect(identity).toEqual(child.identity);
    expect(identity?.pid).toBeGreaterThan(0);
    await expect(readFile(join(root, 'ran'))).rejects.toMatchObject({ code: 'ENOENT' });
    const bridge = await InspectorBridge.start({
      kind: 'node',
      operationId: 'debug-test',
      port: child.port,
      attest: child.attestConnection,
    });
    bridges.push(bridge);
    const discovery = await fetch(`http://${bridge.address}:${bridge.port}/json/list`).then(
      (response) => response.json(),
    );
    expect(discovery).toMatchObject([{ webSocketDebuggerUrl: bridge.websocketAddress }]);
    expect(bridge.websocketAddress).not.toContain(`:${child.port}/`);
    expect(
      await fetch(`http://${bridge.address}:${bridge.port}/json/activate/arbitrary`).then(
        (response) => response.status,
      ),
    ).toBe(404);
    const ws = new WebSocket(bridge.websocketAddress);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('inspector connection failed')), {
        once: true,
      });
    });
    const resumed = new Promise<void>((resolve) => {
      ws.addEventListener('message', (event) => {
        if (JSON.parse(String(event.data)).id === 1) resolve();
      });
    });
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.runIfWaitingForDebugger' }));
    await resumed;
    await expect.poll(() => readFile(join(root, 'ran'), 'utf8')).toBe('yes');
    const descendant = Number(await readFile(join(root, 'child'), 'utf8'));
    const closed = new Promise<void>((resolve) => ws.addEventListener('close', () => resolve()));
    await bridge.close();
    await closed;
    expect(() => process.kill(child.identity.pid, 0)).not.toThrow();
    expect(await child.close()).toBe(true);
    await child.exited;
    expect(() => process.kill(child.identity.pid, 0)).toThrow();
    expect(['Z', 'X', undefined]).toContain(linuxProcessIdentity(descendant)?.state);
  },
  15000,
);

it('[TC-WBD-023-N] refuses a foreign inspector before sending discovery bytes', async () => {
  let received = 0;
  const server = tcpServer((socket) => socket.on('data', (bytes) => (received += bytes.length)));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as { port: number };
    await expect(
      InspectorBridge.start({
        kind: 'node',
        operationId: 'foreign',
        port: address.port,
        attest: async () => false,
      }),
    ).rejects.toThrow();
    expect(received).toBe(0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 10000);

it.each(['redirect', 'external-websocket'])(
  '[TC-WBD-023-N] refuses %s inspector discovery without following it',
  async (mode) => {
    let requests = 0;
    const server = httpServer((_request, response) => {
      requests++;
      if (mode === 'redirect')
        response.writeHead(302, { location: 'http://127.0.0.1:9/private' }).end();
      else response.end(JSON.stringify([{ webSocketDebuggerUrl: 'ws://example.invalid/private' }]));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address() as { port: number };
      await expect(
        InspectorBridge.start({
          kind: 'node',
          operationId: 'discovery',
          port: address.port,
          attest: async () => true,
        }),
      ).rejects.toThrow();
      expect(requests).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
