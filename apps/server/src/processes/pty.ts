import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type HostProcessReservation,
  reserveHostProcessGroup,
  restoreHostProcessGroupReservation,
} from '@corral/adapter-pi/processes';
import {
  MAX_TERMINAL_INPUT_BYTES,
  type Scheduler,
  type TerminalAck,
  TerminalControllerChange,
  TerminalCreate,
  type TerminalEvent,
  TerminalIdentity,
  TerminalInput,
  type TerminalList,
  TerminalResize,
  type TerminalStreamMessage,
  type TerminalView,
  type WorkspaceTarget,
} from '@corral/contracts';
import { canonicalJson, ToolRefusal } from '@corral/core';
import type { IPty, IPtyForkOptions } from 'node-pty';
import type { WorkbenchOperations } from '../files/workbench-operations.ts';
import { capturePtySession, cleanupPtySession, type PtySessionIdentity } from './pty-session.ts';
import { commandEnvironment, listShells, type ShellInfo } from './shells.ts';

type Pty = Pick<IPty, 'pid' | 'write' | 'resize' | 'kill' | 'onData' | 'onExit'>;
type Spawn = (file: string, args: string[], options: IPtyForkOptions) => Pty;
type StoredTerminal = { kind: 'terminal'; terminal: TerminalView; identity?: PtySessionIdentity };
type Listener = (event: TerminalStreamMessage) => void;
type Entry = {
  view: TerminalView;
  identity?: PtySessionIdentity;
  child?: Pty;
  reservation?: HostProcessReservation;
  home?: string;
  stopped: boolean;
  failed: boolean;
  events: TerminalEvent[];
  bytes: number;
  listeners: Set<Listener>;
  lastFrameHash?: string;
  completion: Promise<void>;
  resolveCompletion: () => void;
  settling?: Promise<void>;
  cancelRetention?: () => void;
};

export interface PtyRuntimeOptions {
  operations: WorkbenchOperations;
  target(
    sessionId: string,
    expected?: WorkspaceTarget,
  ): { target: WorkspaceTarget; path: string; writable: boolean };
  prepare(input: TerminalCreate): Promise<string>;
  shells?: () => Promise<ShellInfo[]>;
  spawn?: Spawn;
  capture?: typeof capturePtySession;
  cleanup?: typeof cleanupPtySession;
  newGeneration?: () => string;
  timers?: Scheduler;
  historyBytes?: number;
}

const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const timers: Scheduler = {
  after(ms, callback) {
    const timer = setTimeout(callback, ms);
    timer.unref();
    return () => clearTimeout(timer);
  },
};

/** User terminals retain their writer and host permit until the entire OS session is gone. */
export class PtyRuntime {
  private readonly entries = new Map<string, Entry>();
  private readonly options: PtyRuntimeOptions;
  private closing = false;

  constructor(options: PtyRuntimeOptions) {
    this.options = options;
    // Restarted processes still occupy the shared host budget until explicitly reconciled.
    for (const receipt of options.operations.list('terminal')) {
      if (receipt.state !== 'uncertain') continue;
      const entry = this.entry(receipt.target.sessionId, receipt.operationId);
      entry.reservation = restoreHostProcessGroupReservation();
    }
  }

  async list(sessionId: string): Promise<TerminalList> {
    let target: WorkspaceTarget | null = null;
    let reason: string | null = null;
    try {
      const current = this.options.target(sessionId);
      target = current.target;
      if (!current.writable) reason = 'The working copy is not available for a terminal writer';
    } catch {
      reason = 'The managed working copy is unavailable';
    }
    if (process.platform !== 'linux')
      reason = 'Interactive terminal cleanup is currently qualified on Linux only';
    if (this.closing) reason = 'The host is closing';
    const shells = (await (this.options.shells ?? listShells)()).map(({ id, label }) => ({
      id,
      label,
    }));
    return {
      target,
      available: reason === null,
      reason,
      shells,
      terminals: this.options.operations
        .list('terminal', sessionId)
        .map((receipt) => this.get(sessionId, receipt.operationId)),
    };
  }

