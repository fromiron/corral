import type { SdkResources } from '@corral/adapter-pi';
import {
  type AgentStartInput,
  canonicalJson,
  type EffectiveHarnessSnapshot,
  type McpChallenge,
} from '@corral/contracts';
import type { WorkspaceService } from '../files/service.ts';
import type { McpCredentials } from './mcp-credentials.ts';

export class McpService {
  readonly files: WorkspaceService;
  readonly credentials: McpCredentials;
  constructor(files: WorkspaceService, credentials: McpCredentials) {
    this.files = files;
    this.credentials = credentials;
  }

  async resources(
    runId: string,
    harness: EffectiveHarnessSnapshot,
  ): Promise<Pick<SdkResources, 'cwd' | 'mcp'>> {
    const selection = harness.projectTools;
    if (selection?.mcpServerIds?.length) {
      if (harness.policy !== 'trusted-native')
        throw new Error('MCP requires trusted-native policy');
      const runtime = await this.files.runtimeMcp(runId, selection);
      return { cwd: runtime.cwd, mcp: runtime.servers };
    }
    const cwd =
      harness.policy === 'trusted-native' ? this.files.workingDirectoryForRun(runId) : null;
    return cwd ? { cwd } : {};
  }
  async checkTool(input: AgentStartInput, name: string, args: Record<string, unknown>) {
    const selection = input.harness?.projectTools;
    if (input.harness?.policy !== 'trusted-native' || !selection?.mcpServerIds?.length)
      throw new Error('MCP server is not selected');
    const runtime = await this.files.runtimeMcp(input.runId, selection);
    const id = /^mcp__(.+?)__/.exec(name)?.[1];
    if (
      id
        ? !runtime.servers.some(({ server }) => server.id === id)
        : !['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'].includes(
            name,
          ) ||
          (args.server !== undefined &&
            !runtime.servers.some(({ server }) => server.id === args.server))
    )
      throw new Error('MCP server is not selected');
  }
  async authorization(input: AgentStartInput, id: string, challenge?: McpChallenge) {
    const selection = input.harness?.projectTools;
    if (input.harness?.policy !== 'trusted-native' || !selection?.mcpServerIds?.includes(id))
      throw new Error('MCP server is not selected');
    const selected = (await this.files.runtimeMcp(input.runId, selection)).servers.find(
      ({ server }) => server.id === id,
    );
    if (!selected) throw new Error('MCP server is not selected');
    if (selected.server.transport === 'stdio') return;
    return this.credentials.authorization(
      selection.projectId,
      selected.server,
      async () => {
        const current = (await this.files.runtimeMcp(input.runId, selection)).servers.find(
          ({ server }) => server.id === id,
        );
        if (!current || current.fingerprint !== selected.fingerprint)
          throw new Error('MCP trust changed');
      },
      challenge,
    );
  }
  async authentication(projectId: string, id: string, fingerprint: string) {
    const inspected = await this.files.inspectMcpServer(projectId, id);
    if (
      inspected.server.transport !== 'http' ||
      !inspected.trustedAt ||
      inspected.fingerprint !== fingerprint
    )
      throw new Error('MCP launch requires current fingerprint trust');
    const check = async () => {
      const current = await this.files.inspectMcpServer(projectId, id);
      if (
        !current.trustedAt ||
        current.fingerprint !== fingerprint ||
        canonicalJson(current.server) !== canonicalJson(inspected.server)
      )
        throw new Error('MCP trust changed');
    };
    return { server: inspected.server, check };
  }
}
