import assert from 'node:assert/strict';
import { ApiError } from '@corral/client';
import type {
  TerminalAck,
  TerminalList,
  TerminalStreamMessage,
  TerminalView,
} from '@corral/contracts';
import { Gate } from '@corral/testkit';
import type { Terminal } from '@xterm/xterm';
import { expect, it, vi } from 'vitest';
import { type TerminalClient, terminalStore } from './store.ts';
import type { XtermRuntime } from './xterm.ts';

const target = {
  hostId: 'host',
  projectId: 'project',
  bindingId: 'binding',
  sessionId: 'session',
  copyGeneration: 1,
};
function terminal(): TerminalView {
  return {
    terminalId: 'terminal',
    target,
    generation: 'process',
    shellId: 'bash',
    state: 'running',
    initialCols: 80,
    initialRows: 24,
    cols: 80,
    rows: 24,
    lastSequence: 0,
    replayAvailable: true,
    controllerGeneration: 1,
    controller: { attachmentId: 'attachment', generation: 1, acceptedSequence: 0 },
    exitCode: null,
    error: null,
  };
}
function setup() {
  let current = terminal();
  let handler: (message: TerminalStreamMessage) => void | Promise<void> = () => {};
  const callbacks: (() => void)[] = [];
  const write = vi.fn((_data: string, callback: () => void) => callbacks.push(callback));
  const resize = vi.fn();
  let selectionChanged = () => {};
  const selection = {
    text: 'selected 한글',
    range: { start: { x: 0, y: 2 }, end: { x: 8, y: 2 } },
  };
  const select = vi.fn();
  const runtime = {
    terminal: {
      write,
      resize,
      options: {},
      cols: 80,
      rows: 24,
      attachCustomKeyEventHandler: vi.fn(),
      hasSelection: () => Boolean(selection.text),
      getSelection: () => selection.text,
      getSelectionPosition: () => (selection.text ? selection.range : undefined),
      onSelectionChange: (listener: () => void) => {
        selectionChanged = listener;
        return { dispose: vi.fn() };
      },
      buffer: { active: { type: 'normal', length: 24 } },
      select,
      scrollToLine: vi.fn(),
      focus: vi.fn(),
    } as unknown as Terminal,
    host: { remove: vi.fn() },
    fit: { proposeDimensions: () => undefined },
    dispose: vi.fn(),
  } as unknown as XtermRuntime;
  const client = {
    list: vi.fn(
      async (): Promise<TerminalList> => ({
        target,
        available: true,
        reason: null,
        shells: [{ id: 'bash', label: 'Bash' }],
        terminals: [current],
      }),
    ),
    read: vi.fn(async () => current),
    create: vi.fn<TerminalClient['create']>(async () => current),
    control: vi.fn(async (_session, _id, command) => {
      current = {
        ...current,
        controllerGeneration: current.controllerGeneration + 1,
        controller:
          command.action === 'release'
            ? null
            : {
                attachmentId: command.attachmentId,
                generation: current.controllerGeneration + 1,
                acceptedSequence: 0,
              },
      };
      return current;
    }),
    input: vi.fn(
      async (_session, _id, frame): Promise<TerminalAck> => ({
        generation: current.generation,
        controllerGeneration: frame.controllerGeneration,
        acceptedSequence: frame.sequence,
      }),
    ),
    resize: vi.fn(
      async (_session, _id, frame): Promise<TerminalAck> => ({
        generation: current.generation,
        controllerGeneration: frame.controllerGeneration,
        acceptedSequence: frame.sequence,
      }),
    ),
    stop: vi.fn(async () => ({ ...current, state: 'exited' as const })),
    subscribe: vi.fn((_session, _id, _cursor, handlers) => {
      handler = handlers.onEvent;
      return vi.fn();
    }),
  } satisfies TerminalClient;
  const store = terminalStore(client, {
    attachmentId: 'attachment',
    newOperationId: () => 'new_terminal',
    createRuntime: async () => runtime,
  });
  const container = { append: vi.fn(), focus: vi.fn() } as unknown as HTMLElement;
  return {
    store,
    client,
    runtime,
    callbacks,
    selection,
    selectionChanged: () => selectionChanged(),
    select,
    write,
    resize,
    container,
    emit: (event: TerminalStreamMessage) => handler(event),
    setCurrent: (value: TerminalView) => {
      current = value;
    },
  };
}