  get(sessionId: string, terminalId: string): TerminalView {
    return structuredClone(this.entry(sessionId, terminalId).view);
  }

  async create(sessionId: string, raw: TerminalCreate): Promise<TerminalView> {
    const input = TerminalCreate.parse(raw);
    if (sessionId !== input.target.sessionId)
      throw new ToolRefusal('REVISION_CONFLICT', 'terminal session changed');
    const requestHash = hash(input);
    const prior = this.options.operations.get(input.operationId);
    if (prior) {
      if (prior.kind !== 'terminal' || prior.requestHash !== requestHash)
        throw new ToolRefusal('REVISION_CONFLICT', 'terminal create request changed');
      return this.get(sessionId, input.operationId);
    }
    if (this.closing || process.platform !== 'linux')
      throw new ToolRefusal(
        'CAPABILITY_DENIED',
        'interactive terminal is unavailable on this host',
      );
    const current = this.options.target(sessionId, input.target);
    if (!current.writable)
      throw new ToolRefusal(
        'CAPABILITY_DENIED',
        'the working copy is not available for a terminal writer',
      );
    const view: TerminalView = {
      terminalId: input.operationId,
      target: input.target,
      generation: (this.options.newGeneration ?? (() => `terminal_${randomUUID()}`))(),
      shellId: input.shellId,
      state: 'starting',
      initialCols: input.cols,
      initialRows: input.rows,
      cols: input.cols,
      rows: input.rows,
      lastSequence: 0,
      replayAvailable: true,
      controllerGeneration: 0,
      controller: null,
      exitCode: null,
      error: null,
    };
    this.options.operations.admit(
      { operationId: input.operationId, target: input.target, kind: 'terminal', requestHash },
      current.path,
      { kind: 'terminal', terminal: view },
    );
    const entry = this.newEntry(view);
    this.entries.set(input.operationId, entry);
    try {
      entry.reservation = reserveHostProcessGroup();
    } catch {
      entry.failed = true;
      entry.view.error = 'Host process capacity is full';
      await this.settle(entry);
      return this.get(sessionId, input.operationId);
    }
    void this.launch(entry, input);
    return this.get(sessionId, input.operationId);
  }

  control(sessionId: string, terminalId: string, raw: TerminalControllerChange): TerminalView {
    const input = TerminalControllerChange.parse(raw);
    const entry = this.exact(sessionId, terminalId, input);
    if (entry.view.state !== 'running')
      throw new ToolRefusal('TARGET_TERMINAL', 'terminal is not running');
    const view = entry.view;
    if (input.expectedGeneration !== view.controllerGeneration)
      throw new ToolRefusal('REVISION_CONFLICT', 'terminal controller changed');
    if (input.action === 'release') {
      if (view.controller?.attachmentId !== input.attachmentId)
        throw new ToolRefusal('CAPABILITY_DENIED', 'this attachment does not own the controller');
      view.controller = null;
      view.controllerGeneration += 1;
    } else {
      if (view.controller?.attachmentId === input.attachmentId && !input.takeover)
        return structuredClone(view);
      if (view.controller && !input.takeover)
        throw new ToolRefusal('REVISION_CONFLICT', 'another attachment owns the controller');
      view.controllerGeneration += 1;
      view.controller = {
        attachmentId: input.attachmentId,
        generation: view.controllerGeneration,
        acceptedSequence: 0,
      };
    }
    entry.lastFrameHash = undefined;
    this.emit(entry, { type: 'status', terminal: structuredClone(view) });
    return structuredClone(view);
  }

  input(sessionId: string, terminalId: string, raw: TerminalInput): TerminalAck {
    const input = TerminalInput.parse(raw);
    if (Buffer.byteLength(input.data, 'utf8') > MAX_TERMINAL_INPUT_BYTES)
      throw new ToolRefusal('LIMIT_REACHED', 'terminal input exceeds the byte limit');
    return this.frame(sessionId, terminalId, input, 'input', (entry) =>
      entry.child?.write(input.data),
    );
  }

