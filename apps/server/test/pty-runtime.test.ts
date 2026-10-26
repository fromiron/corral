import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reserveHostProcessGroup } from '@corral/adapter-pi/processes';
import type { TerminalCreate, TerminalStreamMessage } from '@corral/contracts';
import { openDatabase } from '@corral/storage-sqlite';
import { FakeClock, Gate } from '@corral/testkit';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkbenchOperations } from '../src/files/workbench-operations.ts';
import { WorkspaceAccessStore } from '../src/files/workspace-access.ts';
import { PtyRuntime } from '../src/processes/pty.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function setup(options: { prepare?: Gate; cleanup?: Gate; historyBytes?: number } = {}) {
  const path = mkdtempSync(join(tmpdir(), 'corral-pty-test-'));
  const db = openDatabase(':memory:');
  const operations = new WorkbenchOperations(db, new FakeClock());
  const access = new WorkspaceAccessStore(db);
  const request: TerminalCreate = {
    operationId: 'terminal_1',
    target: {
      hostId: 'host',
      projectId: 'default',
      bindingId: 'binding',
      sessionId: 'session',
      copyGeneration: 1,
    },
    shellId: 'bash',
    cols: 80,
    rows: 24,
  };
  const spawned = new Gate();
  let data = (_chunk: string) => {};
  let exit = (_event: { exitCode: number; signal?: number }) => {};
  const child = {
    pid: 123,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData(callback: typeof data) {
      data = callback;
      return { dispose() {} };
    },
    onExit(callback: typeof exit) {
      exit = callback;
      spawned.open();
      return { dispose() {} };
    },
  };
  const spawn = vi.fn(() => child);
  const cleanup = vi.fn(async () => {
    await options.cleanup?.wait();
    return true;
  });
  const runtimeOptions = {
    operations,
    target: () => ({ target: request.target, path, writable: true }),
    prepare: async () => {
      await options.prepare?.wait();
      return path;
    },
    shells: async () => [{ id: 'bash' as const, label: 'Bash', executable: '/bin/bash' }],
    spawn,
    capture: () => ({ pid: 123, bootId: 'boot', startTicks: '42', sessionId: 123, owner: 'owner' }),
    cleanup,
    newGeneration: () => 'generation_1',
    historyBytes: options.historyBytes,
  };
  const runtime = new PtyRuntime(runtimeOptions);
  cleanups.push(async () => {
    options.prepare?.open();
    options.cleanup?.open();
    await runtime.close();
    db.close();
    rmSync(path, { recursive: true, force: true });
  });
  const identity = { target: request.target, generation: 'generation_1' };
  return {
    runtime,
    runtimeOptions,
    db,
    operations,
    access,
    path,
    request,
    spawned,
    child,
    spawn,
    cleanup,
    identity,
    data: (chunk: string) => data(chunk),
    exit: () => exit({ exitCode: 0 }),
  };
}

it('duplicate create keeps one writer and cancellation during preparation prevents spawn', async () => {
  const prepare = new Gate();
  const s = setup({ prepare });
  const first = await s.runtime.create('session', s.request);
  expect(first.state).toBe('starting');
  expect(await s.runtime.create('session', s.request)).toEqual(first);
  await expect(s.runtime.create('session', { ...s.request, cols: 90 })).rejects.toThrow(/changed/);
  expect(() => s.access.acquire({ kind: 'run', id: 'run' }, 'session', s.path, true, 1)).toThrow(
    /writer/,
  );
  const stopped = s.runtime.stop('session', 'terminal_1', s.identity);
  prepare.open();
  expect((await stopped).state).toBe('exited');
  expect(s.spawn).not.toHaveBeenCalled();
  expect(s.operations.get('terminal_1')?.state).toBe('cancelled');
  expect(s.access.ownersAt(s.path)).toEqual([]);
});

it('output keeps complete chunks and resize order; controller frames acknowledge once', async () => {
  const s = setup();
  await s.runtime.create('session', s.request);
  await s.spawned.wait();
  const controller = s.runtime.control('session', 'terminal_1', {
    ...s.identity,
    action: 'claim',
    attachmentId: 'view_1',
    expectedGeneration: 0,
    takeover: false,
  });
  const frame = {
    ...s.identity,
    attachmentId: 'view_1',
    controllerGeneration: controller.controllerGeneration,
    sequence: 1,
    data: 'echo 한글\r',
  };
  expect(s.runtime.input('session', 'terminal_1', frame).acceptedSequence).toBe(1);
  expect(s.runtime.input('session', 'terminal_1', frame).acceptedSequence).toBe(1);
  expect(s.child.write).toHaveBeenCalledTimes(1);
  expect(() => s.runtime.input('session', 'terminal_1', { ...frame, data: 'changed' })).toThrow(
    /sequence/,
  );
  s.data('\x1b[');
  s.data('31m한글');
  const { data: _data, ...resizeFrame } = frame;
  s.runtime.resize('session', 'terminal_1', { ...resizeFrame, sequence: 2, cols: 100, rows: 30 });
  const stream = s.runtime.subscribe(
    'session',
    'terminal_1',
    { generation: 'generation_1', afterSeq: 0 },
    () => {},
  );
  expect(stream.events.map((event) => event.type)).toEqual(['output', 'output', 'resize']);
  expect(stream.events[0]).toMatchObject({ data: '\x1b[' });
  expect(stream.view).toMatchObject({ initialCols: 80, cols: 100, lastSequence: 3 });
  stream.close();
  s.runtime.control('session', 'terminal_1', {
    ...s.identity,
    action: 'claim',
    attachmentId: 'view_2',
    expectedGeneration: 1,
    takeover: true,
  });
  expect(() => s.runtime.input('session', 'terminal_1', { ...frame, sequence: 3 })).toThrow(
    /controller/,
  );
});

