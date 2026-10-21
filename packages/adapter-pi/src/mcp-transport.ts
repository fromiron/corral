import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { canonicalJson, type McpChallenge, type RegisteredMcpServer } from '@corral/contracts';
import { StdioTransport, StreamableHttpTransport } from '@earendil-works/pi-mcp';
import { assertBrowserCall, OwnedBrowserLaunch, PreviewBrowserTarget } from './browser-policy.ts';
import { acquireHostProcessGroup, type HostProcessReservation } from './processes/capacity.ts';
import { ownedWindowsProcessGone, prepareOwnedWindowsProcess } from './processes/owned-process.ts';
import { recordWorkerLease } from './worker-leases.ts';

const BROWSER_ENTRY = fileURLToPath(new URL('./browser-launcher.ts', import.meta.url));

export type PreviewBrowserOptions = {
  executablePath: string;
  timeoutMs?: number;
  cwd: string;
  directory: string;
  leaseDirectory: string;
  revalidate: () => Promise<PreviewBrowserTarget | null>;
};

/** Only the preview owner may supply this target; project MCP config cannot select this mode. */
export function createPreviewBrowserTransport(
  target: PreviewBrowserTarget,
  options: PreviewBrowserOptions,
) {
  const owned = PreviewBrowserTarget.parse(target);
  const revalidate = async () => {
    const current = await options.revalidate();
    if (!current || canonicalJson(PreviewBrowserTarget.parse(current)) !== canonicalJson(owned))
      throw new Error('preview lease is no longer available');
    return undefined;
  };
  return createCorralMcpTransport(
    {
      id: 'owned_preview',
      name: 'Owned preview',
      transport: 'stdio',
      argv: [process.execPath],
      timeoutMs: options.timeoutMs ?? 15000,
      exposure: 'direct',
    },
    options.cwd,
    options.directory,
    revalidate,
    options.leaseDirectory,
    { target: owned, executablePath: options.executablePath, revalidate },
  );
}

