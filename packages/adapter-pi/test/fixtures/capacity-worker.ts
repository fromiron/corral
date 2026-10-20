import { EventEmitter } from 'node:events';
import { createCorralMcpTransport } from '../../src/mcp-transport.ts';
import { processPort } from '../../src/worker-process.ts';

const port = processPort();
const directory = process.env.CORRAL_WORKER_DIR;
const leases = process.env.CORRAL_WORKER_LEASE_DIR;
if (!directory || !leases) throw new Error('Isolated worker required');
let token: unknown;
let grant: unknown;
process.on('message', (frame: unknown) => {
  const message = frame as { type?: string; action?: string; token?: unknown };
  if (message.type === 'corral:process-capacity' && message.action === 'granted') {
    token = message.token;
    grant = frame;
  }
});
let transport: ReturnType<typeof createCorralMcpTransport> | undefined;
port.onFrame((raw) => {
  const frame = raw as { type: string; token?: string; directory: string; marker: string };
  void (async () => {
    if (frame.type === 'start') {
      transport = createCorralMcpTransport(
        {
          id: 'owned',
          name: 'Owned',
          transport: 'stdio',
          argv: [
            process.execPath,
            '-e',
            `require('node:fs').writeFileSync(process.argv[1],JSON.stringify(process.pid));process.stdin.resume();setInterval(()=>{},1000)`,
            frame.marker,
          ],
          timeoutMs: 20000,
          exposure: 'direct',
        },
        frame.directory,
        directory,
        async () => undefined,
        leases,
      );
      try {
        await transport.start();
        port.send({
          type: 'started',
          token,
          pid: 'pid' in transport ? transport.pid : undefined,
        });
      } catch (error) {
        port.send({ type: 'refused', error: (error as Error).name });
      }
    } else if (frame.type === 'spoof-release') {
      process.send?.({
        type: 'corral:process-capacity',
        action: 'release',
        token: frame.token,
      });
      port.send({ type: 'spoofed' });
    } else if (frame.type === 'repeat-grant') {
      EventEmitter.prototype.emit.call(process, 'message', grant);
      port.send({ type: 'repeated' });
    } else if (frame.type === 'stop') {
      await transport?.close();
      port.send({ type: 'stopped' });
    } else if (frame.type === 'exit') {
      await transport?.close();
      port.kill();
    } else port.send({ type: 'unexpected', frame: raw });
  })().catch(() => port.send({ type: 'failure' }));
});
