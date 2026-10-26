// @vitest-environment jsdom
import type {
  DebugBreakpoints,
  DebugCommand,
  DebugCommandResult,
  DebugInspect,
  DebugQueryResult,
  DebugSession,
  DebugStart,
  DebugState,
  FileDocument,
} from '@corral/contracts';
import { afterEach, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { type DocumentBuffer, type DocumentStore, documentKey } from '../documents/store.ts';
import { debugCopyKey, debugStore } from './store.ts';

const target = {
  hostId: 'host',
  projectId: 'project',
  bindingId: 'binding',
  sessionId: 'session',
  copyGeneration: 1,
};
const session: DebugSession = {
  generation: 'debug_one',
  clientId: 'client',
  configId: 'node',
  configRevision: 1,
  fingerprint: 'a'.repeat(64),
  runtime: 'node',
  ownership: 'attached',
  state: 'paused',
  revision: 1,
  pauseId: 1,
  pausedThreadId: 'thread',
  canDisconnect: true,
  canStop: false,
  breakpoints: [],
  output: '',
  error: null,
};
const frame = {
  id: 'frame',
  name: 'main',
  source: {
    path: 'main.ts',
    name: 'main.ts',
    sha256: 'b'.repeat(64),
    line: 1,
    column: 1,
    mapped: true,
    reason: null,
  },
};
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  vi.useRealTimers();
});
const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
function setup() {
  const key = documentKey(target, 'main.ts');
  const entry = {
    key,
    target,
    path: 'main.ts',
    text: 'const value = 1;',
    baseHash: frame.source.sha256,
    editVersion: 0,
    model: null,
    dirty: false,
    saving: false,
    pendingSave: null,
    conflict: null,
  } as DocumentBuffer;
  const documents = Object.assign(
    createStore(() => ({ documents: { [key]: entry } })),
    { open: vi.fn(async () => key) },
  ) as unknown as DocumentStore;
  const file: FileDocument = {
    target,
    path: 'main.ts',
    content: { kind: 'text', text: entry.text },
    writable: true,
    version: { sha256: frame.source.sha256, bytes: 16, encoding: 'utf-8', bom: false, eol: 'none' },
  };
  const configuration = {
    id: 'node',
    name: 'Node attach',
    adapterId: 'adapter',
    cwd: '.',
    runtime: 'node' as const,
    request: 'attach' as const,
  };
  let state: DebugState = {
    target,
    available: true,
    unavailableReason: null,
    configurations: [configuration],
    session,
  };
  const result = (commandId: string): DebugCommandResult => ({
    commandId,
    state: 'succeeded',
    session: { ...session, revision: 2 },
  });
  const api = {
    debugState: vi.fn(async () => state),
    inspectDebug: vi.fn(async (_id: string, input: DebugInspect) => ({
      target: input.target,
      configuration,
      adapter: { id: 'adapter', name: 'Adapter', argv: ['adapter'], timeoutMs: 30000 },
      configRevision: 1,
      fingerprint: session.fingerprint,
      trusted: false,
    })),
    startDebug: vi.fn(async (_id: string, input: DebugStart) => {
      const started = { ...session, clientId: input.clientId };
      state = { ...state, session: started };
      return started;
    }),
    setDebugBreakpoints: vi.fn(async (_id: string, input: DebugBreakpoints) =>
      result(input.commandId),
    ),
    queryDebug: vi.fn(
      async (): Promise<DebugQueryResult> => ({
        generation: session.generation,
        pauseId: 1,
        revision: 1,
        frames: [frame],
      }),
    ),
    commandDebug: vi.fn(async (_id: string, input: DebugCommand) => result(input.commandId)),
    debugCommand: vi.fn(async (_id: string, _generation: string, commandId: string) =>
      result(commandId),
    ),
    readDocument: vi.fn(async () => file),
  };
  let id = 0;
  const store = debugStore(api, documents, {
    clientId: 'client',
    newId: () => `debug_request_${++id}`,
  });
  cleanups.push(() => store.dispose());
  return {
    key,
    entry,
    documents,
    file,
    api,
    store,
    state: () => state,
    setState: (value: DebugState) => {
      state = value;
    },
  };
}

