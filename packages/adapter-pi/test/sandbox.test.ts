import { once } from 'node:events';
import { mkdtempSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { sandboxChannel } from '../src/sandbox-channel.ts';

it.skipIf(process.env.CORRAL_SANDBOX_PROBE !== '1')(
  '[TC-SBX-002-H] [TC-SBX-002-N] actual worker IPC isolates host files, network and credentials; killing it reaps detached children',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'corral-sandbox-test-'));
    const privateFile = join(root, 'private');
    writeFileSync(privateFile, 'fixture');
    const server = createServer((socket) => socket.end());
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    process.env.OPENAI_API_KEY = 'fixture-never-forward';
    const channel = sandboxChannel(join(import.meta.dirname, 'fixtures/sandbox-worker.ts'));
    const exited = new Promise<void>((resolve) => channel.onExit(() => resolve()));
    try {
      const frame = await new Promise<{ namespace: string }>((resolve, reject) => {
        channel.onExit((code) => reject(new Error(`sandbox exited ${code} before observation`)));
        channel.onFrame((value) => {
          if ((value as { ready?: boolean }).ready)
            channel.send({ privateFile, port: address.port });
          else resolve(value as { namespace: string });
        });
      });
      expect(frame).toMatchObject({
        privateVisible: false,
        network: false,
        hasKey: false,
        writableHome: true,
      });
      expect(frame.namespace).not.toBe(readlinkSync('/proc/self/ns/pid'));
      channel.kill();
      await exited;
      await expect
        .poll(() =>
          readdirSync('/proc').filter((id) => {
            try {
              return readlinkSync(`/proc/${id}/ns/pid`) === frame.namespace;
            } catch {
              return false;
            }
          }),
        )
        .toEqual([]);
      expect(server.listening).toBe(true);
    } finally {
      channel.kill();
      delete process.env.OPENAI_API_KEY;
      server.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
  15_000,
);
