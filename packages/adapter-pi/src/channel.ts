import { type ChildProcess, type ForkOptions, fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordWorkerLease, recoverSdkWorkers } from './worker-leases.ts';

// The transport between host and one worker (ADR-017: one child process per execution,
// spawned when needed). The protocol does not depend on it, so tests use a memory pair and
// the server uses a child process.

export interface Channel {
  send(frame: unknown): void;
  onFrame(handler: (frame: unknown) => void): void;
  /** Called once when the worker is gone; `code` is null when it was killed by a signal. */
  onExit(handler: (code: number | null, cleanupConfirmed?: boolean) => void): void;
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
export function processChannel(
  entry: string,
  options: {
    env?: NodeJS.ProcessEnv;
    leaseDirectory?: string;
    childLeaseDirectory?: string;
    launch?: Pick<ForkOptions, 'execPath' | 'execArgv'>;
  } = {},
): Channel {
  const processOwner = randomUUID();
  const child: ChildProcess = fork(entry, [], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    serialization: 'json',
    detached: process.platform !== 'win32',
    // Parent eval/debug/preload flags do not describe the standalone worker entry.
    execArgv: [],
    ...options.launch,
    // The worker needs no secrets from the environment: credentials arrive per request.
    env: {
      NODE_ENV: process.env.NODE_ENV ?? 'production',
      PATH: process.env.PATH ?? '',
      ...(process.platform === 'win32' ? {} : { CORRAL_WORKER_GROUP: '1' }),
      ...options.env,
      CORRAL_PROCESS_OWNER: processOwner,
    },
  });
  child.stderr?.on('data', () => {});
  let exited = false;
  let releaseLease = () => {};
  const exitHandlers: ((code: number | null, cleanupConfirmed?: boolean) => void)[] = [];
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
    const confirmed = (cleanupConfirmed = true) => {
      try {
        if (cleanupConfirmed) releaseLease();
      } catch {
        /* Remaining records are rechecked at startup. */
      }
      for (const handler of exitHandlers) handler(code, cleanupConfirmed);
    };
    if (options.childLeaseDirectory) {
      void recoverSdkWorkers(options.childLeaseDirectory)
        .then(() => {
          rmSync(options.childLeaseDirectory!, { recursive: true, force: true });
          confirmed();
        })
        .catch(() => {
          confirmed(false);
        });
    } else confirmed();
  };
  child.on('exit', ended);
  child.on('error', () => {
    if (!child.pid) ended(null);
    else {
      stopChildren();
      child.kill('SIGKILL');
    }
  });
  if (options.leaseDirectory && child.pid) {
    try {
      releaseLease = recordWorkerLease(options.leaseDirectory, child.pid, processOwner);
    } catch (error) {
      stopChildren();
      child.kill('SIGKILL');
      throw error;
    }
  }
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
export function sdkProcessChannel(
  entry: string,
  options: { leaseDirectory?: string } = {},
): Channel {
  const directory = mkdtempSync(join(tmpdir(), 'corral-sdk-'));
  const childLeaseDirectory = join(options.leaseDirectory ?? directory, `children-${randomUUID()}`);
  try {
    const channel = processChannel(entry, {
      ...options,
      childLeaseDirectory,
      env: {
        CORRAL_WORKER_DIR: directory,
        CORRAL_WORKER_LEASE_DIR: childLeaseDirectory,
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
    channel.onExit((_code, confirmed) => {
      if (confirmed !== false) rmSync(directory, { recursive: true, force: true });
    });
    return channel;
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
