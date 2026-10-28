import { ApiError, type TerminalsApi } from '@corral/client';
import {
  canonicalJson,
  MAX_TERMINAL_INPUT_BYTES,
  MAX_TERMINAL_QUEUED_INPUT_BYTES,
  TEXT_ATTACHMENT_MAX_BYTES,
  type TerminalCreate,
  type TerminalIdentity,
  type TerminalList,
  type TerminalStreamMessage,
  type TerminalView,
  type TextAttachmentProvenance,
} from '@corral/contracts';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { WORKSPACE_CHANGED } from '../workspaceEvents.ts';
import { createXterm, type XtermRuntime } from './xterm.ts';

export type TerminalClient = Pick<
  TerminalsApi,
  'list' | 'create' | 'read' | 'control' | 'input' | 'resize' | 'stop' | 'subscribe'
>;
export type TerminalProvenance = Extract<TextAttachmentProvenance, { kind: 'terminal' }>;
export type TerminalSourceState = 'current' | 'stale' | 'unavailable';
export interface TerminalSelection {
  text: string;
  provenance: TerminalProvenance;
}

export interface TerminalBuffer {
  terminal: TerminalView;
  connection: 'idle' | 'connecting' | 'connected' | 'disconnected' | 'unavailable';
  controlling: boolean;
  inputUnknown: boolean;
  inputOverflow: boolean;
  rateLimited?: boolean;
  error: string | null;
  busy: boolean;
  appliedSequence: number;
  hasSelection: boolean;
}
export interface TerminalSession {
  list: TerminalList | null;
  loading: boolean;
  pendingCreate: TerminalCreate | null;
  canRetryCreate: boolean;
  error: string | null;
}
export interface TerminalStore
  extends StoreApi<{
    terminals: Record<string, TerminalBuffer>;
    sessions: Record<string, TerminalSession>;
  }> {
  refresh(sessionId: string): Promise<void>;
  create(sessionId: string, shellId: string): Promise<string | null>;
  checkCreate(sessionId: string): Promise<void>;
  retryCreate(sessionId: string): Promise<void>;
  claim(id: string, takeover?: boolean): Promise<void>;
  release(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  reconnect(id: string): Promise<void>;
  checkInput(id: string): Promise<void>;
  sendInput(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  mount(
    id: string,
    container: HTMLElement,
    label: string,
    onExit?: () => void,
    descriptionId?: string,
  ): Promise<() => void>;
  captureSelection(id: string): Promise<TerminalSelection | null>;
  inspectSelection(source: TerminalProvenance): TerminalSourceState;
  revealSelection(source: TerminalProvenance): Promise<boolean>;
  dispose(): void;
}
interface Options {
  attachmentId?: string;
  newOperationId?: () => string;
  createRuntime?: typeof createXterm;
  wait?: (milliseconds: number) => Promise<void>;
}
const stores = new WeakMap<TerminalClient, TerminalStore>();
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Terminal operation failed';
const encoder = new TextEncoder();
const byteLength = (text: string) => encoder.encode(text).length;
const emptySession = (): TerminalSession => ({
  list: null,
  loading: false,
  pendingCreate: null,
  canRetryCreate: false,
  error: null,
});

export function terminalStore(client: TerminalClient, options: Options = {}): TerminalStore {
  const existing = stores.get(client);
  if (existing) return existing;
  const state = createStore<{
    terminals: Record<string, TerminalBuffer>;
    sessions: Record<string, TerminalSession>;
  }>(() => ({ terminals: {}, sessions: {} }));
  const attachmentId = options.attachmentId ?? `attachment_${crypto.randomUUID()}`;
  const newOperationId = options.newOperationId ?? (() => `terminal_${crypto.randomUUID()}`);
  const runtimes = new Map<string, XtermRuntime>();
  const loading = new Map<string, Promise<XtermRuntime>>();
  const streams = new Map<string, () => void>();
  const claimOnStart = new Set<string>();
  const mounts = new Map<string, symbol>();
  const applying = new Map<string, Promise<void>>();
  const selectionListeners = new Map<string, { dispose(): void }>();
  type Frame = { kind: 'input'; data: string } | { kind: 'resize'; cols: number; rows: number };
  const queues = new Map<string, { frames: Frame[]; bytes: number; running: boolean }>();
  let disposed = false;
  const get = (id: string) => state.getState().terminals[id];
  const patch = (id: string, change: Partial<TerminalBuffer>) => {
    const value = get(id);
    if (!value || disposed) return;
    const next = { ...value, ...change };
    state.setState({ terminals: { ...state.getState().terminals, [id]: next } });
    const runtime = runtimes.get(id);
    if (runtime) {
      runtime.terminal.options.disableStdin = !canInput(next);
      if (
        canInput(next) &&
        !canInput(value) &&
        runtime.host.isConnected &&
        runtime.host.clientWidth > 0
      ) {
        const dims = runtime.fit.proposeDimensions();
        if (dims) store.resize(id, dims.cols, dims.rows);
      }
    }
  };
  const session = (id: string, change: Partial<TerminalSession>) => {
    if (!disposed)
      state.setState({
        sessions: {
          ...state.getState().sessions,
          [id]: { ...(state.getState().sessions[id] ?? emptySession()), ...change },
        },
      });
  };
  const canInput = (value: TerminalBuffer) =>
    value.controlling &&
    value.terminal.state === 'running' &&
    value.connection === 'connected' &&
    !value.inputUnknown &&
    !value.busy;
  const upsert = (terminal: TerminalView) => {
    const id = terminal.terminalId;
    const previous = get(id);
    if (previous && terminal.controllerGeneration < previous.terminal.controllerGeneration) {
      terminal = {
        ...terminal,
        controllerGeneration: previous.terminal.controllerGeneration,
        controller: previous.terminal.controller,
      };
    } else if (
      previous?.terminal.controller &&
      terminal.controller?.generation === previous.terminal.controller.generation
    ) {
      terminal = {
        ...terminal,
        controller: {
          ...terminal.controller,
          acceptedSequence: Math.max(
            terminal.controller.acceptedSequence,
            previous.terminal.controller.acceptedSequence,
          ),
        },
      };
    }
    if (previous && terminal.controllerGeneration !== previous.terminal.controllerGeneration) {
      queues.delete(id);
      patch(id, { rateLimited: false });
    }
    const controlling = terminal.controller?.attachmentId === attachmentId;
    if (previous) {
      if (terminal.generation !== previous.terminal.generation) {
        streams.get(id)?.();
        streams.delete(id);
        queues.delete(id);
        patch(id, {
          rateLimited: false,
          terminal,
          controlling: false,
          connection: 'unavailable',
          error: 'Terminal process changed. Open a new terminal.',
        });
        return;
      }
      patch(id, { terminal, controlling });
    } else {
      state.setState({
        terminals: {
          ...state.getState().terminals,
          [id]: {
            terminal,
            controlling,
            connection: 'idle',
            inputUnknown: false,
            inputOverflow: false,
            error: null,
            busy: false,
            appliedSequence: 0,
            hasSelection: false,
          },
        },
      });
    }
    if (!controlling || terminal.state !== 'running') {
      queues.delete(id);
      patch(id, { rateLimited: false });
    }
    const currentSession = state.getState().sessions[terminal.target.sessionId];
    if (currentSession?.list) {
      const list = currentSession.list;
      session(terminal.target.sessionId, {
        list: {
          ...list,
          terminals: list.terminals.some((value) => value.terminalId === id)
            ? list.terminals.map((value) => (value.terminalId === id ? terminal : value))
            : [...list.terminals, terminal],
        },
      });
    }
    if (terminal.state === 'running' && claimOnStart.delete(id)) void controlled(id, 'claim');
  };
  const identity = (value: TerminalBuffer): TerminalIdentity => ({
    target: value.terminal.target,
    generation: value.terminal.generation,
  });

  async function drain(id: string) {
    const queue = queues.get(id);
    if (!queue || queue.running) return;
    queue.running = true;
    try {
      while (queue.frames.length && !disposed) {
        const value = get(id);
        if (!value || !canInput(value) || !value.terminal.controller || queues.get(id) !== queue)
          break;
        const controller = value.terminal.controller;
        const frame = queue.frames.shift();
        if (!frame) break;
        let inputBytes = frame.kind === 'input' ? byteLength(frame.data) : 0;
        if (frame.kind === 'input') {
          while (queue.frames[0]?.kind === 'input') {
            const next = queue.frames[0];
            const nextBytes = byteLength(next.data);
            if (inputBytes + nextBytes > MAX_TERMINAL_INPUT_BYTES) break;
            inputBytes += nextBytes;
            frame.data += next.data;
            queue.frames.shift();
          }
        }
        const request = {
          ...identity(value),
          attachmentId,
          controllerGeneration: controller.generation,
          sequence: controller.acceptedSequence + 1,
        };
        try {
          const ack =
            frame.kind === 'input'
              ? await client.input(value.terminal.target.sessionId, id, {
                  ...request,
                  data: frame.data,
                })
              : await client.resize(value.terminal.target.sessionId, id, {
                  ...request,
                  cols: frame.cols,
                  rows: frame.rows,
                });
          const latest = get(id);
          if (
            queues.get(id) !== queue ||
            !latest ||
            latest.terminal.generation !== request.generation ||
            latest.terminal.controller?.generation !== request.controllerGeneration
          )
            break;
          if (
            ack.generation !== request.generation ||
            ack.controllerGeneration !== request.controllerGeneration ||
            ack.acceptedSequence !== request.sequence
          )
            throw new Error('Terminal input acknowledgement did not match.');
          queue.bytes -= inputBytes;
          patch(id, {
            rateLimited: false,
            error: null,
            terminal: {
              ...latest.terminal,
              controller: { ...latest.terminal.controller, acceptedSequence: ack.acceptedSequence },
            },
          });
        } catch (error) {
          if (queues.get(id) !== queue) break;
          if (error instanceof ApiError && error.status === 429) {
            queue.frames.unshift(frame);
            patch(id, { rateLimited: true, error: null });
            await (
              options.wait ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
            )(error.retryAfterMs ?? 1000);
            continue;
          }
          queues.delete(id);
          patch(id, { inputUnknown: true, rateLimited: false, error: errorMessage(error) });
          break;
        }
      }
    } finally {
      queue.running = false;
    }
  }
  function enqueue(id: string, frame: Frame) {
    const value = get(id);
    if (!value || !canInput(value)) return;
    const queue = queues.get(id) ?? { frames: [], bytes: 0, running: false };
    queues.set(id, queue);
    if (frame.kind === 'resize') {
      queue.frames = queue.frames.filter((pending) => pending.kind !== 'resize');
      queue.frames.push(frame);
    } else {
      const size = byteLength(frame.data);
      if (queue.bytes + size > MAX_TERMINAL_QUEUED_INPUT_BYTES) {
        patch(id, { inputOverflow: true });
        return;
      }
      queue.bytes += size;
      let chunk = '';
      let bytes = 0;
      for (const point of frame.data) {
        const code = point.charCodeAt(0);
        const size = point.length === 2 ? 4 : code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
        if (bytes + size > MAX_TERMINAL_INPUT_BYTES) {
          queue.frames.push({ kind: 'input', data: chunk });
          chunk = '';
          bytes = 0;
        }
        chunk += point;
        bytes += size;
      }
      if (chunk) queue.frames.push({ kind: 'input', data: chunk });
      patch(id, { inputOverflow: false });
    }
    void drain(id);
  }
  function closeFinishedStream(id: string) {
    const value = get(id);
    if (
      value &&
      (value.terminal.state === 'exited' || value.terminal.state === 'failed') &&
      value.appliedSequence >= value.terminal.lastSequence
    ) {
      streams.get(id)?.();
      streams.delete(id);
    }
  }
  function afterOutput<T>(id: string, work: () => T | Promise<T>): Promise<T> {
    const result = (applying.get(id) ?? Promise.resolve()).then(work);
    applying.set(
      id,
      result.then(
        () => {},
        () => {},
      ),
    );
    return result;
  }
  function inspectSelection(source: TerminalProvenance): TerminalSourceState {
    const value = get(source.terminalId);
    const runtime = runtimes.get(source.terminalId);
    if (
      !value ||
      !runtime ||
      value.terminal.generation !== source.generation ||
      canonicalJson(value.terminal.target) !== canonicalJson(source.target)
    )
      return 'unavailable';
    const terminal = runtime.terminal;
    if (
      value.appliedSequence !== source.outputSequence ||
      terminal.cols !== source.cols ||
      terminal.rows !== source.rows ||
      terminal.buffer.active.type !== source.buffer
    )
      return 'stale';
    const length = terminal.buffer.active.length;
    return source.range.startRow < length &&
      (source.range.endRow < length ||
        (source.range.endRow === length && source.range.endColumn === 0))
      ? 'current'
      : 'unavailable';
  }
  async function apply(id: string, message: TerminalStreamMessage) {
    const value = get(id);
    const runtime = runtimes.get(id);
    if (!value || !runtime || disposed) return;
    if (message.type === 'status') {
      upsert(message.terminal);
      if (
        message.terminal.lastSequence <= value.appliedSequence &&
        get(id)?.connection !== 'unavailable'
      )
        patch(id, { connection: 'connected', error: null });
      closeFinishedStream(id);
      return;
    }
    if (message.generation !== value.terminal.generation)
      throw new Error('Terminal output belongs to another process.');
    if (message.sequence <= value.appliedSequence) return;
    if (message.sequence !== value.appliedSequence + 1)
      throw new Error('Terminal output has a gap. Reconnect before continuing.');
    if (message.type === 'output')
      await new Promise<void>((resolve) => runtime.terminal.write(message.data, resolve));
    else {
      runtime.terminal.resize(message.cols, message.rows);
      const latest = get(id);
      if (latest)
        patch(id, { terminal: { ...latest.terminal, cols: message.cols, rows: message.rows } });
    }
    patch(id, {
      appliedSequence: message.sequence,
      ...(message.sequence >= (get(id)?.terminal.lastSequence ?? 0)
        ? { connection: 'connected' as const, error: null }
        : {}),
    });
    closeFinishedStream(id);
  }
  function connect(id: string) {
    const value = get(id);
    if (!value || !runtimes.has(id) || streams.has(id) || value.connection === 'unavailable')
      return;
    if (
      (value.terminal.state === 'exited' || value.terminal.state === 'failed') &&
      value.connection === 'connected' &&
      value.appliedSequence >= value.terminal.lastSequence
    )
      return;
    patch(id, { connection: 'connecting', error: null });
    streams.set(
      id,
      client.subscribe(
        value.terminal.target.sessionId,
        id,
        { generation: value.terminal.generation, after: value.appliedSequence },
        {
          onEvent(message) {
            return afterOutput(id, () => apply(id, message));
          },
          onError(error) {
            const pending = queues.get(id)?.running ?? false;
            queues.delete(id);
            patch(id, {
              connection: 'disconnected',
              rateLimited: false,
              ...(pending ? { inputUnknown: true } : {}),
              error: errorMessage(error),
            });
          },
        },
      ),
    );
  }
  async function controlled(id: string, action: 'claim' | 'release', takeover = false) {
    const value = get(id);
    if (!value || value.busy) return;
    queues.delete(id);
    patch(id, { busy: true, rateLimited: false, error: null });
    try {
      upsert(
        await client.control(value.terminal.target.sessionId, id, {
          ...identity(value),
          attachmentId,
          expectedGeneration: value.terminal.controllerGeneration,
          action,
          takeover,
        }),
      );
      patch(id, { inputUnknown: false, inputOverflow: false });
    } catch (error) {
      patch(id, { error: errorMessage(error) });
    } finally {
      patch(id, { busy: false });
    }
  }
  async function submitCreate(sessionId: string, command: TerminalCreate): Promise<string | null> {
    session(sessionId, {
      loading: true,
      pendingCreate: command,
      canRetryCreate: false,
      error: null,
    });
    try {
      const terminal = await client.create(sessionId, command);
      claimOnStart.add(terminal.terminalId);
      upsert(terminal);
      session(sessionId, { pendingCreate: null });
      return terminal.terminalId;
    } catch (error) {
      const refused =
        error instanceof ApiError && error.status < 500 && error.code !== 'REQUEST_OUTCOME_UNKNOWN';
      session(sessionId, {
        error: errorMessage(error),
        ...(refused ? { pendingCreate: null } : {}),
      });
      return null;
    } finally {
      session(sessionId, { loading: false });
    }
  }
  const store: TerminalStore = {
    ...state,
    async refresh(sessionId) {
      session(sessionId, { loading: true, error: null });
      try {
        const list = await client.list(sessionId);
        list.terminals.forEach(upsert);
        session(sessionId, { list });
      } catch (error) {
        session(sessionId, { error: errorMessage(error) });
      } finally {
        session(sessionId, { loading: false });
      }
    },
    async create(sessionId, shellId) {
      const value = state.getState().sessions[sessionId];
      if (!value?.list?.target || !value.list.available || value.pendingCreate || value.loading)
        return null;
      return submitCreate(sessionId, {
        operationId: newOperationId(),
        target: value.list.target,
        shellId,
        cols: 80,
        rows: 24,
      });
    },
    async checkCreate(sessionId) {
      const value = state.getState().sessions[sessionId];
      if (!value?.pendingCreate || value.loading) return;
      session(sessionId, { loading: true, canRetryCreate: false, error: null });
      try {
        const terminal = await client.read(sessionId, value.pendingCreate.operationId);
        claimOnStart.add(terminal.terminalId);
        upsert(terminal);
        session(sessionId, { pendingCreate: null });
      } catch (error) {
        session(sessionId, {
          canRetryCreate: error instanceof ApiError && error.status === 404,
          error: errorMessage(error),
        });
      } finally {
        session(sessionId, { loading: false });
      }
    },
    async retryCreate(sessionId) {
      const value = state.getState().sessions[sessionId];
      if (value?.pendingCreate && value.canRetryCreate && !value.loading)
        await submitCreate(sessionId, value.pendingCreate);
    },
    claim: (id, takeover = false) => controlled(id, 'claim', takeover),
    release: (id) => controlled(id, 'release'),
    async stop(id) {
      const value = get(id);
      if (!value || value.busy) return;
      queues.delete(id);
      patch(id, { busy: true, rateLimited: false, error: null });
      try {
        upsert(await client.stop(value.terminal.target.sessionId, id, identity(value)));
        if (typeof window !== 'undefined') window.dispatchEvent(new Event(WORKSPACE_CHANGED));
      } catch (error) {
        patch(id, { error: errorMessage(error) });
      } finally {
        patch(id, { busy: false });
      }
    },
    async reconnect(id) {
      const value = get(id);
      if (!value || value.connection === 'unavailable') return;
      streams.get(id)?.();
      streams.delete(id);
      await applying.get(id);
      connect(id);
    },
    async checkInput(id) {
      const value = get(id);
      if (!value || value.busy) return;
      patch(id, { busy: true });
      try {
        upsert(await client.read(value.terminal.target.sessionId, id));
      } catch (error) {
        patch(id, { error: errorMessage(error) });
      } finally {
        patch(id, { busy: false });
      }
    },
    sendInput(id, data) {
      if (data) enqueue(id, { kind: 'input', data });
    },
    resize(id, cols, rows) {
      if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
      const value = get(id);
      if (!value || (value.terminal.cols === cols && value.terminal.rows === rows)) return;
      enqueue(id, {
        kind: 'resize',
        cols: Math.max(2, Math.min(500, cols)),
        rows: Math.max(1, Math.min(500, rows)),
      });
    },
    async mount(id, container, label, onExit, descriptionId) {
      const value = get(id);
      if (!value) return () => {};
      if (!runtimes.has(id) && !value.terminal.replayAvailable) {
        patch(id, { connection: 'unavailable' });
        return () => {};
      }
      let runtime = runtimes.get(id);
      try {
        if (!runtime) {
          let promise = loading.get(id);
          if (!promise) {
            promise = (options.createRuntime ?? createXterm)(
              container,
              value.terminal.initialCols,
              value.terminal.initialRows,
              (data) => store.sendInput(id, data),
            );
            loading.set(id, promise);
          }
          runtime = await promise;
          loading.delete(id);
          if (disposed) {
            runtime.dispose();
            return () => {};
          }
          runtimes.set(id, runtime);
        }
        if (!selectionListeners.has(id)) {
          const instance = runtime.terminal;
          selectionListeners.set(
            id,
            instance.onSelectionChange(() => patch(id, { hasSelection: instance.hasSelection() })),
          );
        }
        patch(id, { hasSelection: runtime.terminal.hasSelection() });
        container.append(runtime.host);
        runtime.terminal.textarea?.setAttribute('aria-label', label);
        if (descriptionId)
          runtime.terminal.textarea?.setAttribute('aria-describedby', descriptionId);
        runtime.terminal.attachCustomKeyEventHandler((event) => {
          if (event.type === 'keydown' && event.key === 'Escape' && event.shiftKey && onExit) {
            event.preventDefault();
            onExit();
            return false;
          }
          return true;
        });
        patch(id, {});
        connect(id);
        const mounted = runtime;
        const owner = Symbol();
        mounts.set(id, owner);
        const measure = () => {
          if (
            mounts.get(id) !== owner ||
            container.clientWidth === 0 ||
            container.clientHeight === 0
          )
            return;
          const dims = mounted.fit.proposeDimensions();
          if (dims) store.resize(id, dims.cols, dims.rows);
        };
        const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
        observer?.observe(container);
        measure();
        // Detaching a pane keeps parser state, bounded scrollback and the output stream alive.
        return () => {
          observer?.disconnect();
          if (mounts.get(id) === owner) {
            mounts.delete(id);
            mounted.host.remove();
          }
        };
      } catch (error) {
        loading.delete(id);
        patch(id, { connection: 'unavailable', error: errorMessage(error) });
        return () => {};
      }
    },
    captureSelection(id) {
      return afterOutput<TerminalSelection | null>(id, () => {
        const value = get(id);
        const terminal = runtimes.get(id)?.terminal;
        const range = terminal?.getSelectionPosition();
        if (!value || !terminal || !range) return null;
        const text = terminal.getSelection();
        if (!text) return null;
        if (byteLength(text) > TEXT_ATTACHMENT_MAX_BYTES)
          throw new Error('Terminal selection exceeds 64 KiB.');
        return {
          text,
          provenance: {
            kind: 'terminal',
            target: { ...value.terminal.target },
            terminalId: id,
            generation: value.terminal.generation,
            outputSequence: value.appliedSequence,
            buffer: terminal.buffer.active.type,
            cols: terminal.cols,
            rows: terminal.rows,
            range: {
              startRow: range.start.y,
              startColumn: range.start.x,
              endRow: range.end.y,
              endColumn: range.end.x,
            },
          },
        };
      });
    },
    inspectSelection,
    revealSelection(source) {
      return afterOutput(source.terminalId, () => {
        if (inspectSelection(source) !== 'current') return false;
        const terminal = runtimes.get(source.terminalId)?.terminal;
        if (!terminal) return false;
        const { startRow, startColumn, endRow, endColumn } = source.range;
        terminal.select(
          startColumn,
          startRow,
          (endRow - startRow) * source.cols + endColumn - startColumn,
        );
        terminal.scrollToLine(startRow);
        terminal.focus();
        return true;
      });
    },
    dispose() {
      disposed = true;
      for (const listener of selectionListeners.values()) listener.dispose();
      selectionListeners.clear();
      for (const stop of streams.values()) stop();
      for (const runtime of runtimes.values()) runtime.dispose();
      streams.clear();
      runtimes.clear();
      queues.clear();
      stores.delete(client);
    },
  };
  stores.set(client, store);
  return store;
}
