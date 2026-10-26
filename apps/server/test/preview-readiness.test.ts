import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { PreviewService } from '../src/preview/service.ts';
import { CommandRuntime } from '../src/processes/runtime.ts';

it.skipIf(!['win32', 'linux'].includes(process.platform))(
  'immediate preview_app waits for the owned service to bind and finish HTTP initialization',
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'corral-preview-readiness-')));
    const reservation = createServer();
    await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
    const address = reservation.address();
    if (!address || typeof address === 'string') throw new Error('port unavailable');
    const port = address.port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    await writeFile(
      join(root, 'app.cjs'),
      `
      const http = require('node:http'), fs = require('node:fs');
      let unavailable = 0;
      const server = http.createServer((req, res) => {
        if (!fs.existsSync('compiled.flag')) {
          fs.writeFileSync('unavailable.json', JSON.stringify(++unavailable));
          res.writeHead(503).end('Compiling application');
        } else res.end('<h1>Application ready</h1>');
      });
      setTimeout(() => server.listen(${port}, '127.0.0.1'), 400);
    `,
    );
    const runtime = new CommandRuntime();
    const service = new PreviewService({
      resolveRoot: async () => root,
      operationRun: async (sessionId, operationId) => {
        const operation = runtime
          .list({ sessionId })
          .find((item) => item.operationId === operationId && item.state === 'running');
        if (!operation) throw new Error('no live owned operation');
        return operation.owner.runId;
      },
      attestConnection: async (_sessionId, operationId, serverPort, peerPort) =>
        runtime.attestConnection(operationId, serverPort, peerPort),
    });
    try {
      const operation = runtime.startService(
        {
          operationId: 'preview_readiness',
          owner: {
            hostId: 'local',
            sessionId: 'session_1',
            runId: 'run_1',
            executionId: 'exec_1',
            attemptNo: 1,
            effectId: 'effect_1',
          },
          directory: root,
          command: { shellId: 'powershell', executable: process.execPath, args: ['app.cjs'] },
          timeoutMs: 20000,
        },
        { aborted: false, onCancel: () => () => {} },
      );
      // This is the same startup guarantee returned by run_command mode=service.
      expect(await operation.started).toBe(true);
      const starting = service.start('session_1', { operationId: operation.operationId, port });
      await expect
        .poll(
          async () => {
            try {
              return JSON.parse(await readFile(join(root, 'unavailable.json'), 'utf8')) as number;
            } catch {
              return 0;
            }
          },
          { timeout: 10000 },
        )
        .toBeGreaterThan(0);
      expect(service.list('session_1')).toEqual([]);
      await writeFile(join(root, 'compiled.flag'), '');
      const lease = await starting;
      expect(lease.state).toBe('ready');
      expect(JSON.parse(await readFile(join(root, 'unavailable.json'), 'utf8'))).toBeGreaterThan(0);
      const target = await service.desktopTarget('session_1', lease.leaseId);
      if (!target) throw new Error('owned target missing');
      expect(await (await fetch(target.url, { headers: target.headers })).text()).toContain(
        'Application ready',
      );
    } finally {
      await service.dispose();
      await runtime.close();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
  30000,
);