export function createCorralMcpTransport(
  server: RegisteredMcpServer,
  cwd: string | undefined,
  directory: string,
  authorization: (id: string, challenge?: McpChallenge) => Promise<string | undefined>,
  leaseDirectory: string,
  preview?: {
    target: PreviewBrowserTarget;
    executablePath: string;
    revalidate: () => Promise<undefined>;
  },
) {
  if (server.transport === 'stdio') {
    const browser = preview?.target ?? server.browser;
    let command = server.argv[0]!,
      args = server.argv.slice(1);
    if (browser) {
      if ((process.platform !== 'linux' && process.platform !== 'win32') || !cwd)
        throw new Error('owned browser requires a supported local working copy');
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink())
        throw new Error('private browser directory unavailable');
      const owned = mkdtempSync(join(directory, 'browser-'));
      const config = join(owned, 'owner.json');
      const launch = OwnedBrowserLaunch.parse(
        preview
          ? {
              kind: 'preview',
              target: preview.target,
              executablePath: preview.executablePath,
              timeoutMs: server.timeoutMs,
            }
          : { kind: 'fixture', server },
      );
      writeFileSync(config, JSON.stringify(launch), { mode: 0o600, flag: 'wx' });
      command = process.execPath;
      args = [BROWSER_ENTRY, config];
    }
    const processOwner = randomUUID();
    const environment = {
      PATH: process.env.PATH ?? '',
      HOME: directory,
      XDG_CONFIG_HOME: join(directory, 'config'),
      CLAUDE_CONFIG_DIR: join(directory, 'claude'),
      LANG: 'C.UTF-8',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      CORRAL_PROCESS_OWNER: processOwner,
      ...(process.platform === 'win32'
        ? {
            SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
            // Do not forge USERPROFILE: Chrome's known-folder safety check rejects it.
            // Browser profiles remain isolated by Playwright and all writable app dirs below.
            APPDATA: join(directory, 'appdata'),
            LOCALAPPDATA: join(directory, 'localappdata'),
            TEMP: join(directory, 'tmp'),
            TMP: join(directory, 'tmp'),
          }
        : {}),
    };
    if (process.platform === 'win32')
      for (const child of ['appdata', 'localappdata', 'tmp'])
        mkdirSync(join(directory, child), { recursive: true, mode: 0o700 });
    // Every stdio MCP group is owned, including wrappers and their descendants.
    const nativeOwner =
      process.platform === 'win32'
        ? prepareOwnedWindowsProcess(command, args, { cwd, env: environment })
        : undefined;
    const transport = new StdioTransport({
      command: nativeOwner?.command ?? command,
      args: nativeOwner?.args ?? args,
      cwd,
      inheritEnv: false,
      env: environment,
      stderr: 'pipe',
      maxMessageBytes: 2 * 1024 * 1024,
      maxStderrBytes: 4096,
      closeTimeoutMs: 1000,
    });
    const start = transport.start.bind(transport);
    const close = transport.close.bind(transport);
    const send = transport.send.bind(transport);
    if (browser)
      transport.send = async (message) => {
        if ('method' in message) {
          if (message.method === 'tools/call') {
            const params = message.params as { name?: unknown; arguments?: unknown } | undefined;
            if (
              !params ||
              typeof params.name !== 'string' ||
              !params.arguments ||
              typeof params.arguments !== 'object' ||
              Array.isArray(params.arguments)
            )
              throw new Error('invalid browser tool call');
            assertBrowserCall(browser, params.name, params.arguments as Record<string, unknown>);
            if (preview) {
              try {
                await preview.revalidate();
              } catch (error) {
                await transport.close();
                throw error;
              }
            }
          } else if (message.method.startsWith('resources/'))
            throw new Error('browser resource access is unavailable');
        }
        await send(message);
      };
    let lease: ReturnType<typeof recordWorkerLease> | undefined;
    let reservation: HostProcessReservation | undefined;
    let spawnedPid: number | undefined;
    let ownedPid: number | undefined;
    let closing: Promise<void> | undefined;
    let closeRequested = false;
    let startRequested = false;
    const releaseCapacity = () => {
      reservation?.releaseConfirmed();
      reservation = undefined;
    };
    let closed: () => void = () => {};
    const streamsClosed = new Promise<void>((resolve) => {
      closed = resolve;
    });
    transport.onClose(() => {
      closed();
      // Unexpected server exit must also attest descendants before returning capacity.
      queueMicrotask(() => {
        void transport.close().catch(() => {});
      });
    });
    transport.close = () => {
      closeRequested = true;
      if (closing) return closing;
      closing = (async () => {
        let nativeConfirmed = false;
        try {
          if (nativeOwner && ownedPid) {
            // Do not let the transport kill the job owner before its accounting is read back.
            if (!(await ownedWindowsProcessGone(ownedPid))) nativeOwner.stop();
            let confirmed = false;
            for (let attempt = 0; attempt < 200; attempt++) {
              if (await ownedWindowsProcessGone(ownedPid)) {
                confirmed = true;
                break;
              }
              await delay(50);
            }
            if (!confirmed) throw new Error('MCP process cleanup is unconfirmed');
            nativeConfirmed = true;
          }
        } finally {
          await close();
          // A signaled process can still hold its cwd/stdio handles until the close event.
          await streamsClosed;
          await lease?.reap();
          if (nativeOwner && !ownedPid) await nativeOwner.dispose();
          if (!spawnedPid || nativeConfirmed || (process.platform === 'linux' && lease))
            releaseCapacity();
        }
      })();
      return closing;
    };
    transport.start = async () => {
      if (startRequested || closeRequested)
        throw new Error('MCP transport is already started or closed');
      startRequested = true;
      await authorization(server.id);
      if (closeRequested) throw new Error('MCP transport is closed');
      reservation = await acquireHostProcessGroup();
      if (closeRequested) {
        releaseCapacity();
        throw new Error('MCP transport is closed');
      }
      const starting = start();
      try {
        if (transport.pid) {
          spawnedPid = transport.pid;
          if (nativeOwner) {
            ownedPid = transport.pid;
            nativeOwner.register(ownedPid);
          }
          lease = recordWorkerLease(leaseDirectory, transport.pid, processOwner);
        }
        await starting;
      } catch (error) {
        await starting.catch(() => {});
        await transport.close();
        throw error;
      }
    };
    return transport;
  }
  return new StreamableHttpTransport({
    url: server.url,
    maxMessageBytes: 2 * 1024 * 1024,
    authProvider: {
      token: () => authorization(server.id),
      onUnauthorized: async ({ response, token }) => {
        if (response.status !== 401 && response.status !== 403)
          throw new Error('MCP authorization failed');
        await authorization(server.id, {
          status: response.status,
          ...(token ? { rejectedToken: token } : {}),
          ...(response.headers.get('www-authenticate')
            ? { wwwAuthenticate: response.headers.get('www-authenticate')! }
            : {}),
        });
      },
    },
  });
}
