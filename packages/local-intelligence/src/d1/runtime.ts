// The managed llama-server (features/effort-routing.md#local-엔진-실행과-수명주기): one child per
// server host, started from an argument array on a loopback port the host picked, with a fresh
// key in its environment and never on its command line. It is ready only after it answers its
// health check, refuses a request without the key, and reports the pinned model. Corral ends only
// the child it started; a child that ends on its own leaves an error and is not restarted.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { type D1Endpoint, healthStatus, loadedModel, unauthenticatedStatus } from './client.ts';
import type { D1Manifest } from './manifest.ts';

export type RuntimeState = 'stopped' | 'starting' | 'ready' | 'error';

export interface D1Command {
  file: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
}

export interface D1Child {
  readonly alive: boolean;
  /** Resolves once the process has exited (or never started). */
  readonly exited: Promise<void>;
  signal(kind: 'SIGTERM' | 'SIGKILL'): void;
}

export type D1Launcher = (command: D1Command) => D1Child;

export const spawnD1: D1Launcher = (command) => {
  const child = spawn(command.file, command.args, {
    cwd: command.cwd,
    env: command.env,
    // The server's log names the model path; nothing of it is kept.
    stdio: 'ignore',
  });
  let alive = true;
  const exited = new Promise<void>((resolve) => {
    const done = () => {
      alive = false;
      resolve();
    };
    child.once('exit', done);
    child.once('error', done);
  });
  return {
    get alive() {
      return alive;
    },
    exited,
    signal: (kind) => {
      if (alive) child.kill(kind);
    },
  };
};

export interface D1Limits {
  startupMs: number;
  idleMs: number;
  /** From the start of one inference until its child is ended. */
  watchdogMs: number;
  /** Between asking a child to end and killing it. */
  graceMs: number;
  pollMs: number;
}

export const D1_LIMITS: D1Limits = {
  startupMs: 30_000,
  idleMs: 5 * 60_000,
  watchdogMs: 120_000,
  graceMs: 2_000,
  pollMs: 100,
};

export interface D1Instance {
  /** Unique per child: an answer belongs to the instance that gave it. */
  id: string;
  endpoint: D1Endpoint;
  threads: number;
  child: D1Child;
}

/** The CPU profile, with the host's port and thread count. */
export function serverArgs(model: string, port: number, threads: number): string[] {
  return [
    '--model',
    model,
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--ctx-size',
    '1024',
    '--batch-size',
    '1024',
    '--ubatch-size',
    '1024',
    '--parallel',
    '1',
    '--threads',
    String(threads),
    '--threads-batch',
    String(threads),
    '--n-gpu-layers',
    '0',
    '--device',
    'none',
    '--no-op-offload',
    '--no-warmup',
    '--offline',
    '--cache-ram',
    '0',
    '--no-ui',
  ];
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
    });
  });
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

export interface D1RuntimeOptions {
  dir: string;
  manifest: D1Manifest;
  launch?: D1Launcher;
  limits?: Partial<D1Limits>;
}

export class D1Runtime {
  state: RuntimeState = 'stopped';
  error: string | null = null;
  readonly limits: D1Limits;
  private current: D1Instance | null = null;
  private starting: { threads: number; done: Promise<void> } | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private holds = 0;
  private serial = 0;
  private readonly options: D1RuntimeOptions;

  constructor(options: D1RuntimeOptions) {
    this.options = options;
    this.limits = { ...D1_LIMITS, ...options.limits };
  }

  /** The ready instance for these threads, or null. */
  ready(threads: number): D1Instance | null {
    const instance = this.current;
    return this.state === 'ready' && instance?.threads === threads ? instance : null;
  }

  get active(): D1Instance | null {
    return this.state === 'ready' ? this.current : null;
  }

  /**
   * Starts an instance with these threads unless one is ready or starting with them. A
   * different thread count ends the old child first and starts after it has exited.
   */
  prepare(threads: number): Promise<void> {
    if (this.ready(threads)) return Promise.resolve();
    if (this.starting?.threads === threads) return this.starting.done;
    const done = (async () => {
      await this.stop();
      await this.launch(threads);
    })().finally(() => {
      if (this.starting?.done === done) this.starting = null;
    });
    this.starting = { threads, done };
    // Starting covers the wait for an old child's exit, so a reply sent now already says so.
    this.state = 'starting';
    this.error = null;
    return done;
  }

