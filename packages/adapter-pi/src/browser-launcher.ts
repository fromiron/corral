import { type ChildProcess, spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { RegisteredMcpServer } from '@corral/contracts';

// A trusted local fixture only. Network interception here is not an OS sandbox.
const server = RegisteredMcpServer.parse(JSON.parse(readFileSync(process.argv[2]!, 'utf8')));
if (server.transport !== 'stdio' || !server.browser || process.platform !== 'linux')
  throw new Error('local browser backend unavailable');
const recipe = server.browser;
const directory = dirname(process.argv[2]!);
const backend = dirname(fileURLToPath(import.meta.resolve('@playwright/mcp/package.json')));
if (
  JSON.parse(readFileSync(join(backend, 'package.json'), 'utf8')).version !== recipe.backendVersion
)
  throw new Error('browser backend version mismatch');
const children: ChildProcess[] = [];
const controller = new AbortController();
const stop = () => {
  controller.abort();
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
process.stdin.once('end', stop);

try {
  const url = new URL(recipe.origin);
  const occupied = await new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port: Number(url.port) });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.setTimeout(500, () => {
      socket.destroy();
      resolve(true);
    });
  });
  if (occupied) throw new Error('fixture port is already occupied');
  const dev = spawn(server.argv[0]!, server.argv.slice(1), {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'ignore',
  });
  children.push(dev);
  dev.once('error', stop);
  dev.once('exit', stop);
  const deadline = Date.now() + Math.min(server.timeoutMs, 30000);
  let ready = false;
  while (!controller.signal.aborted && Date.now() < deadline) {
    try {
      const response = await fetch(recipe.origin, {
        redirect: 'error',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(500)]),
      });
      // A concrete readiness response, not networkidle or a successful process launch.
      const body = response.body?.getReader();
      let text = '',
        size = 0;
      if (body)
        try {
          while (size <= 65536) {
            const chunk = await body.read();
            if (chunk.done) break;
            size += chunk.value.length;
            text += new TextDecoder().decode(chunk.value);
          }
        } finally {
          await body.cancel();
        }
      if (response.ok && size <= 65536 && text.includes(recipe.readyText)) {
        ready = true;
        break;
      }
    } catch {
      /* Still starting; the deadline and owner cancellation remain authoritative. */
    }
    await delay(50, undefined, { signal: controller.signal });
  }
  if (!ready || controller.signal.aborted) throw new Error('fixture readiness failed');
  const init = join(directory, 'page.mjs');
  writeFileSync(
    init,
    `export default async ({ page }) => {
    const context = page.context();
    await context.route('**/*', async route => {
      try {
        if (new URL(route.request().url()).origin !== ${JSON.stringify(recipe.origin)}) return await route.abort('blockedbyclient');
        const response = await route.fetch({ maxRedirects: 0, timeout: 5000 });
        if (response.status() >= 300 && response.status() < 400) return await route.abort('blockedbyclient');
        await route.fulfill({ response });
      } catch { await route.abort().catch(() => {}); }
    });
    await context.routeWebSocket('**/*', ws => ws.close());
    page.on('download', download => { void download.cancel(); });
  };`,
    { mode: 0o600, flag: 'wx' },
  );
  const config = join(directory, 'playwright.json');
  writeFileSync(
    config,
    JSON.stringify({
      browser: {
        browserName: 'chromium',
        isolated: true,
        launchOptions: {
          headless: true,
          executablePath: recipe.executablePath,
          chromiumSandbox: true,
        },
        contextOptions: { serviceWorkers: 'block', acceptDownloads: false },
        initPage: [init],
      },
      capabilities: ['testing'],
      webmcp: false,
      network: { allowedOrigins: [recipe.origin] },
      outputDir: join(directory, 'output'),
      imageResponses: 'allow',
      filePaths: 'relative',
      codegen: 'none',
      timeouts: {
        action: Math.min(server.timeoutMs, 5000),
        navigation: Math.min(server.timeoutMs, 10000),
        expect: 1000,
        idle: 60000,
      },
    }),
    { mode: 0o600, flag: 'wx' },
  );
  const mcp = spawn(process.execPath, [join(backend, 'cli.js'), '--config', config], {
    env: process.env,
    cwd: directory,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  children.push(mcp);
  mcp.once('error', stop);
  process.stdin.pipe(mcp.stdin!);
  mcp.stdout!.pipe(process.stdout);
  await new Promise<void>((resolve) => {
    mcp.once('exit', () => resolve());
    mcp.once('error', () => resolve());
  });
} catch {
  process.stderr.write('Owned browser fixture failed to start or stopped.\n');
  process.exitCode = 1;
} finally {
  stop();
  await delay(150);
  for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
  process.stdin.destroy();
}
