import type { ChildProcess, spawn } from 'node:child_process';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Clock, Scheduler } from '@corral/contracts';
import { type ToolCancellation, ToolRefusal, ToolTerminationUnconfirmed } from '@corral/core';
import {
  confirmOwnedProcessCleanup,
  HostProcessCapacityError,
  spawnOwnedProcess,
} from '../processes/owned-process.ts';
import {
  capturePtySession,
  cleanupPtySession,
  type PtySessionIdentity,
} from '../processes/pty-session.ts';
import { killProcessGroup, processGroupGone } from './process-group.ts';

const MAX_MESSAGE = 4 * 1024 * 1024;
const failure = (message: string) => new ToolRefusal('CAPABILITY_DENIED', message);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

export interface DebugSession {
  id: string;
  parentId: string | null;
  capabilities: Record<string, unknown>;
}
export interface DebugConnectionOptions {
  cwd: string;
  argv: string[];
  owner: string;
  clock: Clock;
  timers: Scheduler;
  timeoutMs?: number;
  onSpawn(identity: PtySessionIdentity): void | Promise<void>;
  onEvent(event: string, body: unknown, connectionId: string): void;
  onReady?(connectionId: string): Promise<void>;
  onFailure(error: Error): void;
  spawn?: (...args: Parameters<typeof spawn>) => ChildProcess;
}
interface Pending {
  command: string;
  finish(error: Error | undefined, body?: unknown): void;
}
interface Channel extends DebugSession {
  socket: Socket;
  seq: number;
  initialized: ReturnType<typeof deferred<void>>;
  pending: Map<number, Pending>;
  targetId?: string;
  terminated?: boolean;
}

/** Protocol and adapter ownership only; the broker owns debuggee trust, identity and commands. */
export class DebugConnection {
  private readonly channels = new Map<string, Channel>();
  private readonly targets = new Set<string>();
  private readonly firstTarget = deferred<void>();
  private child?: ChildProcess;
  private identity?: PtySessionIdentity;
  private exited = Promise.resolve();
  private closing?: Promise<void>;
  private failed?: Error;
  private stopping = false;
  private signalled = false;
  private expectedType?: string;
  private nextChannel = 0;
  private readonly timeoutMs: number;
  private readonly options: DebugConnectionOptions;
  private readonly home: string;

  private constructor(options: DebugConnectionOptions, home: string) {
    this.options = options;
    this.home = home;
    this.timeoutMs = options.timeoutMs ?? 10000;
  }

  get capabilities(): Record<string, unknown> {
    return this.channels.get('root')?.capabilities ?? {};
  }
  get sessions(): ReadonlyMap<string, DebugSession> {
    return this.channels;
  }

  static async start(options: DebugConnectionOptions): Promise<DebugConnection> {
    if (process.platform !== 'linux')
      throw failure('debug adapter process ownership is unavailable on this host');
    const timeout = options.timeoutMs ?? 10000;
    if (
      !options.owner ||
      !options.argv.length ||
      options.argv.some((arg) => !arg || arg.includes('\0')) ||
      !Number.isInteger(timeout) ||
      timeout < 1 ||
      timeout > 1800000
    )
      throw failure('debug adapter launch is invalid');
    const connection = new DebugConnection(options, await mkdtemp(join(tmpdir(), 'corral-debug-')));
    try {
      await chmod(connection.home, 0o700);
      await connection.startAdapter();
      await connection.openChannel('root', null);
      return connection;
    } catch (error) {
      const reason =
        error instanceof ToolRefusal ? error : failure('debug adapter could not start');
      connection.fail(reason);
      await connection.close();
      throw reason;
    }
  }

  private assertOpen() {
    if (this.failed) throw this.failed;
    if (this.stopping) throw failure('debug adapter is closed');
  }

  private fail(error: Error) {
    if (this.failed || this.stopping) return;
    this.failed = error;
    this.firstTarget.reject(error);
    for (const channel of this.channels.values()) {
      channel.initialized.reject(error);
      for (const pending of channel.pending.values()) pending.finish(error);
    }
    try {
      this.options.onFailure(error);
    } catch {}
    void this.close().catch(() => {});
  }

