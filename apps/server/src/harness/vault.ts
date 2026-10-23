import { createHash } from 'node:crypto';
import {
  ContentHash,
  canonicalJson,
  HarnessEntryKey,
  Identifier,
  McpServerDraft,
  PinnedPackageSource,
  type ProjectToolConfig,
  ProjectToolConfigRevision,
  RegisteredMcpServer,
} from '@corral/contracts';
import { z } from 'zod';
import type { VaultDomainAdapter } from '../vault/types.ts';
import type { HarnessService } from './service.ts';

const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const Ref = z.strictObject({
  hash: ContentHash,
  name: z.string().min(1).max(100),
  version: z.string().min(1).max(100),
  source: PinnedPackageSource.optional(),
});
const Plugins = z.strictObject({
  version: z.literal(1),
  packages: z.array(Ref.extend({ status: z.enum(['enabled', 'disabled', 'removed']) })).max(256),
});
const Skills = z.strictObject({
  version: z.literal(1),
  entries: z
    .array(
      HarnessEntryKey.extend({
        name: z.string().max(100),
        archived: z.boolean(),
      }),
    )
    .max(256),
});
const PortableMcp = z.strictObject({
  version: z.literal(1),
  servers: z
    .array(
      z.strictObject({
        id: Identifier,
        name: z.string().min(1).max(100),
        transport: z.enum(['http', 'stdio']),
        url: z.string().optional(),
        sourcePackageHash: ContentHash.optional(),
      }),
    )
    .max(16),
});
const PreparedMcp = z.strictObject({
  kind: z.literal('prepared-mcp'),
  projectId: Identifier,
  servers: z.array(RegisteredMcpServer).max(16),
});
const id = (operation: string, value: unknown) => `vault_${hash([operation, value]).slice(0, 32)}`;

