import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { probeMcp } from '../src/mcp-probe.ts';

it.skipIf(process.platform !== 'linux')(
  '[TC-MGR-002-N] cancelling a real stdio probe reaps its owned server and child before returning',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'corral-probe-test-'));
    const script = join(root, 'server.mjs'),
      marker = join(root, 'pids.json'),
      leases = join(root, 'leases');
    writeFileSync(
      script,
      `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
process.on('SIGTERM', () => {});
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '1' } } }) + '\\n');
  if (message.method === 'tools/list') writeFileSync(process.argv[2], JSON.stringify([process.pid, child.pid]));
});`,
    );
    const controller = new AbortController();
    const result = probeMcp({
      server: {
        id: 'local',
        name: 'Local',
        transport: 'stdio',
        argv: [process.execPath, script, marker],
        exposure: 'direct',
        timeoutMs: 10000,
      },
      cwd: root,
      leaseDirectory: leases,
      signal: controller.signal,
      authorization: async () => undefined,
    });
    const outcome = result.then(
      () => null,
      (error) => error as Error,
    );
    try {
      await expect.poll(() => existsSync(marker)).toBe(true);
      const pids = JSON.parse(readFileSync(marker, 'utf8')) as number[];
      controller.abort();
      expect((await outcome)?.message).toBe('MCP probe cancelled');
      for (const pid of pids) {
        let state: string | undefined;
        try {
          state = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.split(' ')[0];
        } catch {
          /* Reaped. */
        }
        expect(state === undefined || state === 'Z').toBe(true);
      }
      expect(readdirSync(leases)).toEqual([]);
    } finally {
      controller.abort();
      await outcome;
      rmSync(root, { recursive: true, force: true });
    }
  },
);
