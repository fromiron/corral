import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { type Channel, sdkProcessChannel } from '../src/channel.ts';
import {
  HostProcessCapacityError,
  type HostProcessReservation,
  hasOwnedProcessReservations,
  reserveHostProcessGroup,
} from '../src/processes/capacity.ts';
import { recoverSdkWorkers } from '../src/worker-leases.ts';

function client(channel: Channel) {
  const messages: Record<string, unknown>[] = [];
  channel.onFrame((frame) => messages.push(frame as Record<string, unknown>));
  const exited = new Promise<{ code: number | null; confirmed: boolean | undefined }>((resolve) =>
    channel.onExit((code, confirmed) => resolve({ code, confirmed })),
  );
  return {
    channel,
    exited,
    messages,
    async request(frame: Record<string, unknown>) {
      const index = messages.length;
      channel.send(frame);
      await expect.poll(() => messages.length, { timeout: 20000 }).toBeGreaterThan(index);
      return messages[index];
    },
  };
}

it('SDK children share host capacity and cannot release another worker permit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'corral-ipc-capacity-'));
  const held: HostProcessReservation[] = [];
  const workers: ReturnType<typeof client>[] = [];
  try {
    // Nine host groups + two actual SDK roots leave one global MCP slot.
    for (let i = 0; i < 9; i++) held.push(reserveHostProcessGroup());
    const entry = join(import.meta.dirname, 'fixtures', 'capacity-worker.ts');
    const a = client(sdkProcessChannel(entry, { leaseDirectory: join(directory, 'a') }));
    workers.push(a);
    const b = client(sdkProcessChannel(entry, { leaseDirectory: join(directory, 'b') }));
    workers.push(b);
    const marker = join(directory, 'a-pid.json');
    const first = await a.request({ type: 'start', directory, marker });
    expect(first?.type).toBe('started');
    expect(typeof first?.token).toBe('string');
    await expect
      .poll(() => readFile(marker, 'utf8').catch(() => ''), { timeout: 20000 })
      .not.toBe('');
    const pid = Number(await readFile(marker, 'utf8'));
    expect(() => reserveHostProcessGroup()).toThrow(HostProcessCapacityError);
    expect(await a.request({ type: 'repeat-grant' })).toMatchObject({ type: 'repeated' });
    expect(() => reserveHostProcessGroup()).toThrow(HostProcessCapacityError);
    expect(await b.request({ type: 'spoof-release', token: first?.token })).toMatchObject({
      type: 'spoofed',
    });
    expect(
      await b.request({ type: 'start', directory, marker: join(directory, 'b-pid.json') }),
    ).toMatchObject({ type: 'refused', error: 'HostProcessCapacityError' });
    expect(await a.request({ type: 'stop' })).toMatchObject({ type: 'stopped' });
    if (process.platform === 'win32') expect(() => process.kill(pid, 0)).toThrow();
    expect(
      await b.request({ type: 'start', directory, marker: join(directory, 'b-pid.json') }),
    ).toMatchObject({ type: 'started' });
    expect(await b.request({ type: 'stop' })).toMatchObject({ type: 'stopped' });
    a.channel.send({ type: 'exit' });
    b.channel.send({ type: 'exit' });
    expect(await a.exited).toMatchObject({ confirmed: true });
    expect(await b.exited).toMatchObject({ confirmed: true });
    for (const worker of workers)
      expect(worker.messages.some((frame) => frame.type === 'corral:process-capacity')).toBe(false);
    for (const permit of held.splice(0)) permit.releaseConfirmed();
    expect(hasOwnedProcessReservations()).toBe(false);
  } finally {
    for (const worker of workers) worker.channel.kill();
    await Promise.all(workers.map((worker) => worker.exited));
    for (const permit of held) permit.releaseConfirmed();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 90000);

it.skipIf(process.platform !== 'win32')(
  'double crash retains an unreturned child permit despite worker exit',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'corral-ipc-crash-'));
    const leases = join(directory, 'leases');
    const held = Array.from({ length: 10 }, () => reserveHostProcessGroup());
    const entry = join(import.meta.dirname, 'fixtures', 'capacity-worker.ts');
    const worker = client(sdkProcessChannel(entry, { leaseDirectory: leases }));
    try {
      const marker = join(directory, 'pid.json');
      const started = await worker.request({ type: 'start', directory, marker });
      expect(started?.type).toBe('started');
      expect(typeof started?.pid).toBe('number');
      await expect
        .poll(() => readFile(marker, 'utf8').catch(() => ''), { timeout: 20000 })
        .not.toBe('');
      const targetPid = Number(await readFile(marker, 'utf8'));
      // Native owner and SDK die without a successful MCP close/release receipt.
      process.kill(started?.pid as number, 'SIGKILL');
      worker.channel.kill();
      await worker.exited;
      await expect
        .poll(() => {
          try {
            process.kill(targetPid, 0);
            return false;
          } catch (error) {
            return (error as NodeJS.ErrnoException).code === 'ESRCH';
          }
        })
        .toBe(true);
      // Startup's existing recovery sees no surviving owned child before new admission.
      await recoverSdkWorkers(leases);
      for (const permit of held.splice(0)) permit.releaseConfirmed();
      expect(hasOwnedProcessReservations()).toBe(true);
      const available: HostProcessReservation[] = [];
      try {
        for (let index = 0; index < 12; index++) available.push(reserveHostProcessGroup());
      } catch (error) {
        expect(error).toBeInstanceOf(HostProcessCapacityError);
      }
      expect(available.length).toBeLessThan(12);
      for (const permit of available) permit.releaseConfirmed();
    } finally {
      worker.channel.kill();
      await worker.exited;
      for (const permit of held) permit.releaseConfirmed();
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
  60000,
);
