// The Local effort routing engine (features/effort-routing.md): the d1 install, the managed
// runtime and the routing port on top. One judgment at a time per host and no queue: Busy is
// known before any tokenizer call. A judgment's slot is held until its native response is read
// to the end or its child has exited, whatever the caller did meanwhile.
import { rmSync, statSync } from 'node:fs';
import { availableParallelism, hostname } from 'node:os';
import { join } from 'node:path';
import type {
  DecisionCancellation,
  RouterRequest,
  RouterResponse,
  RoutingBackend,
  RoutingEngine,
  RoutingFallbackReason,
  RoutingFlight,
  RoutingLease,
  SettledBasis,
} from '@corral/contracts';
import { BundleBusyError } from '../busy.ts';
import { d1Threads } from '../platform.ts';
import { D1HttpError, systemOne, tokenize } from './client.ts';
import {
  type D1InstallProgress,
  d1Dir,
  d1Installed,
  installD1,
  type VersionProbe,
} from './install.ts';
import {
  type D1Device,
  type D1Manifest,
  d1Devices,
  d1Runtime,
  manifestProblem,
} from './manifest.ts';
import { d1Break, renderChoice } from './render.ts';
import { type D1Instance, type D1Launcher, type D1Limits, D1Runtime } from './runtime.ts';

export type D1InstallState = 'absent' | 'downloading' | 'verifying' | 'installed' | 'install-error';
export type D1RuntimeView =
  | 'stopped'
  | 'starting'
  | 'ready'
  | 'packing'
  | 'inferring'
  | 'draining'
  | 'error';

export interface D1Status {
  model: string | null;
  /** The computer that runs the engine: the Corral server's, never the browser's. */
  host: string;
  supported: boolean;
  /** Why the engine cannot be used here, when it cannot. */
  reason: string | null;
  install: D1InstallState;
  runtime: D1RuntimeView;
  downloadBytes: number | null;
  /** Model plus every installed device runtime, or null when nothing is installed. */
  installedBytes: number | null;
  progress: { received: number; total: number } | null;
  error: string | null;
  device: { requested: D1Device; active: string | null };
  devices: {
    kind: D1Device;
    installed: boolean;
    downloadBytes: number;
    requirement: string | null;
  }[];
  threads: number | null;
  /** The CPU threads a new Local setting starts with, from the server's processor. */
  defaultThreads: number;
}

export interface D1EngineOptions {
  /** Where d1 installs, apart from the meeting bundle. */
  root: string;
  /** Null when Corral ships no Local engine for this machine. */
  manifest: D1Manifest | null;
  launch?: D1Launcher;
  limits?: Partial<D1Limits>;
  fetchFn?: typeof fetch;
  probe?: VersionProbe;
  /** Text of `llama-server --list-devices` for a GPU runtime. */
  listDevices?(server: string, dir: string, signal?: AbortSignal): Promise<string>;
  freeBytes?(dir: string): Promise<number | null>;
  host?: string;
  /** Logical processors on the host; the default thread count follows from them. */
  cores?: number;
  monotonicMs?(): number;
  /**
   * Awaited after the files are on disk and this install is no longer in progress, before it is
   * accepted. A removal in that gap discards the install, including files the callback writes.
   */
  beforeAccept?(): Promise<void>;
  /** Called once an install is accepted. */
  onInstalled?(): void;
}

type LocalEngine = Extract<RoutingEngine, { kind: 'local' }>;

const failure = (reason: RoutingFallbackReason, message: string) =>
  Object.assign(new Error(message), { reason });

/** A count's signal as an AbortSignal: a deadline or cancellation also ends a stalled body. */
function aborting(signal: DecisionCancellation): { signal: AbortSignal; off(): void } {
  const controller = new AbortController();
  const off = signal.onCancel(() => controller.abort());
  if (signal.aborted) controller.abort();
  return { signal: controller.signal, off };
}

/** A filesystem failure carries a local path; only its code is shown. */
function describe(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'ENOSPC') return 'not enough disk space for the Local model';
  if (typeof code === 'string' && /^E[A-Z]+$/.test(code))
    return `cannot write the Local model files (${code})`;
  return error instanceof Error ? error.message : String(error);
}

interface Lease {
  instance: D1Instance;
  flight: { request: RouterRequest } | null;
}

const exitListeners = new WeakMap<D1Instance, Set<() => void>>();

