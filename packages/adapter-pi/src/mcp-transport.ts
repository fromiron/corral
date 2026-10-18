import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { McpChallenge, RegisteredMcpServer } from '@corral/contracts';
import { StdioTransport, StreamableHttpTransport } from '@earendil-works/pi-mcp';
import { recordWorkerLease } from './worker-leases.ts';

export function createCorralMcpTransport(
  server: RegisteredMcpServer,
  cwd: string | undefined,
  directory: string,
  authorization: (id: string, challenge?: McpChallenge) => Promise<string | undefined>,
  leaseDirectory: string,
) {
  if (server.transport === 'stdio') {
    const processOwner = randomUUID();
    const transport = new StdioTransport({
      command: server.argv[0]!,
      args: server.argv.slice(1),
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
