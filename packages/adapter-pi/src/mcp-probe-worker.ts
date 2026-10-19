import { createHash } from 'node:crypto';
import { canonicalJson, type McpChallenge, RegisteredMcpServer } from '@corral/contracts';
import { McpClient } from '@earendil-works/pi-mcp';
import { z } from 'zod';
import { BROWSER_TOOLS } from './browser-policy.ts';
import type { McpProbeTool } from './mcp-probe.ts';
import { createCorralMcpTransport } from './mcp-transport.ts';
import { processPort } from './worker-process.ts';

const port = processPort();
const directory = process.env.CORRAL_WORKER_DIR;
const leases = process.env.CORRAL_WORKER_LEASE_DIR;
if (!directory || !leases) throw new Error('isolated probe required');
let started = false,
  requestId = 0;
const auth = new Map<number, (token: string | undefined) => void>();
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const pageSchema = z.object({
  tools: z
    .array(
      z.object({
        name: z.string().min(1).max(2000),
        description: z.string().optional(),
        inputSchema: z.record(z.string(), z.unknown()),
      }),
    )
    .max(128),
  nextCursor: z.string().max(1000).optional(),
});

port.onFrame((raw) => {
  const frame = raw as { type?: string; requestId?: number; token?: string };
  if (frame.type === 'authorization') {
    const result = z
      .object({ requestId: z.int(), token: z.string().max(16000).optional() })
      .safeParse(raw);
    if (!result.success) {
      port.kill();
      return;
    }
    auth.get(result.data.requestId)?.(result.data.token);
    auth.delete(result.data.requestId);
    return;
  }
  if (started) {
    port.kill();
    return;
  }
  started = true;
  void (async () => {
    const client = new McpClient({ name: 'Corral connection test', version: '0.1.0' });
    try {
      const input = z
        .strictObject({
          type: z.literal('probe'),
          server: RegisteredMcpServer,
          cwd: z.string().optional(),
        })
        .parse(raw);
      const authorize = (_id: string, challenge?: McpChallenge) =>
        new Promise<string | undefined>((resolve) => {
          const id = ++requestId;
          auth.set(id, resolve);
          port.send({ type: 'authorize', requestId: id, challenge });
        });
      const transport = createCorralMcpTransport(
        input.server,
        input.cwd,
        directory,
        authorize,
        leases,
      );
      await client.connect(transport);
      const tools: z.infer<typeof pageSchema>['tools'] = [];
      let cursor: string | undefined;
      if (client.serverCapabilities?.tools)
        for (let page = 0; page < 4; page++) {
          const value = pageSchema.parse(
            await client.request('tools/list', cursor ? { cursor } : {}),
          );
          tools.push(
            ...value.tools.filter(
              (tool) =>
                input.server.transport !== 'stdio' ||
                !input.server.browser ||
                BROWSER_TOOLS.has(tool.name),
            ),
          );
          if (tools.length > 128) throw new Error('tool list limit');
          if (!value.nextCursor) {
            cursor = undefined;
            break;
          }
          if (value.nextCursor === cursor) throw new Error('cursor did not advance');
          cursor = value.nextCursor;
        }
      if (cursor || new Set(tools.map((tool) => tool.name)).size !== tools.length)
        throw new Error('invalid tool list');
      // Pi 1.3 uses this provider-name mapping; verify against real SDK descriptors when upgrading.
      const names = tools.map((tool) =>
        `mcp__${input.server.id}__${tool.name}`.replace(/[^A-Za-z0-9_]/g, '_'),
      );
      const result: McpProbeTool[] = tools.map((tool, index) => {
        const plain = names[index]!;
        const name =
          plain.length <= 64 && names.indexOf(plain) === names.lastIndexOf(plain)
            ? plain
            : `${plain.slice(0, 55)}_${hash(`${input.server.id}\0${tool.name}`).slice(0, 8)}`;
        return {
          name,
          title: tool.name,
          description: (tool.description ?? '').slice(0, 1000),
          schemaHash: hash(canonicalJson(tool.inputSchema)),
        };
      });
      await client.close();
      port.send({ type: 'result', tools: result });
    } catch {
      port.send({ type: 'failed' });
    } finally {
      await client.close().catch(() => {});
      port.kill();
    }
  })();
});
port.send({ type: 'ready' });