/** Runs `fn` when the instance's child exits (at once if it has); returns the unsubscribe. */
function onExit(instance: D1Instance, fn: () => void): () => void {
  let listeners = exitListeners.get(instance);
  if (!listeners) {
    const created = new Set<() => void>();
    listeners = created;
    exitListeners.set(instance, created);
    void instance.child.exited.then(() => {
      for (const listener of [...created]) listener();
      created.clear();
    });
  }
  if (!instance.child.alive) {
    queueMicrotask(fn);
    return () => {};
  }
  listeners.add(fn);
  const own = listeners;
  return () => own.delete(fn);
}

export class D1Engine {
  private readonly options: D1EngineOptions;
  private readonly runtime: D1Runtime | null;
  private readonly problem: string | null;
  private lease: Lease | null = null;
  private job: {
    controller: AbortController;
    progress: D1InstallProgress | null;
    done: Promise<void>;
  } | null = null;
  private installFailure: string | null = null;
  private accepting = false;
  private removing = false;
  /** Bumped by a removal so a late install completion cannot bring the model back. */
  private generation = 0;
  private removeTask: Promise<D1Status> | null = null;
  private readonly now: () => number;
  /** The device the last prepare or admission asked for. */
  private deviceKind: D1Device = 'cpu';

  constructor(options: D1EngineOptions) {
    this.options = options;
    this.now = options.monotonicMs ?? (() => performance.now());
    const { manifest } = options;
    this.problem = manifest
      ? manifestProblem(manifest)
      : 'the Local engine is not available on this computer';
    this.runtime =
      manifest && !this.problem
        ? new D1Runtime({
            dir: d1Dir(options.root, manifest),
            manifest,
            ...(options.launch ? { launch: options.launch } : {}),
            ...(options.limits ? { limits: options.limits } : {}),
            ...(options.listDevices ? { listDevices: options.listDevices } : {}),
          })
        : null;
  }

  private get host() {
    return this.options.host ?? hostname();
  }

  /** True when this device's runtime and the shared model are installed. */
  installed(device: D1Device = this.deviceKind): boolean {
    const { manifest } = this.options;
    return !!manifest && !this.problem && d1Installed(this.options.root, manifest, device);
  }

  /** True when the manifest ships this device. */
  supports(device: D1Device): boolean {
    return !!this.options.manifest && !this.problem && !!d1Runtime(this.options.manifest, device);
  }

  status(): D1Status {
    const { manifest } = this.options;
    const runtime = this.runtime;
    const installing = this.job;
    const install: D1InstallState = installing
      ? (installing.progress?.phase ?? 'downloading')
      : this.installed(this.deviceKind)
        ? 'installed'
        : this.installFailure
          ? 'install-error'
          : 'absent';
    const lease = this.lease;
    const view: D1RuntimeView = !runtime
      ? 'stopped'
      : lease?.flight
        ? lease.flight.request.signal.aborted
          ? 'draining'
          : 'inferring'
        : lease
          ? 'packing'
          : runtime.state;
    const active = runtime?.active ?? null;
    const modelReady = this.modelReady();
    const devices =
      manifest && !this.problem
        ? d1Devices(manifest).flatMap((kind) => {
            const pinned = d1Runtime(manifest, kind);
            if (!pinned) return [];
            const deviceInstalled = d1Installed(this.options.root, manifest, kind);
            return [
              {
                kind,
                installed: deviceInstalled,
                downloadBytes:
                  (modelReady ? 0 : manifest.model.size) + (deviceInstalled ? 0 : pinned.size),
                requirement: pinned.requirement ?? null,
              },
            ];
          })
        : [];
    const pending = devices.find((entry) => entry.kind === this.deviceKind);
    const installedBytes =
      manifest && devices.some((entry) => entry.installed)
        ? manifest.model.size +
          devices.reduce((sum, entry) => {
            if (!entry.installed) return sum;
            return sum + (d1Runtime(manifest, entry.kind)?.size ?? 0);
          }, 0)
        : null;
    return {
      model: manifest?.name ?? null,
      host: this.host,
      supported: !this.problem,
      reason: this.problem,
      install,
      runtime: view,
      downloadBytes: pending?.downloadBytes ?? null,
      installedBytes,
      progress: installing?.progress
        ? { received: installing.progress.received, total: installing.progress.total }
        : null,
      error: installing ? null : (this.installFailure ?? runtime?.error ?? null),
      device: {
        requested: this.deviceKind,
        active: active?.deviceKind === this.deviceKind ? active.actualDevice : null,
      },
      devices,
      threads: active?.deviceKind === this.deviceKind ? (active.threads ?? null) : null,
      defaultThreads: d1Threads(this.options.cores ?? availableParallelism()),
    };
  }