it('advances replay only after xterm applies output and preserves the model across detach', async () => {
  const f = setup();
  await f.store.refresh('session');
  const detach = await f.store.mount('terminal', f.container, 'Terminal');
  const writing = f.emit({ type: 'output', generation: 'process', sequence: 1, data: '\u001b[31' });
  expect(f.store.getState().terminals.terminal?.appliedSequence).toBe(0);
  await Promise.resolve();
  const reconnect = f.store.reconnect('terminal');
  expect(f.client.subscribe).toHaveBeenCalledTimes(1);
  const applied = f.callbacks.shift();
  assert(applied);
  applied();
  await writing;
  await reconnect;
  expect(f.store.getState().terminals.terminal?.appliedSequence).toBe(1);
  detach();
  await f.store.mount('terminal', f.container, 'Terminal');
  expect(f.runtime.dispose).not.toHaveBeenCalled();
  expect(f.client.subscribe).toHaveBeenCalledTimes(2);
  expect(f.client.subscribe.mock.calls.at(-1)?.[2]).toEqual({ generation: 'process', after: 1 });
  f.store.dispose();
});

it('serializes input and coalesced resize, then drops queued input after a lost acknowledgement', async () => {
  const f = setup();
  const gate = new Gate();
  f.client.input.mockImplementationOnce(async () => {
    await gate.wait();
    throw new Error('disconnected');
  });
  await f.store.refresh('session');
  await f.store.mount('terminal', f.container, 'Terminal');
  await f.emit({ type: 'status', terminal: terminal() });
  f.store.sendInput('terminal', 'first');
  f.store.sendInput('terminal', 'never replay');
  f.store.resize('terminal', 100, 30);
  f.store.resize('terminal', 120, 40);
  expect(f.client.input).toHaveBeenCalledTimes(1);
  expect(f.client.resize).not.toHaveBeenCalled();
  gate.open();
  await vi.waitFor(() => expect(f.store.getState().terminals.terminal?.inputUnknown).toBe(true), {
    timeout: 5000,
  });
  await f.store.checkInput('terminal');
  expect(f.store.getState().terminals.terminal?.inputUnknown).toBe(true);
  await f.store.claim('terminal', true);
  expect(f.store.getState().terminals.terminal?.inputUnknown).toBe(false);
  expect(f.client.input).toHaveBeenCalledTimes(1);
  f.store.sendInput('terminal', 'new');
  await vi.waitFor(() => expect(f.client.input).toHaveBeenCalledTimes(2), { timeout: 5000 });
  expect(f.client.input.mock.calls[1]?.[2]).toMatchObject({
    sequence: 1,
    controllerGeneration: 2,
    data: 'new',
  });
  f.store.dispose();
});

it('refuses fresh replay after overflow and rejects oversized paste without sending a partial command', async () => {
  const f = setup();
  f.setCurrent({ ...terminal(), replayAvailable: false, lastSequence: 40 });
  await f.store.refresh('session');
  await f.store.mount('terminal', f.container, 'Terminal');
  expect(f.client.subscribe).not.toHaveBeenCalled();
  expect(f.store.getState().terminals.terminal?.connection).toBe('unavailable');
  f.store.sendInput('terminal', '한'.repeat(30_000));
  expect(f.client.input).not.toHaveBeenCalled();
  f.store.dispose();
});

it('preserves Unicode across bounded frames and uses one sequence for input and the latest resize', async () => {
  const f = setup();
  const gate = new Gate();
  f.client.input.mockImplementationOnce(async (_session, _id, frame) => {
    await gate.wait();
    return {
      generation: 'process',
      controllerGeneration: frame.controllerGeneration,
      acceptedSequence: frame.sequence,
    };
  });
  await f.store.refresh('session');
  await f.store.mount('terminal', f.container, 'Terminal');
  await f.emit({ type: 'status', terminal: terminal() });
  const text = '한😀'.repeat(3000);
  f.store.sendInput('terminal', text);
  f.store.resize('terminal', 100, 30);
  f.store.resize('terminal', 120, 40);
  expect(f.client.input).toHaveBeenCalledTimes(1);
  gate.open();
  await vi.waitFor(() => expect(f.client.resize).toHaveBeenCalledTimes(1), { timeout: 5000 });
  const frames = f.client.input.mock.calls.map((call) => call[2]);
  expect(frames.map((frame) => frame.data).join('')).toBe(text);
  expect(frames.every((frame) => Buffer.byteLength(frame.data) <= 16 * 1024)).toBe(true);
  expect(f.client.resize.mock.calls[0]?.[2]).toMatchObject({
    cols: 120,
    rows: 40,
    sequence: frames.length + 1,
  });
  const count = frames.length;
  f.store.sendInput('terminal', '한'.repeat(30_000));
  expect(f.client.input).toHaveBeenCalledTimes(count);
  expect(f.store.getState().terminals.terminal?.inputOverflow).toBe(true);
  f.store.dispose();
});

it('an older detached pane cannot remove the host from its newer mount', async () => {
  const f = setup();
  await f.store.refresh('session');
  const first = await f.store.mount('terminal', f.container, 'Terminal');
  const second = await f.store.mount('terminal', f.container, 'Terminal');
  first();
  expect(f.runtime.host.remove).not.toHaveBeenCalled();
  second();
  expect(f.runtime.host.remove).toHaveBeenCalledTimes(1);
  f.store.dispose();
});