  private async startAdapter() {
    try {
      this.child = (this.options.spawn ?? (spawnOwnedProcess as typeof spawn))(
        this.options.argv[0] as string,
        [...this.options.argv.slice(1), join(this.home, 'dap.sock')],
        {
          cwd: this.options.cwd,
          shell: false,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            PATH: process.env.PATH ?? '/usr/bin:/bin',
            HOME: this.home,
            TMPDIR: this.home,
            XDG_CONFIG_HOME: this.home,
            LANG: 'C.UTF-8',
            CORRAL_PROCESS_OWNER: this.options.owner,
          },
        },
      );
    } catch (error) {
      throw failure(
        error instanceof HostProcessCapacityError ? error.message : 'debug adapter could not start',
      );
    }
    const child = this.child;
    this.exited = new Promise((resolve) =>
      child.once('close', () => {
        this.fail(failure('debug adapter closed'));
        resolve();
      }),
    );
    child.once('error', () => this.fail(failure('debug adapter could not start')));
    child.once('exit', () => this.fail(failure('debug adapter closed')));
    child.stdout?.on('data', () => {});
    child.stderr?.on('data', () => {});
    if (!child.pid) throw failure('debug adapter process identity is unavailable');
    this.identity = capturePtySession(child.pid, this.options.owner);
    await this.options.onSpawn(this.identity);
    this.assertOpen();
  }

  private async connect(): Promise<Socket> {
    const deadline = this.options.clock.monotonicMs() + this.timeoutMs;
    while (true) {
      this.assertOpen();
      const socket = createConnection(join(this.home, 'dap.sock'));
      try {
        await this.deadline(
          new Promise<void>((resolve, reject) => {
            socket.once('connect', resolve);
            socket.once('error', reject);
          }),
          Math.max(1, deadline - this.options.clock.monotonicMs()),
        );
        this.assertOpen();
        return socket;
      } catch (error) {
        socket.destroy();
        if (
          !['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '') ||
          this.options.clock.monotonicMs() >= deadline
        )
          throw failure('debug adapter connection timeout');
        await new Promise<void>((resolve) => this.options.timers.after(20, resolve));
      }
    }
  }

  private async openChannel(id: string, parentId: string | null): Promise<Channel> {
    const socket = await this.connect();
    try {
      this.assertOpen();
    } catch (error) {
      socket.destroy();
      throw error;
    }
    const channel: Channel = {
      id,
      parentId,
      socket,
      seq: 0,
      capabilities: {},
      initialized: deferred<void>(),
      pending: new Map(),
    };
    this.channels.set(id, channel);
    this.read(channel);
    socket.on('error', () => this.fail(failure('debug adapter connection failed')));
    socket.on('close', () => {
      const reason = failure('debug adapter connection closed');
      for (const pending of channel.pending.values()) pending.finish(reason);
      channel.initialized.reject(reason);
      if (!this.stopping && !channel.terminated) this.fail(reason);
    });
    const capabilities = await this.send(channel, 'initialize', {
      clientID: 'corral',
      adapterID: 'corral-js-debug',
      pathFormat: 'path',
      linesStartAt1: true,
      columnsStartAt1: true,
      supportsVariableType: true,
      supportsVariablePaging: true,
      supportsRunInTerminalRequest: false,
      supportsStartDebuggingRequest: true,
    });
    if (!record(capabilities)) throw failure('debug adapter capabilities are invalid');
    if (capabilities.supportsConfigurationDoneRequest !== true)
      throw failure('debug adapter configuration handshake is unsupported');
    channel.capabilities = capabilities;
    await this.deadline(channel.initialized.promise, this.timeoutMs);
    return channel;
  }

  private read(channel: Channel) {
    const header = Buffer.alloc(8192);
    let used = 0,
      body: Buffer | undefined,
      offset = 0;
    channel.socket.on('data', (chunk: Buffer) => {
      try {
        let at = 0;
        while (at < chunk.length && !this.failed) {
          if (!body) {
            if (used === header.length) throw failure('debug adapter header limit exceeded');
            header[used++] = chunk[at++] as number;
            if (used < 4 || header.readUInt32BE(used - 4) !== 0x0d0a0d0a) continue;
            const lengths = header
              .subarray(0, used)
              .toString('ascii')
              .split('\r\n')
              .filter((line) => /^content-length:/i.test(line));
            if (
              lengths.length !== 1 ||
              !/^content-length:[ \t]*[1-9]\d*[ \t]*$/i.test(lengths[0] ?? '')
            )
              throw failure('debug adapter framing is invalid');
            const length = Number(lengths[0]?.split(':')[1]?.trim());
            if (!Number.isSafeInteger(length) || length > MAX_MESSAGE)
              throw failure('debug adapter message limit exceeded');
            body = Buffer.alloc(length);
            used = 0;
            offset = 0;
          }
          const count = Math.min(body.length - offset, chunk.length - at);
          chunk.copy(body, offset, at, at + count);
          offset += count;
          at += count;
          if (offset === body.length) {
            const value: unknown = JSON.parse(body.toString('utf8'));
            body = undefined;
            this.receive(channel, value);
          }
        }
      } catch (error) {
        this.fail(
          error instanceof ToolRefusal ? error : failure('debug adapter protocol is invalid'),
        );
      }
    });
  }

  private receive(channel: Channel, message: unknown) {
    if (!record(message) || !positive(message.seq))
      throw failure('debug adapter message is invalid');
    if (message.type === 'response') {
      if (!positive(message.request_seq) || typeof message.success !== 'boolean')
        throw failure('debug adapter response is invalid');
      const pending = channel.pending.get(message.request_seq);
      if (!pending) return;
      if (pending.command !== message.command)
        throw failure('debug adapter response command is invalid');
      pending.finish(
        message.success ? undefined : failure('debug adapter request failed'),
        message.body,
      );
    } else if (message.type === 'event') {
      if (
        typeof message.event !== 'string' ||
        message.event.length > 128 ||
        (message.body !== undefined && !record(message.body))
      )
        throw failure('debug adapter event is invalid');
      if (message.event === 'initialized') channel.initialized.resolve();
      if (message.event === 'terminated') channel.terminated = true;
      if (!this.stopping) this.options.onEvent(message.event, message.body, channel.id);
      if (message.event === 'terminated' && channel.id !== 'root' && !this.stopping)
        void this.retire(channel);
    } else if (message.type === 'request') {
      void this.reverse(channel, message).catch((error) =>
        this.fail(
          error instanceof ToolRefusal ? error : failure('debug adapter reverse request failed'),
        ),
      );
    } else throw failure('debug adapter message type is invalid');
  }

  private write(channel: Channel, message: Record<string, unknown>) {
    const body = Buffer.from(JSON.stringify({ seq: ++channel.seq, ...message }));
    if (body.length > MAX_MESSAGE || channel.socket.writableLength > MAX_MESSAGE)
      throw failure('debug adapter output limit exceeded');
    if (channel.socket.destroyed) throw failure('debug adapter connection closed');
    channel.socket.write(`Content-Length: ${body.length}\r\n\r\n`);
    channel.socket.write(body);
  }

  private async retire(channel: Channel) {
    await this.deadline(this.send(channel, 'disconnect', { terminateDebuggee: false }), 300).catch(
      () => {},
    );
    channel.socket.destroy();
    this.channels.delete(channel.id);
    if (channel.targetId) this.targets.delete(channel.targetId);
  }

  private async reverse(parent: Channel, message: Record<string, unknown>) {
    const args = message.arguments;
    const config = record(args) ? args.configuration : undefined;
    if (
      this.stopping ||
      !this.expectedType ||
      message.command !== 'startDebugging' ||
      !record(args) ||
      args.request !== 'attach' ||
      !record(config) ||
      config.type !== this.expectedType ||
      typeof config.__pendingTargetId !== 'string' ||
      !config.__pendingTargetId ||
      config.__pendingTargetId.length > 1000 ||
      (config.name !== undefined &&
        (typeof config.name !== 'string' || config.name.length > 2000)) ||
      Object.keys(config).some((key) => !['type', 'name', '__pendingTargetId'].includes(key)) ||
      this.targets.has(config.__pendingTargetId) ||
      this.targets.size >= 4
    ) {
      this.write(parent, {
        type: 'response',
        request_seq: message.seq,
        command: message.command,
        success: false,
        message: 'Unsupported reverse request',
      });
      throw failure('debug adapter reverse request refused');
    }
    this.targets.add(config.__pendingTargetId);
    const channel = await this.openChannel(`child-${++this.nextChannel}`, parent.id);
    channel.targetId = config.__pendingTargetId;
    await this.options.onReady?.(channel.id);
    this.assertOpen();
    await this.send(channel, 'configurationDone', {});
    this.assertOpen();
    await this.send(channel, 'attach', { ...config, request: 'attach' });
    this.assertOpen();
    this.write(parent, {
      type: 'response',
      request_seq: message.seq,
      command: message.command,
      success: true,
    });
    this.firstTarget.resolve();
  }

  async attach(config: Record<string, unknown>, cancellation?: ToolCancellation): Promise<void> {
    this.assertOpen();
    if (
      this.expectedType ||
      config.request !== 'attach' ||
      !['pwa-node', 'pwa-chrome'].includes(String(config.type))
    )
      throw failure('debug adapter attach configuration is invalid');
    if (cancellation?.aborted) throw failure('debug adapter attach cancelled');
    this.expectedType = String(config.type);
    const off = cancellation?.onCancel(() => this.fail(failure('debug adapter attach cancelled')));
    try {
      if (cancellation?.aborted) this.fail(failure('debug adapter attach cancelled'));
      await this.request('root', 'configurationDone', {}, cancellation);
      await this.request('root', 'attach', config, cancellation);
      await this.deadline(this.firstTarget.promise, this.timeoutMs);
    } catch (error) {
      this.fail(error instanceof Error ? error : failure('debug adapter attach failed'));
      throw error;
    } finally {
      off?.();
    }
  }

  request(
    connectionId: string | undefined,
    command: string,
    args?: unknown,
    cancellation?: ToolCancellation,
  ): Promise<unknown> {
    this.assertOpen();
    const channel = this.channels.get(connectionId ?? 'root');
    if (!channel) return Promise.reject(failure('debug adapter session is unavailable'));
    return this.send(channel, command, args, cancellation);
  }

  private send(
    channel: Channel,
    command: string,
    args?: unknown,
    cancellation?: ToolCancellation,
  ): Promise<unknown> {
    if (cancellation?.aborted) return Promise.reject(failure('debug adapter request cancelled'));
    if (channel.pending.size >= 64)
      return Promise.reject(failure('debug adapter request limit exceeded'));
    const seq = channel.seq + 1;
    return new Promise((resolve, reject) => {
      let cancelTimer = () => {},
        off = () => {};
      const finish = (error: Error | undefined, body?: unknown) => {
        if (!channel.pending.delete(seq)) return;
        cancelTimer();
        off();
        if (error) reject(error);
        else resolve(body);
      };
      channel.pending.set(seq, { command, finish });
      const interrupt = (message: string) => {
        finish(failure(message));
        if (channel.capabilities.supportsCancelRequest === true && !channel.socket.destroyed) {
          try {
            this.write(channel, {
              type: 'request',
              command: 'cancel',
              arguments: { requestId: seq },
            });
          } catch {}
        }
      };
      cancelTimer = this.options.timers.after(this.timeoutMs, () =>
        interrupt('debug adapter request timeout'),
      );
      off = cancellation?.onCancel(() => interrupt('debug adapter request cancelled')) ?? off;
      try {
        if (cancellation?.aborted) interrupt('debug adapter request cancelled');
        else
          this.write(channel, {
            type: 'request',
            command,
            ...(args === undefined ? {} : { arguments: args }),
          });
      } catch (error) {
        finish(error instanceof Error ? error : failure('debug adapter request failed'));
      }
    });
  }

  private deadline<T>(promise: Promise<T>, ms: number): Promise<T> {
    let cancel = () => {};
    return Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        cancel = this.options.timers.after(ms, () =>
          reject(failure('debug adapter operation timeout')),
        );
      }),
    ]).finally(() => cancel());
  }

  close(): Promise<void> {
    this.stopping = true;
    this.closing ??= this.cleanup().catch((error) => {
      this.closing = undefined;
      throw error;
    });
    return this.closing;
  }

  private async cleanup() {
    const closed = failure('debug adapter is closed');
    this.firstTarget.reject(closed);
    for (const channel of this.channels.values()) {
      channel.initialized.reject(closed);
      for (const pending of channel.pending.values()) pending.finish(closed);
    }
    await Promise.all(
      [...this.channels.values()].reverse().map(async (channel) => {
        if (!channel.socket.destroyed)
          await this.deadline(
            this.send(channel, 'disconnect', { terminateDebuggee: false }),
            300,
          ).catch(() => {});
        channel.socket.destroy();
      }),
    );
    if (this.child && !this.identity && !this.signalled) {
      this.signalled = true;
      killProcessGroup(this.child);
    }
    const gone = this.identity
      ? await cleanupPtySession(this.identity, this.options.timers)
      : !this.child?.pid || (await processGroupGone(this.child.pid, this.options.timers));
    const exited = await this.deadline(this.exited, 8000).then(
      () => true,
      () => false,
    );
    if (!gone || !exited)
      throw new ToolTerminationUnconfirmed('debug adapter termination unconfirmed');
    if (this.child?.pid) confirmOwnedProcessCleanup(this.child.pid);
    this.channels.clear();
    await rm(this.home, { recursive: true, force: true }).catch(() => {
      throw failure('debug adapter configuration cleanup failed');
    });
  }
}
