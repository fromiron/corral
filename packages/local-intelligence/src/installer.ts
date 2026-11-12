// The settings panel's install: one background install per server, with progress, cancellation
// and the last failure, on top of installBundle.
import type { Bundle } from './bundle.ts';
import { installBundle, installState } from './install.ts';

export interface InstallProgressView {
  received: number;
  total: number;
}

interface Job {
  controller: AbortController;
  received: number;
  done: Promise<void>;
}

export interface BundleInstallerOptions {
  root: string;
  bundle: Bundle;
  target: string | null;
  fetchFn?: typeof fetch;
  /**
   * Awaited after the files are on disk and this install is no longer in progress, before it is
   * accepted. A removal in that gap discards the install.
   */
  beforeAccept?(): Promise<void>;
  /** Called once an install is accepted. */
  onInstalled(): void;
  /** Called when an install finishes after it was removed. */
  onDiscarded?(): void;
}

/** Bytes of the files installed before `file`: the model, then the runtime. */
function bytesBefore(bundle: Bundle, file: string): number {
  return file === 'runtime' ? bundle.models.meeting.size : 0;
}

/** A failure the user can act on; filesystem errors carry local paths, so only their code. */
function describe(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^E[A-Z]+$/.test(code))
    return `cannot write the local AI files (${code})`;
  return error instanceof Error ? error.message : String(error);
}

export class BundleInstaller {
  private job: Job | null = null;
  private failure: string | null = null;
  private accepting = false;
  /** Bumped when a removal discards an install that has not been accepted yet. */
  private generation = 0;
  private flight: Promise<void> | null = null;

  private readonly options: BundleInstallerOptions;

  constructor(options: BundleInstallerOptions) {
    this.options = options;
  }

  /** The full download for this machine, or null when it has no runtime. */
  downloadBytes(): number | null {
    const { bundle, target } = this.options;
    const runtime =
      target && Object.hasOwn(bundle.runtime.targets, target)
        ? bundle.runtime.targets[target]
        : undefined;
    return runtime ? bundle.models.meeting.size + runtime.size : null;
  }

  /** A download is in progress. The gap before an install is accepted is not one. */
  running(): boolean {
    return this.job !== null;
  }

  /** The in-flight install, including the moment before it is accepted. */
  installing(): Promise<void> | null {
    return this.flight;
  }

  /** A removal happened. An install that has not been accepted yet must not become one. */
  invalidate(): void {
    this.generation += 1;
  }

  progress(): InstallProgressView | null {
    const total = this.downloadBytes();
    return this.job && total !== null ? { received: this.job.received, total } : null;
  }

  error(): string | null {
    return this.failure;
  }

  /** Starts unless one is running, this release is installed, or the machine has no runtime. */
  start(): void {
    const { root, bundle, target, fetchFn } = this.options;
    if (this.job || this.accepting || !target) return;
    const state = installState(root, target, bundle);
    if (state !== 'missing' && state !== 'stale') return;
    const generation = this.generation;
    const controller = new AbortController();
    const job: Job = { controller, received: 0, done: Promise.resolve() };
    this.failure = null;
    job.done = installBundle(root, {
      bundle,
      target,
      ...(fetchFn ? { fetchFn } : {}),
      signal: controller.signal,
      // The models come first, in manifest order, then the runtime.
      onProgress: ({ file, received }) => {
        job.received = bytesBefore(bundle, file) + received;
      },
    })
      .then(
        async () => {
          if (this.job === job) this.job = null;
          this.accepting = true;
          try {
            await this.options.beforeAccept?.();
            if (generation !== this.generation) {
              this.options.onDiscarded?.();
              return;
            }
            this.options.onInstalled();
          } finally {
            this.accepting = false;
          }
        },
        (error: unknown) => {
          if (!controller.signal.aborted && generation === this.generation)
            this.failure = describe(error);
        },
      )
      .finally(() => {
        if (this.job === job) this.job = null;
        this.accepting = false;
        if (this.flight === job.done) this.flight = null;
      });
    this.job = job;
    this.flight = job.done;
  }

  /** Stops a running install and resolves once its partial files are removed. */
  async cancel(): Promise<void> {
    const job = this.job;
    if (!job) return;
    job.controller.abort();
    await job.done;
  }
}
