import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, SqliteHarnessStore } from '@corral/storage-sqlite';
import { FakeClock } from '@corral/testkit';
import { expect, it } from 'vitest';
import { WorkspaceService } from '../src/files/service.ts';
import { McpCredentials } from '../src/harness/mcp-credentials.ts';
import { McpService } from '../src/harness/mcp-service.ts';

it('cancels only a package-owned diagnostic probe and blocks its next launch after disable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'corral-package-probe-'));
  const db = openDatabase(':memory:'),
    clock = new FakeClock();
  const files = new WorkspaceService({
    db,
    clock,
    worktreeRoot: join(root, 'copies'),
    forbidden: [],
  });
  const credentials = new McpCredentials({ directory: join(root, 'private') });
  const store = new SqliteHarnessStore(db, clock);
  const hash = 'b'.repeat(64);
  try {
    execFileSync('git', ['init', '-q', join(root, 'source')]);
    await files.bind('default', join(root, 'source'));
    await files.configure('default', { trusted: true });
    store.putResource({
      hash,
      name: 'diagnostic-owner',
      version: '1',
      license: 'MIT',
      sourceKind: 'local',
      sourceLabel: 'Fixture',
      packagePath: null,
      skills: [],
      extensions: [],
      files: [],
      createdAt: clock.nowIso(),
    });
    files.configureProjectTools('default', 0, {
      checks: [],
      lspServers: [],
      mcpServers: [
        {
          id: 'docs',
          name: 'Docs',
          transport: 'http',
          url: 'http://127.0.0.1:9/mcp',
          auth: { kind: 'none' },
          exposure: 'direct',
          timeoutMs: 1000,
          sourcePackageHash: hash,
        },
      ],
    });
    const { fingerprint } = await files.inspectMcpServer('default', 'docs');
    await files.trustMcpServer('default', 'docs', fingerprint, true);
    let launches = 0,
      aborted = false;
    const service = new McpService(files, credentials, {
      store,
      clock,
      leaseDirectory: join(root, 'leases'),
      runProbe: async ({ signal }) => {
        launches++;
        await new Promise<void>((resolve) =>
          signal.addEventListener(
            'abort',
            () => {
              aborted = true;
              resolve();
            },
            { once: true },
          ),
        );
        throw new Error('MCP probe cancelled');
      },
    });
    service.setPackageVerifier((value) => {
      expect(value).toBe(hash);
    });
    const pending = service.probe('default', 'docs', {
      operationId: 'package_probe',
      configRevision: 1,
      fingerprint,
    });
    const outcome = pending.catch((error) => error as Error);
    await expect.poll(() => launches).toBe(1);
    await service.cancelPackageProbe('c'.repeat(64));
    expect(aborted).toBe(false);
    store.managePackage(hash, 0, 'disabled');
    await service.cancelPackageProbe(hash);
    expect(await outcome).toMatchObject({ message: 'MCP probe cancelled' });
    expect(aborted).toBe(true);
    await expect(
      service.probe('default', 'docs', {
        operationId: 'next_probe',
        configRevision: 1,
        fingerprint,
      }),
    ).rejects.toThrow('MCP launch requires current fingerprint trust');
    expect(launches).toBe(1);
  } finally {
    await credentials.dispose();
    await files.dispose();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('terminal probe failures and unconfirmed cleanup remain terminal across retries', async () => {
  const root = mkdtempSync(join(tmpdir(), 'corral-probe-state-'));
  const db = openDatabase(':memory:'),
    clock = new FakeClock();
  const files = new WorkspaceService({
    db,
    clock,
    worktreeRoot: join(root, 'copies'),
    forbidden: [],
  });
  const credentials = new McpCredentials({ directory: join(root, 'private') });
  try {
    execFileSync('git', ['init', '-q', join(root, 'source')]);
    await files.bind('default', join(root, 'source'));
    await files.configure('default', { trusted: true });
    files.configureProjectTools('default', 0, {
      checks: [],
      lspServers: [],
      mcpServers: [
        {
          id: 'docs',
          name: 'Docs',
          transport: 'http',
          url: 'http://127.0.0.1:9/mcp',
          auth: { kind: 'none' },
          exposure: 'direct',
          timeoutMs: 1000,
        },
      ],
    });
    const { fingerprint } = await files.inspectMcpServer('default', 'docs');
    await files.trustMcpServer('default', 'docs', fingerprint, true);
    const failures = [
      ['MCP probe failed', 'MCP probe failed'],
      ['MCP probe cleanup unconfirmed', 'MCP probe cleanup unconfirmed'],
      ['MCP connection refused', 'MCP connection refused'],
      ['MCP server name could not be resolved', 'MCP server name could not be resolved'],
      ['MCP server returned HTTP 503', 'MCP server returned HTTP 503'],
      ['MCP server returned HTTP 999', 'MCP probe failed'],
      ['MCP server returned HTTP 401: private-token', 'MCP probe failed'],
    ] as const;
    for (const [index, [error, expected]] of failures.entries()) {
      let calls = 0;
      const options = {
        store: new SqliteHarnessStore(db, clock),
        clock,
        leaseDirectory: join(root, 'leases'),
        runProbe: async () => {
          calls++;
          throw new Error(error);
        },
      };
      const service = new McpService(files, credentials, options);
      const operationId = error.endsWith('unconfirmed') ? 'unconfirmed' : `failed_${index}`;
      const input = { operationId, configRevision: 1, fingerprint };
      await expect(service.probe('default', 'docs', input)).rejects.toThrow(expected);
      await expect(service.probe('default', 'docs', input)).rejects.toThrow(expected);
      expect(calls).toBe(1);
      if (operationId === 'unconfirmed') {
        await expect(service.cancelProbe(operationId)).rejects.toThrow('cleanup unconfirmed');
        const restarted = new McpService(files, credentials, options);
        await expect(restarted.cancelProbe(operationId)).rejects.toThrow('cleanup unconfirmed');
      }
    }
  } finally {
    await credentials.dispose();
    await files.dispose();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
