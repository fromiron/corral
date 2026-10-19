import { spawn } from 'node:child_process';
import { existsSync, readlinkSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { processPort } from '../../src/worker-process.ts';

const port = processPort();
port.onFrame(async (raw) => {
  const input = raw as { privateFile: string; port: number };
  const network = await new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port: input.port });
    const finish = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
  writeFileSync('/home/worker/check', 'owned');
  spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  port.send({
    privateVisible: existsSync(input.privateFile),
    network,
    hasKey: Boolean(process.env.OPENAI_API_KEY),
    namespace: readlinkSync('/proc/self/ns/pid'),
    writableHome: true,
  });
});
port.send({ ready: true });