it('retained views share polling, never stop on close, and recover a lost command by its id', async () => {
  vi.useFakeTimers();
  const f = setup();
  f.setState({ ...f.state(), session: null });
  const releaseOne = f.store.retain(target),
    releaseTwo = f.store.retain(target);
  await settle();
  expect(f.api.debugState).toHaveBeenCalledTimes(1);
  const attach = { operationId: 'task', port: 9229 };
  await f.store.inspect(target, 'node', { attach });
  attach.port = 9333;
  await f.store.start(target, true);
  expect(f.api.startDebug).toHaveBeenCalledWith(
    'session',
    expect.objectContaining({
      attach: { operationId: 'task', port: 9229 },
      fingerprint: session.fingerprint,
      trust: true,
    }),
  );
  const beforePoll = f.api.debugState.mock.calls.length;
  releaseOne();
  await vi.advanceTimersByTimeAsync(3000);
  expect(f.api.debugState).toHaveBeenCalledTimes(beforePoll + 1);
  releaseTwo();
  await vi.advanceTimersByTimeAsync(6000);
  expect(f.api.debugState).toHaveBeenCalledTimes(beforePoll + 1);
  expect(f.api.commandDebug).not.toHaveBeenCalled();
  f.api.commandDebug.mockRejectedValueOnce(new Error('response lost'));
  const command = {
    generation: session.generation,
    revision: 1,
    pauseId: 1,
    kind: 'continue' as const,
    threadId: 'thread',
  };
  expect(await f.store.command(target, command)).toBeNull();
  const pending = f.store.getState().copies[debugCopyKey(target)]?.pendingCommandId;
  expect(pending).toBeTruthy();
  await f.store.command(target, command);
  expect(f.api.commandDebug).toHaveBeenCalledTimes(1);
  await f.store.checkCommand(target);
  expect(f.api.debugCommand).toHaveBeenCalledWith('session', session.generation, pending);
  expect(f.store.getState().copies[debugCopyKey(target)]?.pendingCommandId).toBeNull();
  const recovering = setup();
  await recovering.store.refresh(target);
  recovering.api.commandDebug.mockRejectedValueOnce(new Error('response lost'));
  await recovering.store.command(target, command);
  recovering.api.debugCommand.mockImplementationOnce(async (_id, _generation, commandId) => ({
    commandId,
    state: 'uncertain',
    session: { ...session, state: 'uncertain', canStop: true },
  }));
  await recovering.store.checkCommand(target);
  const uncertainId = recovering.store.getState().copies[debugCopyKey(target)]?.pendingCommandId;
  recovering.api.commandDebug.mockImplementationOnce(async (_id, input) => ({
    commandId: input.commandId,
    state: 'succeeded',
    session: { ...session, state: 'stopped', revision: 2 },
  }));
  expect(await recovering.store.command(target, { ...command, kind: 'stop' })).toMatchObject({
    state: 'succeeded',
  });
  expect(recovering.api.commandDebug.mock.calls[1]?.[1].commandId).not.toBe(uncertainId);
  expect(recovering.store.getState().copies[debugCopyKey(target)]?.interruptedCommandId).toBe(
    uncertainId,
  );
  expect(recovering.api.debugCommand).toHaveBeenCalledTimes(1);

  const late = setup();
  await late.store.refresh(target);
  let complete!: (value: DebugCommandResult) => void;
  late.api.commandDebug.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const old = late.store.command(target, command);
  await settle();
  late.api.commandDebug.mockImplementationOnce(async (_id, input) => ({
    commandId: input.commandId,
    state: 'succeeded',
    session: { ...session, state: 'stopped', revision: 2 },
  }));
  const stopped = await late.store.command(target, { ...command, kind: 'stop' });
  expect(stopped).toMatchObject({ state: 'succeeded', session: { state: 'stopped' } });
  complete({
    commandId: late.api.commandDebug.mock.calls[0]?.[1].commandId ?? '',
    state: 'succeeded',
    session,
  });
  expect(await old).toBeNull();
  expect(late.store.getState().copies[debugCopyKey(target)]?.commandResult).toEqual(stopped);
  expect(late.store.getState().copies[debugCopyKey(target)]?.state?.session?.state).toBe('stopped');
});

it('stale pauses, dirty drafts and mismatched source hashes cannot move or alter the editor', async () => {
  const f = setup();
  await f.store.refresh(target);
  const open = vi.fn(() => true);
  f.documents.setState({ documents: { [f.key]: { ...f.entry, dirty: true } } });
  await f.store.toggleBreakpoint(f.key, 1, session.generation);
  expect(f.api.setDebugBreakpoints).not.toHaveBeenCalled();
  expect(
    await f.store.openFrame(
      target,
      frame,
      { generation: session.generation, pauseId: 1, revision: 1 },
      open,
    ),
  ).toBe(false);
  f.documents.setState({ documents: { [f.key]: f.entry } });
  expect(
    await f.store.openFrame(
      target,
      { ...frame, source: { ...frame.source, sha256: 'c'.repeat(64) } },
      { generation: session.generation, pauseId: 1, revision: 1 },
      open,
    ),
  ).toBe(false);
  expect(open).not.toHaveBeenCalled();
  expect(
    await f.store.openFrame(
      target,
      frame,
      { generation: session.generation, pauseId: 1, revision: 1 },
      open,
    ),
  ).toBe(true);
  expect(open).toHaveBeenCalledExactlyOnceWith(target, 'main.ts', {
    startLine: 1,
    startColumn: 1,
    endLine: 1,
    endColumn: 1,
  });
  let resolve!: (value: DebugQueryResult) => void;
  f.api.queryDebug.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const query = f.store.query(target, {
    kind: 'stack',
    generation: session.generation,
    pauseId: 1,
    threadId: 'thread',
  });
  f.setState({ ...f.state(), session: { ...session, revision: 2, pauseId: 2 } });
  await f.store.refresh(target);
  resolve({ generation: session.generation, pauseId: 1, revision: 1, frames: [frame] });
  expect(await query).toBeNull();
  expect(f.store.getState().copies[debugCopyKey(target)]?.frame).toBeNull();
  expect(
    await f.store.openFrame(
      target,
      frame,
      { generation: session.generation, pauseId: 1, revision: 1 },
      open,
    ),
  ).toBe(false);
  expect(f.documents.getState().documents[f.key]?.text).toBe(f.entry.text);
});
