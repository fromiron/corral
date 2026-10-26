import { DebugStart, ProjectToolConfig, RegisteredDebugConfiguration } from '@corral/contracts';
import { describe, expect, it } from 'vitest';

describe('debug contracts', () => {
  it('keeps old configuration unchanged and accepts only explicitly registered debug recipes', () => {
    const old = { checks: [], lspServers: [] };
    expect(ProjectToolConfig.parse(old)).toEqual(old);
    expect(
      ProjectToolConfig.parse({
        ...old,
        debugAdapters: [
          {
            id: 'jsdebug',
            name: 'JavaScript',
            argv: ['node', '/opt/js-debug/src/dapDebugServer.js'],
            timeoutMs: 10000,
          },
        ],
        debugConfigurations: [
          {
            id: 'node',
            name: 'Node',
            adapterId: 'jsdebug',
            runtime: 'node',
            request: 'launch',
            cwd: '.',
            program: 'main.js',
          },
        ],
      }).debugConfigurations,
    ).toHaveLength(1);
    expect(
      DebugStart.safeParse({ target: {}, configId: 'node', endpoint: 'ws://example.com' }).success,
    ).toBe(false);
    expect(
      RegisteredDebugConfiguration.safeParse({
        id: 'node',
        name: 'Node',
        adapterId: 'jsdebug',
        runtime: 'node',
        request: 'launch',
        cwd: '.',
        program: 'main.js',
        envRefs: ['NODE_OPTIONS'],
      }).success,
    ).toBe(false);
  });
});

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '@corral/storage-sqlite';
import { FakeClock } from '@corral/testkit';
import { afterEach, vi } from 'vitest';
import type { DebugConnection } from '../src/files/debug-connection.ts';
import type { InspectorBridge } from '../src/files/debug-processes.ts';
import { WorkspaceService } from '../src/files/service.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
async function fixture() {
  process.env.P26_FIXTURE_SECRET = 'debug-fixture-sensitive-value';
  const root = mkdtempSync(join(tmpdir(), 'corral-debug-broker-')),
    original = join(root, 'original');
  execFileSync('git', ['init', '-q', '-b', 'main', original]);
  const source = 'const value = 41;\nsetInterval(() => {}, 1000);\n';
  writeFileSync(join(original, 'main.js'), source);
  writeFileSync(join(original, 'main.js.map'), '{}');
  writeFileSync(join(original, 'adapter.cjs'), '// fixture');
  execFileSync('git', ['add', '.'], { cwd: original });
  execFileSync(
    'git',
    ['-c', 'user.name=Fixture', '-c', 'user.email=f@example.test', 'commit', '-qm', 'base'],
    { cwd: original },
  );
  const db = openDatabase(':memory:');
  db.prepare(
    "INSERT INTO work_sessions(id,project_id,corral_id,title,objective,pinned,revision,created_at,updated_at,entries_json) VALUES('s1','default',NULL,'t','',0,1,'x','x','[]')",
  ).run();
  let callbacks: Parameters<typeof DebugConnection.start>[0];
  let copyPath = '';
  const sessions = new Map([
    ['root', { id: 'root', parentId: null, capabilities: {} }],
    ['child-1', { id: 'child-1', parentId: 'root', capabilities: {} }],
  ]);
  const request = vi.fn(
    async (
      _id: string | undefined,
      command: string,
      _args?: Record<string, unknown>,
    ): Promise<unknown> => {
      if (command === 'threads')
        return { threads: _id === 'root' ? [] : [{ id: 1, name: 'main' }] };
      if (command === 'stackTrace')
        return {
          stackFrames: [
            {
              id: 5,
              name: 'frame',
              source: { name: 'main.js', path: join(copyPath, 'main.js') },
              line: 1,
              column: 1,
            },
          ],
        };
      if (command === 'setBreakpoints') return { breakpoints: [{ verified: true, line: 1 }] };
      if (command === 'evaluate') return { result: '42', variablesReference: 0 };
      if (command === 'pause') callbacks.onEvent('stopped', { threadId: 1 }, _id ?? 'child-1');
      return {};
    },
  );
  const connection = {
    sessions,
    attach: vi.fn(async () => {
      callbacks.onEvent('stopped', { threadId: 1 }, 'child-1');
    }),
    request,
    close: vi.fn(async () => {}),
  };
  const launch = vi.fn(async (input: typeof callbacks) => {
    callbacks = input;
    input.onSpawn({
      pid: 123,
      sessionId: 123,
      bootId: 'previous-boot',
      startTicks: '1',
      owner: input.owner,
    });
    return connection;
  });
  const bridge = {
    address: '127.0.0.1',
    port: 4444,
    websocketAddress: 'ws://127.0.0.1:4444/fixture',
    close: vi.fn(async () => {}),
  } as unknown as InspectorBridge;
  const make = () =>
    new WorkspaceService({
      db,
      clock: new FakeClock(),
      worktreeRoot: join(root, 'copies'),
      forbidden: [],
      hostId: 'host',
      allowSharedDevelopment: true,
      debug: { transport: { start: launch }, bridge: { start: vi.fn(async () => bridge) } },
    });
  let service = make();
  cleanups.push(async () => {
    await service.dispose();
    db.close();
    rmSync(root, { recursive: true, force: true });
    delete process.env.P26_FIXTURE_SECRET;
  });
  await service.bind('default', original);
  await service.configure('default', { trusted: true });
  const config = service.configureProjectTools('default', 0, {
    checks: [],
    lspServers: [],
    debugAdapters: [
      {
        id: 'jsdebug',
        name: 'JavaScript',
        argv: [process.execPath, 'adapter.cjs'],
        timeoutMs: 5000,
      },
    ],
    debugConfigurations: [
      {
        id: 'node',
        name: 'Node',
        adapterId: 'jsdebug',
        runtime: 'node',
        request: 'launch',
        cwd: '.',
        program: 'main.js',
        envRefs: ['P26_FIXTURE_SECRET'],
      },
    ],
  });
  const copy = await service.createWorktree('s1', 'default');
  copyPath = join(root, 'copies', copy.bindingId, 's1');
  const target = {
    hostId: 'host',
    projectId: 'default',
    bindingId: copy.bindingId,
    sessionId: 's1',
    copyGeneration: copy.copyGeneration,
  };
  const inspection = await service.inspectDebug('s1', { target, configId: 'node' });
  const start = {
    target,
    configId: 'node',
    requestId: 'debug_1',
    clientId: 'client',
    configRevision: config.revision,
    fingerprint: inspection.fingerprint,
    trust: true,
  };
  return {
    get service() {
      return service;
    },
    restart: () => {
      service = make();
    },
    start,
    target,
    path: copyPath,
    source,
    config,
    db,
    connection,
    launch,
    get callbacks() {
      return callbacks;
    },
    scope: { target, generation: 'debug_1' },
  };
}
it('starts explicitly once, pins breakpoints, deduplicates evaluation and preserves shared saves', async () => {
  const f = await fixture();
  expect(f.launch).not.toHaveBeenCalled();
  await f.service.startDevelopment('s1', { target: f.target, operationId: 'dev' });
  const [started, duplicate] = await Promise.all([
    f.service.startDebug('s1', f.start),
    f.service.startDebug('s1', f.start),
  ]);
  expect(duplicate).toEqual(started);
  expect(started.state).toBe('paused');
  expect(await f.service.startDebug('s1', f.start)).toEqual(started);
  expect(f.launch).toHaveBeenCalledTimes(1);
  f.callbacks.onEvent('continued', {}, 'child-1');
  const running = (await f.service.debugState('s1')).session!;
  const paused = await f.service.commandDebug('s1', {
    ...f.scope,
    commandId: 'pause-running',
    kind: 'pause',
    revision: running.revision,
    pauseId: running.pauseId,
  });
  expect(paused).toMatchObject({
    state: 'succeeded',
    session: { state: 'paused', pausedThreadId: 'child-1:1' },
  });
  f.callbacks.onEvent('output', { output: 'debug-fixture-' }, 'child-1');
  f.callbacks.onEvent('output', { output: 'sensitive-value\n' }, 'child-1');
  expect((await f.service.debugState('s1')).session?.output).not.toContain(
    'debug-fixture-sensitive-value',
  );
  const breakpoints = await f.service.setDebugBreakpoints('s1', {
    ...f.scope,
    commandId: 'bp',
    path: 'main.js',
    sha256: hash(f.source),
    lines: [1],
  });
  expect(breakpoints.session.breakpoints[0]).toMatchObject({ requestedLine: 1, verified: true });
  const command = {
    ...f.scope,
    commandId: 'eval',
    kind: 'evaluate' as const,
    revision: breakpoints.session.revision,
    pauseId: breakpoints.session.pauseId,
    frameId: 'child-1:5',
    expression: 'value + 1',
  };
  expect(await f.service.commandDebug('s1', command)).toMatchObject({
    state: 'succeeded',
    value: '42',
  });
  await f.service.commandDebug('s1', command);
  expect(f.connection.request.mock.calls.filter((call) => call[1] === 'evaluate')).toHaveLength(1);
  expect(
    (
      await f.service.changeDocument('s1', {
        target: f.target,
        operationId: 'save',
        kind: 'save',
        path: 'main.js',
        baseHash: hash(f.source),
        editVersion: 1,
        text: f.source + '// saved\n',
      })
    ).state,
  ).toBe('succeeded');
  const stopped = await f.service.commandDebug('s1', {
    ...f.scope,
    commandId: 'stop',
    kind: 'stop',
    revision: 0,
    pauseId: 0,
  });
  expect(stopped.state).toBe('succeeded');
  expect(f.service.debugCommand('s1', 'debug_1', 'stop').state).toBe('succeeded');
  f.restart();
  expect(f.service.debugCommand('s1', 'debug_1', 'stop').state).toBe('succeeded');
});
it('rejects late pause results, stale source maps, foreign scope and changed command identities', async () => {
  const f = await fixture(),
    started = await f.service.startDebug('s1', f.start);
  const query = {
    ...f.scope,
    kind: 'stack' as const,
    pauseId: started.pauseId,
    threadId: 'child-1:1',
  };
  expect((await f.service.queryDebug('s1', query)).frames?.[0]?.source).toMatchObject({
    mapped: true,
    path: 'main.js',
  });
  writeFileSync(join(f.path, 'main.js.map'), '{"changed":true}');
  expect((await f.service.queryDebug('s1', query)).frames?.[0]?.source).toMatchObject({
    mapped: false,
    reason: 'changed',
  });
  let finish: (value: unknown) => void = () => {};
  f.connection.request.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = f.service.queryDebug('s1', query);
  await new Promise((resolve) => setImmediate(resolve));
  f.callbacks.onEvent('continued', {}, 'child-1');
  finish({ stackFrames: [] });
  await expect(pending).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  await expect(
    f.service.queryDebug('s1', { ...query, target: { ...f.target, copyGeneration: 99 } }),
  ).rejects.toThrow();
  await expect(f.service.startDebug('s1', { ...f.start, clientId: 'other' })).rejects.toThrow();
  f.callbacks.onEvent('stopped', { threadId: 1 }, 'child-1');
  const current = (await f.service.debugState('s1')).session!;
  let rejectEvaluation: (error: Error) => void = () => {};
  f.connection.request.mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        rejectEvaluation = reject;
      }),
  );
  const evaluation = f.service.commandDebug('s1', {
    ...f.scope,
    commandId: 'pending',
    kind: 'evaluate',
    revision: current.revision,
    pauseId: current.pauseId,
    frameId: 'child-1:5',
    expression: 'while (true) {}',
  });
  await new Promise((resolve) => setImmediate(resolve));
  f.connection.close.mockImplementationOnce(async () => {
    rejectEvaluation(new Error('stopped'));
  });
  expect(
    (
      await f.service.commandDebug('s1', {
        ...f.scope,
        commandId: 'interrupt',
        kind: 'stop',
        revision: current.revision,
        pauseId: current.pauseId,
      })
    ).state,
  ).toBe('succeeded');
  expect((await evaluation).state).toBe('uncertain');
  expect((await f.service.debugState('s1')).session?.state).toBe('stopped');
});
it('preserves uncertain ownership across restart until explicit cleanup and refuses replay', async () => {
  const f = await fixture();
  const started = await f.service.startDebug('s1', f.start);
  f.connection.request.mockRejectedValueOnce(new Error('response lost'));
  expect(
    (
      await f.service.commandDebug('s1', {
        ...f.scope,
        commandId: 'lost',
        kind: 'evaluate',
        revision: started.revision,
        pauseId: started.pauseId,
        frameId: 'child-1:5',
        expression: 'value++',
      })
    ).state,
  ).toBe('uncertain');
  f.callbacks.onEvent('stopped', { threadId: 1 }, 'child-1');
  expect((await f.service.debugState('s1')).session?.state).toBe('uncertain');
  f.restart();
  expect((await f.service.debugState('s1')).session?.state).toBe('uncertain');
  expect((await f.service.startDebug('s1', f.start)).state).toBe('uncertain');
  expect(f.launch).toHaveBeenCalledTimes(1);
  await expect(f.service.startDebug('s1', { ...f.start, requestId: 'debug_2' })).rejects.toThrow();
  const stopped = await f.service.commandDebug('s1', {
    ...f.scope,
    commandId: 'recover',
    kind: 'stop',
    revision: 0,
    pauseId: 0,
  });
  expect(stopped.state).toBe('succeeded');
  expect((await f.service.debugState('s1')).session?.state).toBe('stopped');
  await f.service.removeWorktree('s1', f.target.copyGeneration);
});
