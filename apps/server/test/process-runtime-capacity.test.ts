import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as processGroup from '../src/files/process-group.ts';
import {
  CommandCapacityError,
  CommandRuntime,
  type OwnedCommandInput,
} from '../src/processes/runtime.ts';

const live = () => ({ aborted: false, onCancel: (_fn: () => void) => () => {} });
const runtimes: CommandRuntime[] = [];
const directories: string[] = [];
async function directory() {
  const value = await mkdtemp(join(tmpdir(), 'corral-capacity-test-'));
  directories.push(value);
  return value;
}
function input(directory: string, operationId: string): OwnedCommandInput {
  return {
    operationId,
    owner: {
      hostId: 'local',
      sessionId: 'session',
      runId: 'run',
      executionId: 'execution',
      attemptNo: 1,
      effectId: operationId,
    },
    directory,
    command: {
      shellId: process.platform === 'win32' ? 'powershell' : 'bash',
      executable: process.execPath,
      args: ['-e', 'console.log("started");setInterval(()=>{},1000)'],
    },
    timeoutMs: 60000,
  };
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('[TC-ABS-006-H] command process capacity', () => {
  it('reserves all twelve slots during startup, deduplicates, and admits another process only after confirmed cleanup', async () => {
    const runtime = new CommandRuntime();
    runtimes.push(runtime);
    const path = await directory();
    const inputs = Array.from({ length: 12 }, (_, index) => input(path, `service-${index}`));
    const services = inputs.map((request) => runtime.startService(request, live()));
    const duplicate = runtime.startService(inputs[0] as OwnedCommandInput, live());
    expect(duplicate.started).toBe(services[0]?.started);
    expect(duplicate.completion).toBe(services[0]?.completion);
    // No async launch has completed: the thirteenth is rejected at admission.
    expect(() => runtime.startService(input(path, 'thirteenth'), live())).toThrow(
      CommandCapacityError,
    );
    expect(runtime.list({ sessionId: 'session' })).toHaveLength(12);
    expect(await Promise.all(services.map((service) => service.started))).toEqual(
      Array(12).fill(true),
    );
    expect(() => runtime.startService(input(path, 'thirteenth'), live())).toThrow(
      /12 active processes/,
    );
    expect(await runtime.stop('service-0')).toMatchObject({
      state: 'cancelled',
      cleanupConfirmed: true,
    });
    // Completed duplicate replay must not consume the newly freed slot.
    expect(runtime.startService(inputs[0] as OwnedCommandInput, live()).completion).toBe(
      services[0]?.completion,
    );
    const admitted = runtime.startService(input(path, 'thirteenth'), live());
    expect(await admitted.started).toBe(true);
    expect(() => runtime.startService(input(path, 'fourteenth'), live())).toThrow(
      CommandCapacityError,
    );
  }, 90000);

  it('keeps the slot when process cleanup cannot be confirmed', async () => {
    const runtime = new CommandRuntime({ maxActiveProcesses: 1 });
    runtimes.push(runtime);
    const path = await directory();
    const service = runtime.startService(input(path, 'uncertain'), live());
    expect(await service.started).toBe(true);
    // Exercise the same real process termination; simulate an unavailable OS confirmation.
    vi.spyOn(processGroup, 'processGroupGone').mockResolvedValue(false);
    expect(await runtime.stop(service.operationId)).toMatchObject({
      state: 'uncertain',
      cleanupConfirmed: false,
    });
    expect(() => runtime.startService(input(path, 'replacement'), live())).toThrow(
      /1 active processes/,
    );
  }, 30000);

  it('releases a startup reservation after failure before any process is launched', async () => {
    const runtime = new CommandRuntime({ maxActiveProcesses: 1 });
    runtimes.push(runtime);
    const path = await directory();
    expect(await runtime.run(input(join(path, 'missing'), 'missing'), live())).toMatchObject({
      state: 'failed',
      cleanupConfirmed: true,
    });
    const service = runtime.startService(input(path, 'valid'), live());
    expect(await service.started).toBe(true);
  }, 30000);

  it.each([0, -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN])(
    'rejects invalid capacity %s',
    (maxActiveProcesses) => {
      expect(() => new CommandRuntime({ maxActiveProcesses })).toThrow(/positive safe integer/);
    },
  );
});
