import { join } from 'node:path';
import { canonicalJson, type McpChallenge } from '@corral/contracts';
import { createMcpExtension } from '@earendil-works/pi-coding-agent';
import { createCorralMcpTransport } from './mcp-transport.ts';
import type { SdkResources } from './protocol.ts';

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
      const bound = resources.mcp!.find((item) => item.server.id === entry.name)!;
      return createCorralMcpTransport(bound.server, cwd, directory, authorization, leaseDirectory);
    },
  });
}