  resize(sessionId: string, terminalId: string, raw: TerminalResize): TerminalAck {
    const input = TerminalResize.parse(raw);
    return this.frame(sessionId, terminalId, input, 'resize', (entry) => {
      entry.child?.resize(input.cols, input.rows);
      entry.view.cols = input.cols;
      entry.view.rows = input.rows;
      this.event(entry, { type: 'resize', cols: input.cols, rows: input.rows });
    });
  }

  async stop(sessionId: string, terminalId: string, raw: TerminalIdentity): Promise<TerminalView> {
    const entry = this.exact(sessionId, terminalId, TerminalIdentity.parse(raw));
    entry.stopped = true;
    if (!['exited', 'failed'].includes(entry.view.state)) entry.view.stopped = true;
    if (entry.view.state === 'uncertain') {
      if (entry.identity && (await (this.options.cleanup ?? cleanupPtySession)(entry.identity))) {
        entry.reservation?.releaseConfirmed();
        entry.view.state = 'exited';
        entry.view.controller = null;
        entry.view.error = null;
        this.options.operations.reconcileTerminal(terminalId, this.stored(entry));
        this.emit(entry, { type: 'status', terminal: structuredClone(entry.view) });
      } else {
        entry.view.error = entry.identity
          ? 'Terminal process cleanup is still unconfirmed; ownership is retained'
          : 'Terminal process identity is unavailable; ownership cannot be safely released';
        this.emit(entry, { type: 'status', terminal: structuredClone(entry.view) });
      }
    } else if (entry.child) {
      await this.settle(entry);
    } else if (entry.view.state === 'starting' || entry.view.state === 'stopping') {
      entry.view.state = 'stopping';
      this.emit(entry, { type: 'status', terminal: structuredClone(entry.view) });
      await entry.completion;
    }
    return this.get(sessionId, terminalId);
  }

  subscribe(
    sessionId: string,
    terminalId: string,
    cursor: { generation: string; afterSeq: number },
    listener: Listener,
  ) {
    const entry = this.entry(sessionId, terminalId);
    if (
      cursor.generation !== entry.view.generation ||
      !Number.isSafeInteger(cursor.afterSeq) ||
      cursor.afterSeq < 0 ||
      cursor.afterSeq > entry.view.lastSequence
    )
      throw new ToolRefusal('REVISION_CONFLICT', 'terminal replay cursor changed');
    if (!entry.view.replayAvailable && cursor.afterSeq !== entry.view.lastSequence)
      throw new ToolRefusal(
        'REVISION_CONFLICT',
        'terminal replay is unavailable; create a new terminal view',
      );
    if (entry.listeners.size >= 16)
      throw new ToolRefusal('RESOURCE_CAPACITY', 'terminal viewer capacity reached');
    entry.listeners.add(listener);
    return {
      view: structuredClone(entry.view),
      events: entry.events.filter((event) => event.sequence > cursor.afterSeq),
      close: () => entry.listeners.delete(listener),
    };
  }

  async close() {
    this.closing = true;
    await Promise.allSettled(
      [...this.entries.values()].map(async (entry) => {
        if (
          entry.view.state === 'starting' ||
          entry.view.state === 'running' ||
          entry.view.state === 'stopping'
        )
          await this.stop(entry.view.target.sessionId, entry.view.terminalId, {
            target: entry.view.target,
            generation: entry.view.generation,
          });
        entry.cancelRetention?.();
        entry.listeners.clear();
        entry.events = [];
      }),
    );
  }

  private newEntry(view: TerminalView): Entry {
    let resolveCompletion = () => {};
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    return {
      view,
      stopped: false,
      failed: false,
      events: [],
      bytes: 0,
      listeners: new Set(),
      completion,
      resolveCompletion,
    };
  }