  private modelReady(): boolean {
    const { manifest } = this.options;
    if (!manifest) return false;
    try {
      return (
        statSync(join(d1Dir(this.options.root, manifest), manifest.model.file)).size ===
        manifest.model.size
      );
    } catch {
      return false;
    }
  }

  /** Starts installing one device unless it cannot, need not, or already does. */
  install(device: D1Device = 'cpu'): D1Status {
    const { manifest } = this.options;
    if (
      !manifest ||
      this.problem ||
      this.removing ||
      this.accepting ||
      this.job ||
      !this.supports(device) ||
      this.installed(device)
    )
      return this.status();
    const generation = this.generation;
    const controller = new AbortController();
    const job: NonNullable<D1Engine['job']> = {
      controller,
      progress: null,
      done: Promise.resolve(),
    };
    this.installFailure = null;
    job.done = installD1(this.options.root, {
      manifest,
      device,
      signal: controller.signal,
      ...(this.options.fetchFn ? { fetchFn: this.options.fetchFn } : {}),
      ...(this.options.probe ? { probe: this.options.probe } : {}),
      ...(this.options.freeBytes ? { freeBytes: this.options.freeBytes } : {}),
      onProgress: (progress) => {
        job.progress = progress;
      },
    })
      .then(
        async () => {
          if (this.job === job) this.job = null;
          this.accepting = true;
          try {
            await this.options.beforeAccept?.();
            if (generation !== this.generation || this.removing) {
              this.scrub();
              this.installFailure = null;
              return;
            }
            this.options.onInstalled?.();
          } finally {
            this.accepting = false;
          }
        },
        (error: unknown) => {
          if (!controller.signal.aborted && generation === this.generation)
            this.installFailure = describe(error);
        },
      )
      .finally(() => {
        if (this.job === job) this.job = null;
        this.accepting = false;
      });
    this.job = job;
    return this.status();
  }

  /** Settles when the running install ends, however it ends; null when none runs. */
  installing(): Promise<void> | null {
    return this.job?.done ?? null;
  }

  /** Stops a running install and resolves once its partial files are gone. */
  async cancelInstall(): Promise<D1Status> {
    const job = this.job;
    if (job) {
      job.controller.abort();
      await job.done;
    }
    return this.status();
  }

  /**
   * Stops the child this engine started and deletes this manifest's folder. Refused while an
   * install or a judgment is in progress. Another manifest folder and the meeting bundle stay.
   */
  async remove(): Promise<D1Status> {
    if (!this.options.manifest || this.problem)
      throw new Error(this.problem ?? 'the Local engine is not available on this computer');
    if (this.removeTask) return this.removeTask;
    if (this.job) throw new BundleBusyError('installing');
    if (this.lease) throw new BundleBusyError('judging');
    const generation = ++this.generation;
    this.removing = true;
    const task = (async () => {
      try {
        await this.stop();
        if (this.generation === generation) {
          this.scrub();
          this.installFailure = null;
        }
        return this.status();
      } finally {
        if (this.generation === generation) this.removing = false;
      }
    })();
    this.removeTask = task;
    try {
      return await task;
    } finally {
      if (this.removeTask === task) this.removeTask = null;
    }
  }

  /** Deletes only this manifest's folder. A filesystem error keeps its path out of the message. */
  private scrub(): void {
    const { manifest } = this.options;
    if (!manifest) return;
    try {
      rmSync(d1Dir(this.options.root, manifest), { recursive: true, force: true });
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      throw new Error(
        typeof code === 'string' && /^E[A-Z]+$/.test(code)
          ? `cannot remove the Local model files (${code})`
          : 'cannot remove the Local model files',
      );
    }
  }

  /** Readies the runtime in the background, also after an error. */
  prepare(threads: number, device: D1Device = this.deviceKind): void {
    this.deviceKind = device;
    if (this.runtime && !this.removing && this.installed(device))
      void this.runtime.prepare(threads, device);
  }

  /** Ends the owned child; a judgment in flight settles at its exit. */
  async stop(): Promise<void> {
    await this.runtime?.stop();
  }

  async close(): Promise<void> {
    // A completion that has not been accepted yet must not bring the model back.
    this.generation += 1;
    this.removing = true;
    await this.cancelInstall();
    await this.stop();
  }

  /** The routing port for a saved Local setting. */
  backend(engine: LocalEngine): RoutingBackend {
    const threads = engine.device.threads;
    const device = engine.device.kind;
    this.deviceKind = device;
    return {
      kind: 'local',
      identity: () => {
        const instance = this.runtime?.ready(threads, device);
        return instance && this.options.manifest
          ? `${this.options.manifest.id}#${instance.id}`
          : null;
      },
      admit: () => this.admit(threads, device),
    };
  }

