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
  /** Called after the release stamp is written. */
  onInstalled(): void;
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
    return runtime ? bundle.model.size + runtime.size : null;
  }

  running(): boolean {
    return this.job !== null;
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
    if (this.job || !target) return;
    const state = installState(root, target, bundle);
    if (state !== 'missing' && state !== 'stale') return;
    const controller = new AbortController();
    const job: Job = { controller, received: 0, done: Promise.resolve() };
    this.failure = null;
    job.done = installBundle(root, {
      bundle,
      target,
      ...(fetchFn ? { fetchFn } : {}),
      signal: controller.signal,
      // The model comes first; once the runtime downloads, the model is in place.
      onProgress: ({ file, received }) => {
        job.received = (file === 'runtime' ? bundle.model.size : 0) + received;
      },
    })
      .then(
        () => this.options.onInstalled(),
        (error: unknown) => {
          if (!controller.signal.aborted) this.failure = describe(error);
        },
      )
      .finally(() => {
        if (this.job === job) this.job = null;
      });
    this.job = job;
  }

  /** Stops a running install and resolves once its partial files are removed. */
  async cancel(): Promise<void> {
    const job = this.job;
    if (!job) return;
    job.controller.abort();
    await job.done;
  }
}
