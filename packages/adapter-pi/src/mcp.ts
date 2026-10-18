import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { canonicalJson, type McpChallenge } from '@corral/contracts';
import { createMcpExtension } from '@earendil-works/pi-coding-agent';
import { StdioTransport, StreamableHttpTransport } from '@earendil-works/pi-mcp';
import type { SdkResources } from './protocol.ts';
import { recordWorkerLease } from './worker-leases.ts';

export function mcpExtension(
  resources: SdkResources,
  directory: string,
  authorization: (id: string, challenge?: McpChallenge) => Promise<string | undefined>,
  leaseDirectory = join(directory, 'child-leases'),
) {
  const servers = (resources.mcp ?? []).map(({ server, fingerprint }) => ({
    name: server.id,
    source: `corral:${fingerprint}`,
    scope: 'project' as const,
    config: {
      ...(server.transport === 'stdio'
        ? { type: 'stdio' as const, command: server.argv[0]!, args: server.argv.slice(1) }
        : { type: 'http' as const, url: server.url }),
      exposure: server.exposure,
      timeout: server.timeoutMs / 1000,
    },
  }));
  return createMcpExtension({
    loadConfig: () => ({ servers, autoEnableCodemode: false, errors: [] }),
    logPath: join(directory, 'mcp.log'),
    openUrl: () => {
      throw new Error('Use Corral settings to sign in.');
    },
    updateConfig: () => {
      throw new Error('Use Corral settings to change MCP servers.');
    },
    createTransport: (entry, cwd) => {
      const selected = servers.find((server) => server.name === entry.name);
      if (!selected || canonicalJson(selected) !== canonicalJson(entry) || cwd !== resources.cwd)
        throw new Error('MCP server is not bound to this execution');
      if ('command' in selected.config) {
        const processOwner = randomUUID();
        const transport = new StdioTransport({
          command: selected.config.command,
          args: selected.config.args,
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
          await authorization(entry.name);
          const starting = start();
          try {
            if (transport.pid)
              lease = recordWorkerLease(leaseDirectory, transport.pid, processOwner);
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
        url: selected.config.url,
        maxMessageBytes: 2 * 1024 * 1024,
        authProvider: {
          token: () => authorization(entry.name),
          onUnauthorized: async ({ response, token }) => {
            if (response.status !== 401 && response.status !== 403)
              throw new Error('MCP authorization failed');
            await authorization(entry.name, {
              status: response.status,
              ...(token ? { rejectedToken: token } : {}),
              ...(response.headers.get('www-authenticate')
                ? { wwwAuthenticate: response.headers.get('www-authenticate')! }
                : {}),
            });
          },
        },
      });
    },
  });
}