  private admit(
    threads: number,
    device: D1Device,
  ): { ok: true; lease: RoutingLease } | { ok: false; reason: RoutingFallbackReason } {
    const runtime = this.runtime;
    const manifest = this.options.manifest;
    this.deviceKind = device;
    if (!runtime || !manifest || this.job || this.removing || !this.installed(device))
      return { ok: false, reason: 'unavailable' };
    // Busy is decided before anything is counted.
    if (this.lease) return { ok: false, reason: 'busy' };
    const instance = runtime.ready(threads, device);
    if (!instance) {
      // An error waits for the person to prepare again; a stopped or other-threads runtime
      // starts now and serves a later request. A failed GPU start does not switch to CPU.
      if (runtime.state === 'error' || !this.supports(device))
        return { ok: false, reason: 'unavailable' };
      void runtime.prepare(threads, device);
      return { ok: false, reason: 'not-ready' };
    }
    const lease: Lease = { instance, flight: null };
    this.lease = lease;
    runtime.hold();
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      if (this.lease === lease) this.lease = null;
      runtime.release();
    };
    const count = async (text: string, signal: DecisionCancellation) => {
      const abort = aborting(signal);
      try {
        return await tokenize(instance.endpoint, text, abort.signal);
      } finally {
        abort.off();
      }
    };
    return {
      ok: true,
      lease: {
        identity: `${manifest.id}#${instance.id}`,
        frame: 'd1-exact',
        device: { actual: instance.actualDevice, host: this.host, threads: instance.threads },
        countState: (text, signal) => count(d1Break(text), signal),
        countInput: (state, question, signal) => count(renderChoice(state, question), signal),
        start: (request) => this.flight(lease, request, end),
        release: () => {
          if (!lease.flight) end();
        },
      },
    };
  }

  private flight(lease: Lease, request: RouterRequest, end: () => void): RoutingFlight {
    const runtime = this.runtime!;
    const { instance } = lease;
    lease.flight = { request };
    let finish!: (end: { basis: SettledBasis; finishedAtMs: number }) => void;
    const physical = new Promise<{ basis: SettledBasis; finishedAtMs: number }>((resolve) => {
      finish = resolve;
    });
    let done = false;
    const settle = (basis: SettledBasis) => {
      if (done) return;
      done = true;
      clearTimeout(watchdog);
      offExit();
      end();
      finish({ basis, finishedAtMs: this.now() });
    };
    // The physical watchdog: an inference that never ends takes its child with it.
    const watchdog = setTimeout(
      () => void runtime.isolate(instance, 'the Local judgment did not finish and was stopped'),
      runtime.limits.watchdogMs,
    );
    const offExit = onExit(instance, () => settle('owned-child-exit'));
    const result = systemOne(instance.endpoint, {
      state: request.state,
      questions: { effort: request.question },
    }).then(
      (answer): RouterResponse => {
        settle('native-response-complete');
        if (!answer || typeof answer.choice !== 'string')
          throw failure(
            'invalid-response',
            'the Local engine returned an answer Corral cannot use',
          );
        const probabilities =
          answer.probabilities &&
          typeof answer.probabilities === 'object' &&
          !Array.isArray(answer.probabilities)
            ? (answer.probabilities as Record<string, number>)
            : undefined;
        return {
          choice: answer.choice,
          ...(probabilities ? { probabilities } : {}),
          inputTokens: Number.isSafeInteger(answer.inputTokens) ? Number(answer.inputTokens) : null,
          billableUnits: null,
        };
      },
      async (error: unknown) => {
        if (error instanceof D1HttpError) {
          // The native state is unknown: the instance is ended, and the slot waits for its exit.
          void runtime.isolate(instance, 'the Local runtime returned an error and was stopped');
          throw failure('transport-error', error.message);
        }
        // A broken connection: a crash shows as the child's exit shortly after.
        const exited = await Promise.race([
          instance.child.exited.then(() => true),
          new Promise<boolean>((resolve) =>
            setTimeout(() => resolve(false), runtime.limits.graceMs),
          ),
        ]);
        if (exited) throw failure('daemon-crash', 'the Local runtime stopped during a judgment');
        void runtime.isolate(instance, 'the Local runtime lost a judgment and was stopped');
        throw failure('transport-error', 'the Local runtime connection broke');
      },
    );
    // The answer settles before the physical end is reported.
    const settled = physical.then(async (value) => {
      await result.then(
        () => {},
        () => {},
      );
      return value;
    });
    return { result, settled };
  }
}