it('closes an ended stream only after its final output has been applied', async () => {
  const f = setup();
  await f.store.refresh('session');
  await f.store.mount('terminal', f.container, 'Terminal');
  const close = f.client.subscribe.mock.results[0]?.value;
  await f.emit({ type: 'status', terminal: { ...terminal(), state: 'exited', lastSequence: 1 } });
  expect(close).not.toHaveBeenCalled();
  const writing = f.emit({ type: 'output', generation: 'process', sequence: 1, data: 'finished' });
  await Promise.resolve();
  expect(close).not.toHaveBeenCalled();
  const applied = f.callbacks.shift();
  assert(applied);
  applied();
  await writing;
  expect(close).toHaveBeenCalledTimes(1);
  await f.store.mount('terminal', f.container, 'Terminal');
  expect(f.client.subscribe).toHaveBeenCalledTimes(1);
  f.store.dispose();
});

it('retries creation only after an explicit missing receipt check and keeps its original identity', async () => {
  const f = setup();
  f.client.create.mockRejectedValueOnce(new Error('ack lost'));
  f.client.read.mockRejectedValueOnce(new ApiError(404, 'TARGET_NOT_FOUND', 'missing'));
  await f.store.refresh('session');
  await f.store.create('session', 'bash');
  expect(f.store.getState().sessions.session?.pendingCreate?.operationId).toBe('new_terminal');
  await f.store.retryCreate('session');
  expect(f.client.create).toHaveBeenCalledTimes(1);
  await f.store.checkCreate('session');
  expect(f.store.getState().sessions.session?.canRetryCreate).toBe(true);
  await f.store.retryCreate('session');
  expect(f.client.create).toHaveBeenCalledTimes(2);
  expect(f.client.create.mock.calls[1]?.[1]).toEqual(f.client.create.mock.calls[0]?.[1]);
  f.store.dispose();
});

it('captures only the explicit selection after its pending output is applied', async () => {
  const f = setup();
  await f.store.refresh('session');
  await f.store.mount('terminal', f.container, 'Terminal');
  const writing = f.emit({ type: 'output', generation: 'process', sequence: 1, data: 'output' });
  const captured = f.store.captureSelection('terminal');
  let completed = false;
  void captured.then(() => {
    completed = true;
  });
  await Promise.resolve();
  expect(completed).toBe(false);
  const applied = f.callbacks.shift();
  assert(applied);
  applied();
  await writing;
  const result = await captured;
  expect(result).toEqual({
    text: 'selected 한글',
    provenance: {
      kind: 'terminal',
      target,
      terminalId: 'terminal',
      generation: 'process',
      outputSequence: 1,
      buffer: 'normal',
      cols: 80,
      rows: 24,
      range: { startRow: 2, startColumn: 0, endRow: 2, endColumn: 8 },
    },
  });
  assert(result);
  expect(f.store.inspectSelection(result.provenance)).toBe('current');
  expect(
    f.store.inspectSelection({
      ...result.provenance,
      range: { startRow: 10_000, startColumn: 0, endRow: 10_000, endColumn: 8 },
    }),
  ).toBe('unavailable');
  expect(await f.store.revealSelection(result.provenance)).toBe(true);
  expect(f.select).toHaveBeenCalledWith(0, 2, 8);
  f.store.dispose();
});

it('does not reinterpret an old range after output or another target changes', async () => {
  const f = setup();
  await f.store.refresh('session');
  await f.store.mount('terminal', f.container, 'Terminal');
  const result = await f.store.captureSelection('terminal');
  assert(result);
  await f.emit({ type: 'resize', generation: 'process', sequence: 1, cols: 100, rows: 30 });
  expect(f.store.inspectSelection(result.provenance)).toBe('stale');
  expect(await f.store.revealSelection(result.provenance)).toBe(false);
  expect(f.select).not.toHaveBeenCalled();
  expect(
    f.store.inspectSelection({ ...result.provenance, target: { ...target, hostId: 'other' } }),
  ).toBe('unavailable');
  f.store.dispose();
});

it('keeps only selection availability in state and refuses an oversized selection without truncating', async () => {
  const f = setup();
  await f.store.refresh('session');
  await f.store.mount('terminal', f.container, 'Terminal');
  expect(f.store.getState().terminals.terminal?.hasSelection).toBe(true);
  expect(JSON.stringify(f.store.getState())).not.toContain('selected 한글');
  f.selection.text = '';
  f.selectionChanged();
  expect(f.store.getState().terminals.terminal?.hasSelection).toBe(false);
  expect(await f.store.captureSelection('terminal')).toBeNull();
  f.selection.text = '한'.repeat(30_000);
  await expect(f.store.captureSelection('terminal')).rejects.toThrow('64 KiB');
  expect(f.selection.text.length).toBe(30_000);
  f.store.dispose();
});
