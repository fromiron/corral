import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectToolConfig } from '@corral/contracts';
import { openDatabase } from '@corral/storage-sqlite';
import { FakeClock } from '@corral/testkit';
import { expect, it } from 'vitest';
import { WorkspaceService } from '../src/files/service.ts';
import { McpCredentials } from '../src/harness/mcp-credentials.ts';
import { McpService } from '../src/harness/mcp-service.ts';
import { HarnessService } from '../src/harness/service.ts';
import { createHarnessVaultAdapters } from '../src/harness/vault.ts';

async function setup(runProbe?: ConstructorParameters<typeof McpService>[2]['runProbe']) {
  const root = mkdtempSync(join(tmpdir(), 'corral-harness-vault-'));
  const db = openDatabase(':memory:'),
    clock = new FakeClock();
  const files = new WorkspaceService({
    db,
    clock,
    worktreeRoot: join(root, 'copies'),
    forbidden: [],
  });
  const credentials = new McpCredentials({ directory: join(root, 'credentials') });
  execFileSync('git', ['init', '-q', join(root, 'repository')]);
  await files.bind('default', join(root, 'repository'));
  await files.configure('default', { trusted: true });
  const harness = new HarnessService({
    root: join(root, 'resources'),
    db,
    clock,
    inspect: async () => ({
      name: 'vault-fixture',
      version: '1',
      license: 'MIT',
      packagePath: null,
      extensions: [],
      skills: [{ name: 'guide', description: 'Guide', entry: 'SKILL.md' }],
    }),
  });
  const mcp = new McpService(files, credentials, {
    store: harness.store,
    clock,
    leaseDirectory: join(root, 'leases'),
    ...(runProbe ? { runProbe } : {}),
  });
  const service = new HarnessService({
    root: join(root, 'resources'),
    db,
    clock,
    mcp,
    inspect: async () => ({
      name: 'vault-fixture',
      version: '1',
      license: 'MIT',
      packagePath: null,
      extensions: [],
      skills: [{ name: 'guide', description: 'Guide', entry: 'SKILL.md' }],
    }),
  });
  const source = join(root, 'package');
  mkdirSync(source);
  writeFileSync(
    join(source, 'SKILL.md'),
    'Private skill body must not be copied by the settings vault.',
  );
  const resource = service.install((await service.discoverLocal(source)).reviewId);
  const adapters = createHarnessVaultAdapters({ harness: service, projectId: 'default' });
  if (!adapters.mcp) throw new Error('Missing explicitly bound MCP adapter');
  return {
    adapters: { ...adapters, mcp: adapters.mcp },
    service,
    files,
    resource,
    root,
    async close() {
      service.dispose();
      harness.dispose();
      await credentials.dispose();
      await files.dispose();
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

it('package trust gates new owned MCP launches without changing standalone MCP trust', async () => {
  let launches = 0;
  const s = await setup(async () => {
    launches++;
    return [];
  });
  try {
    const mcp = s.service.mcp;
    if (!mcp) throw new Error('Missing MCP runtime');
    s.files.configureProjectTools('default', 0, {
      checks: [],
      lspServers: [],
      mcpServers: ['owned', 'standalone'].map((id) => ({
        id,
        name: id,
        transport: 'http' as const,
        url: 'http://127.0.0.1:9/mcp',
        auth: { kind: 'none' as const },
        exposure: 'direct' as const,
        timeoutMs: 1000,
        ...(id === 'owned' ? { sourcePackageHash: s.resource.hash } : {}),
      })),
    });
    const owned = await s.files.inspectMcpServer('default', 'owned');
    const standalone = await s.files.inspectMcpServer('default', 'standalone');
    await s.files.trustMcpServer('default', 'owned', owned.fingerprint, true);
    await s.files.trustMcpServer('default', 'standalone', standalone.fingerprint, true);
    const probe = (serverId: string, fingerprint: string, operationId: string) =>
      mcp.probe('default', serverId, { fingerprint, operationId, configRevision: 1 });
    await expect(probe('owned', owned.fingerprint, 'untrusted_package')).rejects.toThrow(
      'package requires trust',
    );
    expect(launches).toBe(0);
    s.service.trust(s.resource.hash, true);
    await expect(probe('owned', owned.fingerprint, 'trusted_package')).resolves.toMatchObject({
      tools: [],
    });
    expect(launches).toBe(1);
    s.service.trust(s.resource.hash, false);
    await expect(probe('owned', owned.fingerprint, 'revoked_package')).rejects.toThrow(
      'package requires trust',
    );
    await expect(
      probe('standalone', standalone.fingerprint, 'standalone_probe'),
    ).resolves.toMatchObject({ tools: [] });
    expect(launches).toBe(2);
    expect((await s.files.inspectMcpServer('default', 'owned')).trustedAt).not.toBeNull();
  } finally {
    await s.close();
  }
});

it('exports safe installed references and applies library state through owners with recoverable receipts', async () => {
  const s = await setup();
  try {
    const global = createHarnessVaultAdapters({ harness: s.service });
    expect(global.mcp).toBeUndefined();
    expect(await global.plugins.capture()).toEqual(await s.adapters.plugins.capture());
    const packages = await s.adapters.plugins.capture();
    const skills = await s.adapters.skills.capture();
    expect(JSON.stringify([packages, skills])).not.toContain(s.root);
    expect(JSON.stringify([packages, skills])).not.toContain('Private skill body');
    const imported = await s.adapters.plugins.preview(packages.value, {});
    const result = await s.adapters.plugins.apply(
      imported.value,
      packages.revision,
      'vault_plugins',
    );
    expect(s.service.store.packageManagement(s.resource.hash).status).toBe('disabled');
    expect(s.service.store.getResource(s.resource.hash)?.trustedAt).toBeNull();
    expect(await s.adapters.plugins.receipt?.('vault_plugins')).toEqual(result);
    expect(
      await s.adapters.plugins.apply(imported.value, packages.revision, 'vault_plugins'),
    ).toEqual(result);
    await s.adapters.plugins.restore(packages, result.revision, 'restore_plugins');
    expect(s.service.store.packageManagement(s.resource.hash).status).toBe('enabled');
    await expect(
      s.adapters.plugins.preview(
        {
          version: 1,
          packages: [{ hash: 'f'.repeat(64), name: 'missing', version: '1', status: 'enabled' }],
        },
        {},
      ),
    ).rejects.toThrow('Install and bind');
    const key = { resourceHash: s.resource.hash, entry: 'SKILL.md', kind: 'skill' as const };
    const prepared = await s.adapters.skills.preview(
      { version: 1, entries: [{ ...key, name: 'guide', archived: true }] },
      {},
    );
    const applied = await s.adapters.skills.apply(prepared.value, skills.revision, 'vault_skills');
    expect(s.service.store.entryManagement(key).archivedAt).not.toBeNull();
    await s.adapters.skills.restore(skills, applied.revision, 'restore_skills');
    expect(s.service.store.entryManagement(key).archivedAt).toBeNull();
  } finally {
    await s.close();
  }
});

it('imports disabled MCP definitions with explicit local bindings and restores the local config without secret export', async () => {
  const s = await setup();
  try {
    const workbenchTools = {
      debugAdapters: [{ id: 'js', name: 'JavaScript', argv: ['debug-adapter'], timeoutMs: 1000 }],
      debugConfigurations: [
        { id: 'app', name: 'App', adapterId: 'js', cwd: '.', runtime: 'node', request: 'attach' },
      ],
      deployments: [
        {
          id: 'preview',
          name: 'Preview',
          environment: 'preview',
          argv: ['deploy'],
          readbackArgv: ['read-deployment'],
          timeoutMs: 1000,
          envRefs: ['DEPLOY_TOKEN'],
        },
      ],
    } satisfies Partial<ProjectToolConfig>;
    const original = s.files.configureProjectTools('default', 0, {
      checks: [],
      lspServers: [],
      ...workbenchTools,
      mcpServers: [
        {
          id: 'docs',
          name: 'Docs',
          transport: 'http',
          url: 'https://example.invalid/mcp?token=private',
          auth: { kind: 'bearer', credentialRef: 'local_credential' },
          exposure: 'direct',
          timeoutMs: 1000,
          enabled: true,
          sourcePackageHash: s.resource.hash,
        },
      ],
    });
    const exported = await s.adapters.mcp.capture();
    const rollback = await s.adapters.mcp.capture({ purpose: 'rollback' });
    expect(JSON.stringify(exported)).not.toContain('private');
    expect(JSON.stringify(exported)).not.toContain('local_credential');
    await expect(s.adapters.mcp.preview(exported.value, {})).rejects.toThrow('projectId');
    await expect(s.adapters.mcp.preview(exported.value, { projectId: 'default' })).rejects.toThrow(
      'endpoint:docs',
    );
    const prepared = await s.adapters.mcp.preview(exported.value, {
      projectId: 'default',
      'endpoint:docs': 'https://example.invalid/rebound',
    });
    const applied = await s.adapters.mcp.apply(prepared.value, exported.revision, 'vault_mcp');
    const config = s.service.projectTools.latest('default');
    expect.soft(config).toMatchObject(workbenchTools);
    expect(config?.mcpServers).toHaveLength(2);
    expect(config?.mcpServers?.[1]).toMatchObject({
      enabled: false,
      auth: { kind: 'none' },
      sourcePackageHash: s.resource.hash,
    });
    expect(await s.adapters.mcp.apply(prepared.value, exported.revision, 'vault_mcp')).toEqual(
      applied,
    );
    expect(await s.adapters.mcp.receipt?.('vault_mcp')).toEqual(applied);
    await s.adapters.mcp.restore(rollback, applied.revision, 'restore_mcp');
    expect(s.service.projectTools.latest('default')?.mcpServers).toEqual(original.mcpServers);
    expect.soft(s.service.projectTools.latest('default')).toMatchObject(workbenchTools);
    await expect(
      s.adapters.mcp.apply(prepared.value, exported.revision, 'stale_mcp'),
    ).rejects.toThrow('changed since preview');
    const added = await s.service.saveMcp('default', 3, 'add_standalone', {
      name: 'Standalone',
      transport: 'http',
      url: 'https://example.invalid/standalone',
      auth: { kind: 'none' },
      exposure: 'direct',
      timeoutMs: 1000,
      enabled: false,
    });
    expect.soft(added).toMatchObject(workbenchTools);
    const serverId = added.mcpServers?.find((server) => server.name === 'Standalone')?.id;
    if (!serverId) throw new Error('MCP server was not added');
    const removed = await s.service.removeMcp('default', added.revision, 'remove_mcp', serverId);
    expect.soft(removed).toMatchObject(workbenchTools);
    const restored = await s.service.removeMcp(
      'default',
      removed.revision,
      'restore_standalone',
      serverId,
      added.revision,
    );
    expect.soft(restored).toMatchObject(workbenchTools);
  } finally {
    await s.close();
  }
});
