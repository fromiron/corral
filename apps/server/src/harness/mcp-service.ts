import { createHash } from 'node:crypto';
import {
  assertBrowserCall,
  type McpProbeTool,
  probeMcp,
  type SdkResources,
} from '@corral/adapter-pi';
import {
  type AgentStartInput,
  type Clock,
  canonicalJson,
  type EffectiveHarnessSnapshot,
  type McpChallenge,
  type ProjectToolConfig,
  type ProjectToolConfigRevision,
} from '@corral/contracts';
import type { SqliteHarnessStore } from '@corral/storage-sqlite';
import type { WorkspaceService } from '../files/service.ts';
import type { McpCredentials } from './mcp-credentials.ts';

export interface ProbeResult {
  operationId: string;
  configRevision: number;
  fingerprint: string;
  observedAt: string;
  tools: McpProbeTool[];
}
const cancellationKey = (id: string) =>
  `probe_cancel_${createHash('sha256').update(id).digest('hex')}`;

export class McpService {
  readonly files: WorkspaceService;
  readonly credentials: McpCredentials;
  private readonly probeOptions: {
    store: SqliteHarnessStore;
    clock: Clock;
    leaseDirectory: string;
    runProbe?: typeof probeMcp;
  };
  private probeJob: {
    operationId: string;
    key: string;
    projectId: string;
    controller: AbortController;
    promise: Promise<ProbeResult>;
  } | null = null;
  private cleanupFailed = false;
  private changingConfiguration = false;
  constructor(
    files: WorkspaceService,
    credentials: McpCredentials,
    probeOptions: McpService['probeOptions'],
  ) {
    this.files = files;
    this.credentials = credentials;
    this.probeOptions = probeOptions;
  }

  probe(
    projectId: string,
    serverId: string,
    input: { operationId: string; configRevision: number; fingerprint: string; sessionId?: string },
  ): Promise<ProbeResult> {
    const request = { projectId, serverId, ...input };
    const key = canonicalJson(request);
    const cached = this.probeOptions.store.receiptResult<ProbeResult | { error: string }>(
      input.operationId,
      request,
    );
    if (cached)
      return 'error' in cached ? Promise.reject(new Error(cached.error)) : Promise.resolve(cached);
    if (
      this.probeOptions.store.receiptResult(cancellationKey(input.operationId), {
        operationId: input.operationId,
      })
    )
      return Promise.reject(new Error('MCP probe cancelled'));
    if (this.probeJob?.operationId === input.operationId) {
      if (this.probeJob.key !== key) return Promise.reject(new Error('operation payload changed'));
      return this.probeJob.promise;
    }
    if (this.probeJob || this.cleanupFailed || this.changingConfiguration)
      return Promise.reject(new Error('MCP probe is busy or cleanup is unconfirmed'));
    const controller = new AbortController();
    const promise = (async (): Promise<ProbeResult> => {
      const context = await this.files.mcpProbeContext(
        projectId,
        serverId,
        input.configRevision,
        input.sessionId,
      );
      const check = async () => {
        const current = await this.files.mcpProbeContext(
          projectId,
          serverId,
          input.configRevision,
          input.sessionId,
        );
        if (
          controller.signal.aborted ||
          !current.trustedAt ||
          current.fingerprint !== input.fingerprint ||
          current.copyIdentity !== context.copyIdentity ||
          current.cwd !== context.cwd
        )
          throw new Error('MCP launch requires current fingerprint trust');
      };
      await check();
      const tools = await (this.probeOptions.runProbe ?? probeMcp)({
        server: context.server,
        ...(context.cwd ? { cwd: context.cwd } : {}),
        leaseDirectory: this.probeOptions.leaseDirectory,
        signal: controller.signal,
        authorization: async (_id, challenge) => {
          await check();
          return context.server.transport === 'http'
            ? this.credentials.authorization(projectId, context.server, check, challenge)
            : undefined;
        },
      });
      await check();
      return this.probeOptions.store.receipt(input.operationId, request, () => ({
        operationId: input.operationId,
        configRevision: input.configRevision,
        fingerprint: input.fingerprint,
        observedAt: this.probeOptions.clock.nowIso(),
        tools,
      }));
    })()
      .catch((error) => {
        if (error instanceof Error && error.message === 'MCP probe cleanup unconfirmed')
          this.cleanupFailed = true;
        const message = this.cleanupFailed
          ? 'MCP probe cleanup unconfirmed'
          : controller.signal.aborted
            ? 'MCP probe cancelled'
            : error instanceof Error &&
                [
                  'MCP probe failed',
                  'MCP probe timed out',
                  'MCP probe authorization failed',
                  'MCP launch requires current fingerprint trust',
                  'project tool revision changed',
                ].includes(error.message)
              ? error.message
              : 'MCP probe failed';
        this.probeOptions.store.receipt(input.operationId, request, () => ({ error: message }));
        throw new Error(message);
      })
      .finally(() => {
        if (this.probeJob?.operationId === input.operationId) this.probeJob = null;
      });
    this.probeJob = { operationId: input.operationId, key, projectId, controller, promise };
    return promise;
  }

  async cancelProbe(operationId?: string, projectId?: string) {
    const job = this.probeJob;
    const id =
      operationId ??
      (job?.projectId === projectId || projectId === undefined ? job?.operationId : undefined);
    if (id)
      this.probeOptions.store.receipt(cancellationKey(id), { operationId: id }, () => ({
        cancelled: true,
      }));
    if (
      this.cleanupFailed ||
      (id &&
        this.probeOptions.store.receiptOutcome<{ error?: string }>(id)?.error ===
          'MCP probe cleanup unconfirmed')
    )
      throw new Error('MCP probe cleanup unconfirmed');
    if (
      !job ||
      (operationId && job.operationId !== operationId) ||
      (projectId && job.projectId !== projectId)
    )
      return;
    job.controller.abort();
    await job.promise.catch(() => {});
    if (this.cleanupFailed) throw new Error('MCP probe cleanup unconfirmed');
  }

  async updateTools(
    projectId: string,
    expectedRevision: number,
    build: () => ProjectToolConfig,
    operation?: { operationId: string; input: unknown },
  ): Promise<ProjectToolConfigRevision> {
    if (operation) {
      const cached = this.probeOptions.store.receiptResult<ProjectToolConfigRevision>(
        operation.operationId,
        operation.input,
      );
      if (cached) return cached;
    }
    if ((this.files.projectTools.latest(projectId)?.revision ?? 0) !== expectedRevision)
      throw new Error('project tool revision changed');
    const config = this.files.validateProjectTools(projectId, expectedRevision, build());
    if (this.changingConfiguration)
      throw new Error('MCP settings are being saved; retry after completion');
    this.changingConfiguration = true;
    try {
      await this.cancelProbe(undefined, projectId);
      const save = () => this.files.configureProjectTools(projectId, expectedRevision, config);
      return operation
        ? this.probeOptions.store.receipt(operation.operationId, operation.input, save)
        : save();
    } finally {
      this.changingConfiguration = false;
    }
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
    const selected = runtime.servers.find(({ server }) => server.id === id)?.server;
    if (selected?.transport === 'stdio' && selected.browser)
      assertBrowserCall(selected.browser, name.slice(`mcp__${id}__`.length), args);
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
