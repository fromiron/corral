import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RegisteredMcpServer } from '@corral/contracts';
import { expect, it } from 'vitest';
import { createCorralMcpTransport } from '../src/mcp-transport.ts';
import {
  HostProcessCapacityError,
  type HostProcessReservation,
  reserveHostProcessGroup,
} from '../src/processes/capacity.ts';

function fillRemainingCapacity() {
  const held: HostProcessReservation[] = [];
  for (let index = 0; index < 100; index++) {
    try {
      held.push(reserveHostProcessGroup());
    } catch (error) {
      if (error instanceof HostProcessCapacityError) return held;
      throw error;
    }
  }
  throw new Error('Expected a bounded host process limit');
}

it.skipIf(!['win32', 'linux'].includes(process.platform))(
  'stdio MCP shares host admission and returns its slot only after descendant cleanup',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'corral-mcp-capacity-'));
    const marker = join(root, 'pids.json');
    const script = join(root, 'owned.mjs');
    await writeFile(
      script,
      `
      import {spawn} from 'node:child_process';
      import {writeFileSync} from 'node:fs';
      const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore'});
      writeFileSync(process.argv[2], JSON.stringify([process.pid,child.pid]));
      process.stdin.resume();
      setInterval(()=>{},1000);
    `,
    );
    const server: RegisteredMcpServer = {
      id: 'capacity',
      name: 'Owned MCP',
      transport: 'stdio',
      argv: [process.execPath, script, marker],
      timeoutMs: 10000,
      exposure: 'direct',
    };
    const create = (name: string, cwd = root) =>
      createCorralMcpTransport(
        server,
        cwd,
        join(root, name),
        async () => undefined,
        join(root, 'leases'),
      );
    const held = fillRemainingCapacity();
    const limit = held.length;
    held.pop()?.releaseConfirmed();
    const transport = create('first');
    const blocked = create('blocked');
    let replacement: ReturnType<typeof create> | undefined;
    try {
      await transport.start();
      await expect.poll(() => existsSync(marker), { timeout: 15000 }).toBe(true);
      const pids = JSON.parse(await readFile(marker, 'utf8')) as number[];
      await expect(blocked.start()).rejects.toBeInstanceOf(HostProcessCapacityError);
      await blocked.close();
      await transport.close();
      for (const pid of pids) {
        if (process.platform === 'win32') expect(() => process.kill(pid, 0)).toThrow();
        else {
          let state: string | undefined;
          try {
            state = (await readFile(`/proc/${pid}/stat`, 'utf8')).split(') ')[1]?.split(' ')[0];
          } catch {}
          expect(state === undefined || state === 'Z').toBe(true);
        }
      }
      replacement = create('replacement');
      await replacement.start();
      await replacement.close();
      const available = fillRemainingCapacity();
      for (const permit of available) permit.releaseConfirmed();
      expect(available).toHaveLength(1);
      expect(limit).toBeGreaterThan(0);
    } finally {
      await transport.close();
      await blocked.close();
      await replacement?.close();
      for (const permit of held) permit.releaseConfirmed();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
  45000,
);

it('failed spawn and close during authorization do not consume a process slot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'corral-mcp-admission-'));
  const server: RegisteredMcpServer = {
    id: 'capacity',
    name: 'MCP',
    transport: 'stdio',
    argv: [process.execPath, '-e', ''],
    timeoutMs: 1000,
    exposure: 'direct',
  };
  const initial = fillRemainingCapacity();
  const limit = initial.length;
  for (const permit of initial) permit.releaseConfirmed();
  const failed = createCorralMcpTransport(
    server,
    join(root, 'missing-cwd'),
    join(root, 'failed'),
    async () => undefined,
    join(root, 'leases'),
  );
  let authorize: () => void = () => {};
  const authorization = new Promise<void>((resolve) => {
    authorize = resolve;
  });
  const cancelled = createCorralMcpTransport(
    server,
    root,
    join(root, 'cancelled'),
    async () => {
      await authorization;
      return undefined;
    },
    join(root, 'leases'),
  );
  try {
    await expect(failed.start()).rejects.toThrow();
    await failed.close();
    const starting = cancelled.start();
    const outcome = starting.catch((error: unknown) => error);
    await cancelled.close();
    authorize();
    expect(await outcome).toBeInstanceOf(Error);
    const available = fillRemainingCapacity();
    for (const permit of available) permit.releaseConfirmed();
    expect(available).toHaveLength(limit);
  } finally {
    authorize();
    await failed.close();
    await cancelled.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 20000);
