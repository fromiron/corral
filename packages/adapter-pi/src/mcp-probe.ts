import { fileURLToPath } from 'node:url';
import { McpChallenge, type RegisteredMcpServer } from '@corral/contracts';
import { z } from 'zod';
import { sdkProcessChannel } from './channel.ts';

const ENTRY = fileURLToPath(new URL('./mcp-probe-worker.ts', import.meta.url));
export const McpProbeTool = z.strictObject({
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
  title: z.string().max(2000),
  description: z.string().max(1000),
  schemaHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type McpProbeTool = z.infer<typeof McpProbeTool>;

/** Uses the same isolated owner/child leases as an SDK execution; no model is available. */
export function probeMcp(options: {
  server: RegisteredMcpServer;
  cwd?: string;
  leaseDirectory: string;
  signal: AbortSignal;
  authorization(id: string, challenge?: McpChallenge): Promise<string | undefined>;
}): Promise<McpProbeTool[]> {
  if (options.signal.aborted) return Promise.reject(new Error('MCP probe cancelled'));
  const channel = sdkProcessChannel(ENTRY, { leaseDirectory: options.leaseDirectory });
  return new Promise((resolve, reject) => {
    let result: McpProbeTool[] | undefined;
    let failure = 'MCP probe failed';
    let stopping = false;
    const stop = (message: string) => {
      failure = message;
      stopping = true;
      channel.kill();
    };
    const abort = () => stop('MCP probe cancelled');
    const timer = setTimeout(
      () => stop('MCP probe timed out'),
      Math.min(options.server.timeoutMs, 30000),
    );
    options.signal.addEventListener('abort', abort, { once: true });
    channel.onFrame((raw) => {
      const frame = raw as {
        type?: string;
        requestId?: number;
        challenge?: unknown;
        tools?: unknown;
      };
      if (stopping) return;
      if (frame.type === 'ready')
        channel.send({ type: 'probe', server: options.server, cwd: options.cwd });
      else if (frame.type === 'authorize' && Number.isSafeInteger(frame.requestId)) {
        const challenge =
          frame.challenge === undefined ? undefined : McpChallenge.safeParse(frame.challenge);
        if (challenge && !challenge.success) {
          stop('MCP probe failed');
          return;
        }
        void options.authorization(options.server.id, challenge?.data).then(
          (token) => {
            if (!stopping)
              channel.send({ type: 'authorization', requestId: frame.requestId, token });
          },
          () => stop('MCP probe authorization failed'),
        );
      } else if (frame.type === 'result') {
        const parsed = z.array(McpProbeTool).max(128).safeParse(frame.tools);
        if (parsed.success) result = parsed.data;
        else stop('MCP probe returned an invalid tool list');
      } else stop('MCP probe failed');
    });
    channel.onExit((code, confirmed) => {
      clearTimeout(timer);
      options.signal.removeEventListener('abort', abort);
      if (confirmed === false) reject(new Error('MCP probe cleanup unconfirmed'));
      else if (!stopping && code === 0 && result) resolve(result);
      else reject(new Error(failure));
    });
  });
}