/** Portable references retain their local owners. A vault never installs or trusts code. */
export function createHarnessVaultAdapters(options: {
  harness: HarnessService;
  projectId?: string;
}): Record<'skills' | 'plugins', VaultDomainAdapter> & { mcp?: VaultDomainAdapter } {
  const { harness, projectId } = options;
  if (projectId !== undefined) Identifier.parse(projectId);
  const requireProject = () => {
    if (!projectId) throw new Error('Bind projectId explicitly before importing MCP definitions.');
    return projectId;
  };
  const store = harness.store;
  const resolveResource = (source: string, bindings: Record<string, string>) => {
    const target = bindings[`resource:${source}`] ?? source;
    ContentHash.parse(target);
    if (!store.getResource(target))
      throw new Error(`Install and bind resource:${source} locally before importing.`);
    return target;
  };
  const packageState = () =>
    store
      .listResources()
      .map((resource) => ({
        ...store.packageManagement(resource.hash),
        hash: resource.hash,
        name: resource.name,
        version: resource.version,
        ...(resource.sourceKind !== 'local' &&
        PinnedPackageSource.safeParse(resource.sourceLabel).success
          ? { source: resource.sourceLabel }
          : {}),
      }))
      .sort((a, b) => a.hash.localeCompare(b.hash));
  const skillState = () =>
    store
      .listResources()
      .flatMap((resource) =>
        resource.skills.map((skill) => {
          const key = { resourceHash: resource.hash, entry: skill.entry, kind: 'skill' as const };
          return { ...key, name: skill.name, ...store.entryManagement(key) };
        }),
      )
      .sort((a, b) => `${a.resourceHash}:${a.entry}`.localeCompare(`${b.resourceHash}:${b.entry}`));
  const receipt = async (operationId: string) =>
    store.receiptOutcome<{ revision: string }>(operationId) ?? null;
  const pluginUpdate = async (
    raw: unknown,
    expected: string,
    operationId: string,
    restoring: boolean,
  ) => {
    const data = Plugins.parse(raw);
    const result = store.receipt(operationId, { data, expected, restoring }, () => {
      if (hash(packageState()) !== expected)
        throw new Error('Package settings changed since preview.');
      for (const item of data.packages) {
        if (!store.getResource(item.hash))
          throw new Error('A bound package is no longer installed.');
        const state = store.packageManagement(item.hash);
        store.managePackage(
          item.hash,
          state.managementRevision,
          restoring ? item.status : item.status === 'removed' ? 'removed' : 'disabled',
        );
      }
      return { revision: hash(packageState()) };
    });
    for (const item of data.packages)
      if (store.packageManagement(item.hash).status !== 'enabled')
        await harness.mcp?.cancelPackageProbe(item.hash);
    return result;
  };
  const skillUpdate = async (raw: unknown, expected: string, operationId: string) => {
    const data = Skills.parse(raw);
    return store.receipt(operationId, { data, expected }, () => {
      if (hash(skillState()) !== expected) throw new Error('Skill settings changed since preview.');
      for (const entry of data.entries) {
        const resource = store.getResource(entry.resourceHash);
        if (
          entry.kind !== 'skill' ||
          !resource?.skills.some((skill) => skill.entry === entry.entry)
        )
          throw new Error('A bound skill is no longer installed.');
        const key = HarnessEntryKey.parse({
          resourceHash: entry.resourceHash,
          entry: entry.entry,
          kind: entry.kind,
        });
        const state = store.entryManagement(key);
        harness.archiveEntry(key, state.managementRevision, entry.archived, id(operationId, key));
      }
      return { revision: hash(skillState()) };
    });
  };
  const mcpState = () => {
    const config = harness.projectTools.latest(requireProject());
    return { config, revision: hash(config) };
  };
  const mcpReceipt = async (operationId: string) => {
    const config =
      store.receiptOutcome<ReturnType<typeof harness.projectTools.latest>>(operationId);
    return config ? { revision: hash(config) } : null;
  };
  const updateMcp = async (
    config: z.infer<typeof ProjectToolConfig>,
    expected: string,
    operationId: string,
    value: unknown,
  ) => {
    if (!harness.mcp) throw new Error('MCP runtime is unavailable.');
    const input = { value, expected, projectId };
    const cached = store.receiptResult<z.infer<typeof ProjectToolConfigRevision>>(
      operationId,
      input,
    );
    if (cached) return { revision: hash(cached) };
    const current = mcpState();
    if (current.revision !== expected) throw new Error('MCP settings changed since preview.');
    const saved = await harness.mcp.updateTools(
      requireProject(),
      current.config?.revision ?? 0,
      () => config,
      {
        operationId,
        input,
      },
    );
    return { revision: hash(saved) };
  };
  const adapters: Record<'mcp' | 'skills' | 'plugins', VaultDomainAdapter> = {
    plugins: {
      async capture() {
        const state = packageState();
        return {
          revision: hash(state),
          value: Plugins.parse({
            version: 1,
            packages: state.map(({ hash, name, version, status, source }) => ({
              hash,
              name,
              version,
              status,
              ...(source ? { source } : {}),
            })),
          }),
        };
      },
      async preview(raw, bindings) {
        const data = Plugins.parse(raw);
        const packages = data.packages.map((item) => ({
          ...item,
          hash: resolveResource(item.hash, bindings),
          status: item.status === 'removed' ? ('removed' as const) : ('disabled' as const),
        }));
        if (new Set(packages.map((item) => item.hash)).size !== packages.length)
          throw new Error('Duplicate local package binding.');
        return {
          value: { version: 1, packages },
          warnings: [
            'Only installed package references and library status are imported. Package binaries, trust, profile bindings and native permissions remain local.',
            'Imported packages are disabled for future runs until explicitly enabled. Existing runs retain their pinned versions.',
          ],
        };
      },
      apply: (value, revision, operationId) => pluginUpdate(value, revision, operationId, false),
      restore: (snapshot, revision, operationId) =>
        pluginUpdate(snapshot.value, revision, operationId, true),
      receipt,
    },
    skills: {
      async capture() {
        const state = skillState();
        return {
          revision: hash(state),
          value: {
            version: 1,
            entries: state.map(({ resourceHash, entry, kind, name, archivedAt }) => ({
              resourceHash,
              entry,
              kind,
              name,
              archived: archivedAt !== null,
            })),
          },
        };
      },
      async preview(raw, bindings) {
        const data = Skills.parse(raw);
        const entries = data.entries.map((entry) => {
          const resourceHash = resolveResource(entry.resourceHash, bindings);
          const resource = store.getResource(resourceHash);
          if (
            entry.kind !== 'skill' ||
            !resource?.skills.some((skill) => skill.entry === entry.entry)
          )
            throw new Error('Map each skill to its installed entry before importing.');
          return { ...entry, resourceHash };
        });
        if (
          new Set(entries.map((entry) => `${entry.resourceHash}:${entry.entry}`)).size !==
          entries.length
        )
          throw new Error('Duplicate local skill binding.');
        return {
          value: { version: 1, entries },
          warnings: [
            'Only existing skill references and library archive state are imported. Skill text, trust and active work-style selections are not changed.',
            'Missing skills must be installed and reviewed separately before binding this import.',
          ],
        };
      },
      apply: skillUpdate,
      restore: (snapshot, revision, operationId) =>
        skillUpdate(snapshot.value, revision, operationId),
      receipt,
    },
    mcp: {
      async capture(options) {
        const current = mcpState();
        if (options?.purpose === 'rollback')
          return {
            revision: current.revision,
            value: { kind: 'local-mcp-rollback', projectId, config: current.config },
          };
        return {
          revision: current.revision,
          value: {
            version: 1,
            servers: (current.config?.mcpServers ?? []).map((server) => ({
              id: server.id,
              name: server.name,
              transport: server.transport,
              ...(server.sourcePackageHash ? { sourcePackageHash: server.sourcePackageHash } : {}),
              // URLs can carry credentials in a query; all endpoints are explicit local bindings.
            })),
          },
        };
      },
      async preview(raw, bindings) {
        const data = PortableMcp.parse(raw);
        if (bindings.projectId !== projectId)
          throw new Error('Bind projectId explicitly before importing MCP definitions.');
        const servers = data.servers.map((source) => {
          const value =
            bindings[`${source.transport === 'http' ? 'endpoint' : 'argv'}:${source.id}`];
          if (!value)
            throw new Error(
              `Bind ${source.transport === 'http' ? 'endpoint' : 'argv'}:${source.id} locally before importing.`,
            );
          const common = {
            name: source.name,
            enabled: false,
            exposure: 'direct' as const,
            timeoutMs: 30000,
          };
          const draft = McpServerDraft.parse(
            source.transport === 'http'
              ? { ...common, transport: 'http', url: value, auth: { kind: 'none' } }
              : { ...common, transport: 'stdio', argv: JSON.parse(value) },
          );
          return RegisteredMcpServer.parse({
            ...draft,
            id: `vault_${hash([projectId, source.id, draft]).slice(0, 24)}`,
            ...(source.sourcePackageHash
              ? { sourcePackageHash: resolveResource(source.sourcePackageHash, bindings) }
              : {}),
          });
        });
        return {
          value: PreparedMcp.parse({ kind: 'prepared-mcp', projectId, servers }),
          warnings: [
            'MCP endpoints and commands require explicit local bindings. Credentials, browser recipes, launch trust and automatic connections are excluded.',
            'Imported definitions are disabled and added to this project. Review each launch and configure sign-in before enabling it.',
          ],
        };
      },
      async apply(raw, expected, operationId) {
        const data = PreparedMcp.parse(raw);
        if (data.projectId !== projectId) throw new Error('MCP target project changed.');
        const current = mcpState().config;
        const ids = new Set(data.servers.map((server) => server.id));
        return updateMcp(
          {
            checks: current?.checks ?? [],
            lspServers: current?.lspServers ?? [],
            ...(current?.debugAdapters ? { debugAdapters: current.debugAdapters } : {}),
            ...(current?.debugConfigurations
              ? { debugConfigurations: current.debugConfigurations }
              : {}),
            ...(current?.deployments ? { deployments: current.deployments } : {}),
            mcpServers: [
              ...(current?.mcpServers ?? []).filter((server) => !ids.has(server.id)),
              ...data.servers.map((server) => ({ ...server, enabled: false })),
            ],
          },
          expected,
          operationId,
          data,
        );
      },
      async restore(snapshot, expected, operationId) {
        const value = z
          .strictObject({
            kind: z.literal('local-mcp-rollback'),
            projectId: Identifier,
            config: ProjectToolConfigRevision.nullable(),
          })
          .parse(snapshot.value);
        if (value.projectId !== projectId)
          throw new Error('Cannot restore MCP settings to another project.');
        const config = value.config;
        return updateMcp(
          {
            checks: config?.checks ?? [],
            lspServers: config?.lspServers ?? [],
            ...(config?.debugAdapters ? { debugAdapters: config.debugAdapters } : {}),
            ...(config?.debugConfigurations
              ? { debugConfigurations: config.debugConfigurations }
              : {}),
            ...(config?.deployments ? { deployments: config.deployments } : {}),
            mcpServers: config?.mcpServers ?? [],
          },
          expected,
          operationId,
          value,
        );
      },
      receipt: mcpReceipt,
    },
  };
  return projectId ? adapters : { skills: adapters.skills, plugins: adapters.plugins };
}
