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

it('[TC-MGR-002-N] terminal probe failures and unconfirmed cleanup remain terminal across retries', async () => {
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
    for (const error of ['MCP probe failed', 'MCP probe cleanup unconfirmed']) {
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
      const operationId = error.endsWith('unconfirmed') ? 'unconfirmed' : 'failed';
      const input = { operationId, configRevision: 1, fingerprint };
      await expect(service.probe('default', 'docs', input)).rejects.toThrow(error);
      await expect(service.probe('default', 'docs', input)).rejects.toThrow(error);
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