it('prefix overflow preserves live output but refuses arbitrary tail replay', async () => {
  const s = setup({ historyBytes: 68 });
  await s.runtime.create('session', s.request);
  await s.spawned.wait();
  const live: TerminalStreamMessage[] = [];
  const stream = s.runtime.subscribe(
    'session',
    'terminal_1',
    { generation: 'generation_1', afterSeq: 0 },
    (event) => live.push(event),
  );
  s.data('\x1b[');
  s.data('31m한');
  expect(live.filter((event) => event.type === 'output')).toHaveLength(2);
  expect(() =>
    s.runtime.subscribe(
      'session',
      'terminal_1',
      { generation: 'generation_1', afterSeq: 0 },
      () => {},
    ),
  ).toThrow(/replay/);
  const continued = s.runtime.subscribe(
    'session',
    'terminal_1',
    { generation: 'generation_1', afterSeq: 2 },
    () => {},
  );
  expect(continued.events).toEqual([]);
  stream.close();
  continued.close();
});

it('leader exit retains writer until descendants are confirmed gone', async () => {
  const cleanup = new Gate();
  const s = setup({ cleanup });
  await s.runtime.create('session', s.request);
  await s.spawned.wait();
  s.exit();
  expect(s.runtime.get('session', 'terminal_1').state).toBe('stopping');
  expect(s.access.ownersAt(s.path)).toHaveLength(1);
  cleanup.open();
  await s.runtime.stop('session', 'terminal_1', s.identity);
  expect(s.access.ownersAt(s.path)).toHaveLength(0);
});

it('restarted uncertain receipt never respawns and needs explicit cleanup', async () => {
  const s = setup();
  await s.runtime.create('session', s.request);
  await s.spawned.wait();
  s.operations.recover();
  const restarted = new PtyRuntime(s.runtimeOptions);
  expect((await restarted.create('session', s.request)).state).toBe('uncertain');
  expect(s.spawn).toHaveBeenCalledTimes(1);
  expect(s.access.ownersAt(s.path)).toHaveLength(1);
  expect((await restarted.stop('session', 'terminal_1', s.identity)).state).toBe('exited');
  expect(s.access.ownersAt(s.path)).toHaveLength(0);
  await restarted.close();
});

it('ambiguous input invalidates the controller and explicit takeover never replays it', async () => {
  const s = setup();
  await s.runtime.create('session', s.request);
  await s.spawned.wait();
  const change = {
    ...s.identity,
    action: 'claim' as const,
    attachmentId: 'view_1',
    expectedGeneration: 0,
    takeover: false,
  };
  s.runtime.control('session', 'terminal_1', change);
  s.child.write.mockImplementationOnce(() => {
    throw new Error('write may have happened');
  });
  const frame = {
    ...s.identity,
    attachmentId: 'view_1',
    controllerGeneration: 1,
    sequence: 1,
    data: 'echo once\r',
  };
  expect(() => s.runtime.input('session', 'terminal_1', frame)).toThrow(/unknown/);
  expect(() => s.runtime.input('session', 'terminal_1', frame)).toThrow(/controller/);
  const recovered = s.runtime.control('session', 'terminal_1', {
    ...change,
    expectedGeneration: 2,
    takeover: true,
  });
  const reclaimed = s.runtime.control('session', 'terminal_1', {
    ...change,
    expectedGeneration: recovered.controllerGeneration,
    takeover: true,
  });
  expect(reclaimed.controllerGeneration).toBe(recovered.controllerGeneration + 1);
  expect(s.child.write).toHaveBeenCalledTimes(1);
});

it('the PTY reservation consumes the same twelfth host process slot', async () => {
  const s = setup();
  const permits = Array.from({ length: 11 }, () => reserveHostProcessGroup());
  try {
    await s.runtime.create('session', s.request);
    await s.spawned.wait();
    expect(() => reserveHostProcessGroup()).toThrow(/capacity/);
    await s.runtime.stop('session', 'terminal_1', s.identity);
    const last = reserveHostProcessGroup();
    last.releaseConfirmed();
  } finally {
    for (const permit of permits) permit.releaseConfirmed();
  }
});

it('restoring an existing owner above the cap keeps new admission blocked after another exit', async () => {
  const s = setup();
  await s.runtime.create('session', s.request);
  await s.spawned.wait();
  const permits = Array.from({ length: 11 }, () => reserveHostProcessGroup());
  s.operations.recover();
  const restarted = new PtyRuntime(s.runtimeOptions);
  try {
    permits[0]?.releaseConfirmed();
    expect(() => reserveHostProcessGroup()).toThrow(/capacity/);
    await restarted.stop('session', 'terminal_1', s.identity);
    const available = reserveHostProcessGroup();
    available.releaseConfirmed();
  } finally {
    await restarted.close();
    for (const permit of permits) permit.releaseConfirmed();
  }
});
