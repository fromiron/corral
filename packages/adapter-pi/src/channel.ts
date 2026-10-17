import { type ChildProcess, fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The transport between host and one worker (ADR-017: one child process per execution,
// spawned when needed). The protocol does not depend on it, so tests use a memory pair and
// the server uses a child process.

export interface Channel {
  send(frame: unknown): void;
  onFrame(handler: (frame: unknown) => void): void;
  /** Called once when the worker is gone; `code` is null when it was killed by a signal. */
  onExit(handler: (code: number | null) => void): void;
  kill(): void;
}

/** Two connected ends in one process: `host` for the adapter, `worker` for `runWorker`. */
export function memoryChannelPair(): { host: Channel; worker: Channel } {
  const handlers = { host: [] as ((f: unknown) => void)[], worker: [] as ((f: unknown) => void)[] };
  const exits: ((code: number | null) => void)[] = [];
  let alive = true;
  // Frames cross as JSON, as they would over IPC, and asynchronously.
  const deliver = (to: 'host' | 'worker', frame: unknown) => {
    if (!alive) return;
    const copy = JSON.parse(JSON.stringify(frame)) as unknown;
    void Promise.resolve().then(() => {
      if (alive) for (const handler of handlers[to]) handler(copy);
    });
  };
  const end = (code: number | null) => {
    if (!alive) return;
    alive = false;
    void Promise.resolve().then(() => {
      for (const exit of exits) exit(code);
    });
  };
  return {
    host: {
      send: (frame) => deliver('worker', frame),
      onFrame: (handler) => void handlers.host.push(handler),
      onExit: (handler) => void exits.push(handler),
      kill: () => end(null),
    },
    worker: {
      send: (frame) => deliver('host', frame),
      onFrame: (handler) => void handlers.worker.push(handler),
      onExit: () => {},
      /** The worker process ending by itself, after what it already sent. */
      kill: () => void Promise.resolve().then(() => end(0)),
    },
  };
}

/**
 * A worker in its own Node process over the IPC channel. stdout is ignored and stderr is
 * kept only as a short diagnostic tail, never parsed as protocol (Technical-Design §7.4).
 */
export function processChannel(entry: string, options: { env?: NodeJS.ProcessEnv } = {}): Channel {
  const child: ChildProcess = fork(entry, [], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    serialization: 'json',
    detached: process.platform !== 'win32',
    // Parent eval/debug/preload flags do not describe the standalone worker entry.
    execArgv: [],
    // The worker needs no secrets from the environment: credentials arrive per request.
    env: {
      NODE_ENV: process.env.NODE_ENV ?? 'production',
      PATH: process.env.PATH ?? '',
      ...(process.platform === 'win32' ? {} : { CORRAL_WORKER_GROUP: '1' }),
      ...options.env,
    },
  });
  child.stderr?.on('data', () => {});
  let exited = false;
  const exitHandlers: ((code: number | null) => void)[] = [];
  const stopChildren = () => {
    if (process.platform !== 'win32' && child.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* The group is already gone. */
      }
    }
  };
  const ended = (code: number | null) => {
    if (exited) return;
    stopChildren();
    exited = true;
    for (const handler of exitHandlers) handler(code);
  };
  child.on('exit', ended);
  child.on('error', () => ended(null));
  return {
    send: (frame) => {
      if (!exited && child.connected) child.send(frame as never, () => {});
    },
    onFrame: (handler) => void child.on('message', handler),
    onExit: (handler) => void exitHandlers.push(handler),
    kill: () => {
      if (!exited) {
        stopChildren();
        child.kill('SIGKILL');
      }
    },
  };
}

/** Compatibility isolation for trusted native extensions; this is not an OS sandbox. */
export function sdkProcessChannel(entry: string): Channel {
  const directory = mkdtempSync(join(tmpdir(), 'corral-sdk-'));
  try {
    const channel = processChannel(entry, {
      env: {
        CORRAL_WORKER_DIR: directory,
        HOME: directory,
        XDG_CONFIG_HOME: join(directory, 'config'),
        CLAUDE_CONFIG_DIR: join(directory, 'claude'),
        JITI_FS_CACHE: join(directory, 'jiti'),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
        NPM_CONFIG_USERCONFIG: join(directory, 'user.npmrc'),
        NPM_CONFIG_GLOBALCONFIG: join(directory, 'global.npmrc'),
      },
    });
    channel.onExit(() => rmSync(directory, { recursive: true, force: true }));
    return channel;
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