  private entry(sessionId: string, terminalId: string): Entry {
    const receipt = this.options.operations.get(terminalId);
    if (receipt?.kind !== 'terminal' || receipt.target.sessionId !== sessionId)
      throw new ToolRefusal('TARGET_NOT_FOUND', 'terminal is unavailable');
    let entry = this.entries.get(terminalId);
    if (!entry) {
      const stored = receipt.result as StoredTerminal;
      entry = this.newEntry({
        ...stored.terminal,
        ...(receipt.state === 'cancelled' ? { stopped: true } : {}),
        replayAvailable: false,
        controller: null,
      });
      entry.identity = stored.identity;
      entry.resolveCompletion();
      this.entries.set(terminalId, entry);
    }
    if (receipt.state === 'uncertain') {
      entry.view.state = 'uncertain';
      entry.view.controller = null;
      entry.view.replayAvailable = false;
      entry.view.error ??= 'The host stopped before terminal cleanup was confirmed';
    }
    return entry;
  }

  private exact(sessionId: string, terminalId: string, input: TerminalIdentity): Entry {
    const entry = this.entry(sessionId, terminalId);
    if (
      input.generation !== entry.view.generation ||
      canonicalJson(input.target) !== canonicalJson(entry.view.target)
    )
      throw new ToolRefusal('REVISION_CONFLICT', 'terminal identity changed');
    return entry;
  }

  private frame(
    sessionId: string,
    terminalId: string,
    input: TerminalInput | TerminalResize,
    kind: string,
    apply: (entry: Entry) => void,
  ): TerminalAck {
    const entry = this.exact(sessionId, terminalId, input);
    const controller = entry.view.controller;
    if (
      entry.view.state !== 'running' ||
      !controller ||
      controller.attachmentId !== input.attachmentId ||
      controller.generation !== input.controllerGeneration
    )
      throw new ToolRefusal('REVISION_CONFLICT', 'terminal controller changed');
    const requestHash = hash({ kind, ...input });
    if (input.sequence === controller.acceptedSequence && entry.lastFrameHash === requestHash)
      return {
        generation: entry.view.generation,
        controllerGeneration: controller.generation,
        acceptedSequence: controller.acceptedSequence,
      };
    if (input.sequence !== controller.acceptedSequence + 1)
      throw new ToolRefusal('REVISION_CONFLICT', 'terminal frame sequence changed');
    try {
      apply(entry);
    } catch {
      entry.view.controller = null;
      entry.view.controllerGeneration += 1;
      entry.view.error = 'Terminal input outcome is unknown; do not resend the previous frame';
      this.emit(entry, { type: 'status', terminal: structuredClone(entry.view) });
      throw new ToolRefusal('REVISION_CONFLICT', 'terminal frame outcome is unknown');
    }
    controller.acceptedSequence = input.sequence;
    entry.lastFrameHash = requestHash;
    return {
      generation: entry.view.generation,
      controllerGeneration: controller.generation,
      acceptedSequence: controller.acceptedSequence,
    };
  }

  private stored(entry: Entry): StoredTerminal {
    return {
      kind: 'terminal',
      terminal: entry.view,
      ...(entry.identity ? { identity: entry.identity } : {}),
    };
  }