  /** Ends the owned child, if any, and waits for its exit. */
  async stop(): Promise<void> {
    this.clearIdle();
    const instance = this.current;
    this.current = null;
    this.state = 'stopped';
    this.error = null;
    if (instance) await this.terminate(instance);
  }

  /** Ends an instance whose work cannot be trusted any more; it stays an error until prepared. */
  async isolate(instance: D1Instance, why: string): Promise<void> {
    if (this.current === instance) {
      this.current = null;
      this.clearIdle();
      this.state = 'error';
      this.error = why;
    }
    await this.terminate(instance);
  }

  /** A judgment holds the instance: no idle unload until every hold ends. */
  hold(): void {
    this.holds++;
    this.clearIdle();
  }

  release(): void {
    this.holds = Math.max(0, this.holds - 1);
    this.armIdle();
  }

  private clearIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private armIdle() {
    this.clearIdle();
    if (this.holds > 0 || this.state !== 'ready') return;
    const instance = this.current;
    this.idleTimer = setTimeout(() => {
      if (this.current === instance && this.holds === 0) void this.stop();
    }, this.limits.idleMs);
    this.idleTimer.unref?.();
  }

  private async terminate(instance: D1Instance): Promise<void> {
    if (!instance.child.alive) return;
    instance.child.signal('SIGTERM');
    const kill = setTimeout(() => instance.child.signal('SIGKILL'), this.limits.graceMs);
    await instance.child.exited;
    clearTimeout(kill);
  }

  private async launch(threads: number): Promise<void> {
    const { dir, manifest } = this.options;
    const launch = this.options.launch ?? spawnD1;
    this.state = 'starting';
    this.error = null;
    let instance: D1Instance;
    try {
      const port = await freePort();
      const key = randomBytes(32).toString('hex');
      instance = {
        id: String(++this.serial),
        endpoint: { base: `http://127.0.0.1:${port}`, key },
        threads,
        child: launch({
          file: join(dir, manifest.runtime.server),
          args: serverArgs(join(dir, manifest.model.file), port, threads),
          // Only what the server needs: its key and the libraries next to it.
          env: { LLAMA_API_KEY: key, LD_LIBRARY_PATH: dir },
          cwd: dir,
        }),
      };
    } catch {
      this.state = 'error';
      this.error = 'the Local runtime could not start';
      return;
    }
    this.current = instance;
    void instance.child.exited.then(() => {
      if (this.current !== instance) return;
      this.current = null;
      this.clearIdle();
      this.error =
        this.state === 'starting'
          ? 'the Local runtime exited while starting'
          : 'the Local runtime stopped unexpectedly';
      this.state = 'error';
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.limits.startupMs);
    const { signal } = controller;
    try {
      const { base } = instance.endpoint;
      for (;;) {
        if (!instance.child.alive || this.current !== instance)
          throw new Error('the Local runtime exited while starting');
        if (signal.aborted) throw new Error('the Local runtime did not start in time');
        const status = await healthStatus(base, signal).catch(() => 0);
        if (status === 200) break;
        await sleep(this.limits.pollMs, signal);
      }
      // A build that answers without its key would serve anyone on this machine.
      if ((await unauthenticatedStatus(base, signal)) !== 401)
        throw new Error('the Local runtime does not require its key');
      const model = await loadedModel(instance.endpoint, signal);
      if (
        !model.decisions ||
        model.size !== manifest.model.tensorBytes ||
        model.params !== manifest.model.params
      )
        throw new Error('the Local runtime loaded a different model');
    } catch (error) {
      const message =
        signal.aborted && this.current === instance
          ? 'the Local runtime did not start in time'
          : error instanceof Error && error.message.startsWith('the Local runtime')
            ? error.message
            : 'the Local runtime did not start';
      if (this.current === instance) await this.isolate(instance, message);
      else await this.terminate(instance);
      return;
    } finally {
      clearTimeout(timer);
    }
    if (this.current !== instance) return;
    this.state = 'ready';
    this.armIdle();
  }
}
