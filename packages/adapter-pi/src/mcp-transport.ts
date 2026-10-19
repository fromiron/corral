import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpChallenge, RegisteredMcpServer } from '@corral/contracts';
import { StdioTransport, StreamableHttpTransport } from '@earendil-works/pi-mcp';
import { assertBrowserCall } from './browser-policy.ts';
import { recordWorkerLease } from './worker-leases.ts';

const BROWSER_ENTRY = fileURLToPath(new URL('./browser-launcher.ts', import.meta.url));

export function createCorralMcpTransport(
  server: RegisteredMcpServer,
  cwd: string | undefined,
  directory: string,
  authorization: (id: string, challenge?: McpChallenge) => Promise<string | undefined>,
  leaseDirectory: string,
) {
  if (server.transport === 'stdio') {
    let command = server.argv[0]!,
      args = server.argv.slice(1);
    if (server.browser) {
      if (process.platform !== 'linux' || !cwd)
        throw new Error('owned browser requires a Linux working copy');
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink())
        throw new Error('private browser directory unavailable');
      const owned = mkdtempSync(join(directory, 'browser-'));
      const config = join(owned, 'owner.json');
      writeFileSync(config, JSON.stringify(server), { mode: 0o600, flag: 'wx' });
      command = process.execPath;
      args = [BROWSER_ENTRY, config];
    }
    const processOwner = randomUUID();
    const transport = new StdioTransport({
      command,
      args,
      cwd,
      inheritEnv: false,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: directory,
        XDG_CONFIG_HOME: join(directory, 'config'),
        CLAUDE_CONFIG_DIR: join(directory, 'claude'),
        LANG: 'C.UTF-8',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
        CORRAL_PROCESS_OWNER: processOwner,
      },
      stderr: 'pipe',
      maxMessageBytes: 2 * 1024 * 1024,
      maxStderrBytes: 4096,
      closeTimeoutMs: 1000,
    });
    const start = transport.start.bind(transport);
    const close = transport.close.bind(transport);
    const send = transport.send.bind(transport);
    if (server.browser)
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
            assertBrowserCall(
              server.browser!,
              params.name,
              params.arguments as Record<string, unknown>,
            );
          } else if (message.method.startsWith('resources/'))
            throw new Error('browser resource access is unavailable');
        }
        await send(message);
      };
    let lease: ReturnType<typeof recordWorkerLease> | undefined;
    transport.onClose(() => {
      void lease?.reap().catch(() => {});
    });
    transport.close = async () => {
      try {
        await close();
      } finally {
        await lease?.reap();
      }
    };
    transport.start = async () => {
      await authorization(server.id);
      const starting = start();
      try {
        if (transport.pid) lease = recordWorkerLease(leaseDirectory, transport.pid, processOwner);
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