  private async launch(entry: Entry, input: TerminalCreate) {
    try {
      const directory = await this.options.prepare(input);
      const shell = (await (this.options.shells ?? listShells)()).find(
        (shell) => shell.id === input.shellId,
      );
      if (!shell || !['bash', 'sh'].includes(shell.id)) throw new Error('shell unavailable');
      const cwd = await realpath(directory);
      if (cwd !== directory) throw new Error('working copy path changed');
      entry.home = await mkdtemp(join(tmpdir(), 'corral-terminal-'));
      const spawn = this.options.spawn ?? (await import('node-pty')).spawn;
      if (entry.stopped) {
        await this.settle(entry);
        return;
      }
      if (!this.options.target(input.target.sessionId, input.target).writable)
        throw new Error('working copy is no longer writable');
      const env = commandEnvironment(entry.home);
      delete env.CI;
      const owner = entry.view.generation;
      env.CORRAL_PROCESS_OWNER = owner;
      env.TERM = 'xterm-256color';
      const args = shell.id === 'bash' ? ['--noprofile', '--norc', '-i'] : ['-i'];
      entry.child = spawn(shell.executable, args, {
        cwd,
        env: env as Record<string, string>,
        cols: input.cols,
        rows: input.rows,
        name: 'xterm-256color',
      });
      entry.identity = (this.options.capture ?? capturePtySession)(entry.child.pid, owner);
      entry.view.state = 'running';
      if (!this.options.operations.updateRunning(input.operationId, this.stored(entry)))
        throw new Error('receipt changed');
      entry.child.onData((data) => this.event(entry, { type: 'output', data }));
      entry.child.onExit(({ exitCode }) => {
        entry.view.exitCode = exitCode;
        void this.settle(entry);
      });
      this.emit(entry, { type: 'status', terminal: structuredClone(entry.view) });
    } catch {
      entry.failed = true;
      entry.view.error = 'Terminal startup failed';
      if (entry.child && !entry.identity) {
        try {
          entry.child.kill();
        } catch {}
      }
      await this.settle(entry);
    }
  }

  private settle(entry: Entry): Promise<void> {
    if (entry.settling) return entry.settling;
    entry.view.state = 'stopping';
    entry.view.controller = null;
    this.emit(entry, { type: 'status', terminal: structuredClone(entry.view) });
    entry.settling = (async () => {
      let confirmed = !entry.child;
      if (entry.identity)
        confirmed = await (this.options.cleanup ?? cleanupPtySession)(entry.identity).catch(
          () => false,
        );
      entry.view.state = !confirmed ? 'uncertain' : entry.failed ? 'failed' : 'exited';
      if (!confirmed) entry.view.error = 'Terminal process cleanup is unconfirmed';
      if (confirmed) {
        entry.reservation?.releaseConfirmed();
        if (entry.home) await rm(entry.home, { recursive: true, force: true }).catch(() => {});
      }
      try {
        const receipt = this.options.operations.finish(
          entry.view.terminalId,
          !confirmed
            ? 'uncertain'
            : entry.failed
              ? 'failed'
              : entry.stopped
                ? 'cancelled'
                : 'succeeded',
          this.stored(entry),
        );
        if (receipt.state === 'uncertain') entry.view.state = 'uncertain';
      } catch {
        entry.view.state = 'uncertain';
        entry.view.error = 'Terminal receipt could not be saved';
      }
      this.emit(entry, { type: 'status', terminal: structuredClone(entry.view) });
      entry.resolveCompletion();
      entry.cancelRetention = (this.options.timers ?? timers).after(5 * 60_000, () => {
        entry.events = [];
        entry.bytes = 0;
        entry.view.replayAvailable = false;
        this.emit(entry, { type: 'status', terminal: structuredClone(entry.view) });
        entry.listeners.clear();
      });
    })();
    return entry.settling;
  }

  private event(
    entry: Entry,
    payload: { type: 'output'; data: string } | { type: 'resize'; cols: number; rows: number },
  ) {
    const event: TerminalEvent = {
      ...payload,
      generation: entry.view.generation,
      sequence: ++entry.view.lastSequence,
    };
    const bytes = 64 + (payload.type === 'output' ? Buffer.byteLength(payload.data, 'utf8') : 32);
    if (entry.view.replayAvailable) {
      entry.bytes += bytes;
      if (entry.bytes > (this.options.historyBytes ?? 4 * 1024 * 1024)) {
        entry.view.replayAvailable = false;
        entry.events = [];
        this.emit(entry, { type: 'status', terminal: structuredClone(entry.view) });
      } else entry.events.push(event);
    }
    this.emit(entry, event);
  }

  private emit(entry: Entry, message: TerminalStreamMessage) {
    for (const listener of entry.listeners) {
      try {
        listener(message);
      } catch {
        entry.listeners.delete(listener);
      }
    }
  }
}
