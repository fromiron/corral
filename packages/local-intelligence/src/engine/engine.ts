// One embedding engine per server: a resident helper process that serves one request at a time.
// Effort judgments go ahead of meeting batches. A caller that stops waiting only drops its
// result; the slot is freed when the helper actually answers, so two computations never overlap.
// Device changes and shutdown refuse waiting work and end the helper process.
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DecisionCancellation, Scheduler } from '@corral/contracts';
import { type Bundle, bundledManifest } from '../bundle.ts';
import { bundleDir, type InstallState, installState } from '../install.ts';
import { type HelperLauncher, type HelperProcess, spawnHelper } from './helper.ts';

export type Device = 'cpu' | 'gpu' | 'auto';
export type Backend = 'cpu' | 'gpu';
export type EngineState =
  | 'unsupported'
  | 'missing'
  | 'stale'
  | 'idle'
  | 'starting'
  | 'ready'
  | 'error';
export type EmbedTask = 'classification' | 'clustering' | 'query' | 'document';

/** Prompts from the EmbeddingGemma 2 model card (config_sentence_transformers.json). */
export const TASK_PREFIX: Record<EmbedTask, string> = {
  classification: 'task: classification | query: ',
  clustering: 'task: clustering | query: ',
  query: 'task: search result | query: ',
  document: 'title: none | text: ',
};

export interface EmbedRequest {
  texts: readonly string[];
  task: EmbedTask;
  /** `truncate` keeps the first tokens; `chunk_average` covers long text in averaged chunks. */
  overflow: 'truncate' | 'chunk_average';
  priority: 'effort' | 'meeting';
}

export interface EngineStatus {
  state: EngineState;
  requestedDevice: Device;
  actualDevice: Backend | null;
  error: string | null;
  release: string;
}

export interface EngineOptions {
  /** The folder that holds one sub-folder per installed release. */
  root: string;
  bundle?: Bundle;
  /** `<platform>-<arch>`, or null when no runtime library exists for this machine. */
  target: string | null;
  /** The built helper executable, or null when it is not available. */
  helperPath: string | null;
  launch?: HelperLauncher;
  device?: Device;
  threads: number;
  env?: Record<string, string>;
  now?: () => number;
  timers?: Scheduler;
}

const QUEUE_LIMIT = { effort: 3, meeting: 16 } as const;
const READY_TIMEOUT_MS = 60_000;
const COOLDOWN_MS = 60_000;
const CACHE_ENTRIES = 512;

interface Job {
  request: EmbedRequest;
  priority: EmbedRequest['priority'];
  settled: boolean;
  resolve(vectors: Float32Array[]): void;
  reject(error: Error): void;
}

type HelperMessage =
  | { type: 'ready'; api: number[]; backend: Backend }
  | { type: 'result'; id: number; embeddings: number[][] }
  | { type: 'error'; id: number; message: string }
  | { type: 'fatal'; message: string };

export class LocalEmbeddingEngine {
  readonly bundle: Bundle;
  private install: InstallState;
  private requestedDevice: Device;
  private helper: HelperProcess | null = null;
  private actualDevice: Backend | null = null;
  private starting: Promise<void> | null = null;
  private generation = 0;
  private running: 'idle' | 'starting' | 'ready' | 'error' = 'idle';
  private error: string | null = null;
  private failedUntil = 0;
  private active: Job | null = null;
  private activeId = 0;
  private nextId = 1;
  private readonly waiting: Job[] = [];
  private readonly cache = new Map<string, Float32Array>();
  private closing: Promise<void> | null = null;
  private readonly options: EngineOptions;

  constructor(options: EngineOptions) {
    this.options = options;
    this.bundle = options.bundle ?? bundledManifest();
    this.requestedDevice = options.device ?? 'cpu';
    this.install = installState(options.root, options.target, this.bundle);
  }

  private get now() {
    return this.options.now ?? Date.now;
  }

  private after(ms: number, fn: () => void): () => void {
    if (this.options.timers) return this.options.timers.after(ms, fn);
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  }

  /** Re-reads the install state, after an install or an update. */
  refreshInstall() {
    this.install = installState(this.options.root, this.options.target, this.bundle);
  }

  status(): EngineStatus {
    const state: EngineState =
      !this.options.helperPath || this.install === 'unsupported'
        ? 'unsupported'
        : this.install !== 'current'
          ? this.install
          : this.running;
    const reason = this.unavailable();
    return {
      state,
      requestedDevice: this.requestedDevice,
      actualDevice: state === 'ready' ? this.actualDevice : null,
      error: state === 'error' || state === 'unsupported' ? (this.error ?? reason) : null,
      release: this.bundle.release,
    };
  }

  isReady() {
    return this.running === 'ready';
  }

  /** True, or why no embedding can be computed right now. */
  available(): true | string {
    return this.unavailable() ?? true;
  }

  private unavailable(): string | null {
    if (this.closing) return 'the local AI engine is closed';
    if (this.install === 'unsupported') return 'local AI has no runtime for this platform';
    if (!this.options.helperPath) return 'the local AI helper is not built';
    if (this.install === 'missing') return 'not installed: run `corral local-ai install`';
    if (this.install === 'stale')
      return 'an older release is installed: run `corral local-ai install`';
    if (this.running === 'error' && this.now() < this.failedUntil)
      return `the local AI engine is unavailable: ${this.error}`;
    return null;
  }

  /** Starts the helper ahead of the first request; resolves once it is ready. */
  warmUp(): Promise<void> {
    const reason = this.unavailable();
    if (reason) return Promise.reject(new Error(reason));
    return this.ensureStarted();
  }

  embed(request: EmbedRequest, cancellation?: DecisionCancellation): Promise<Float32Array[]> {
    const reason = this.unavailable();
    if (reason) return Promise.reject(new Error(reason));
    if (cancellation?.aborted) return Promise.reject(new Error('embedding cancelled'));
    const texts = request.texts.map((text) => TASK_PREFIX[request.task] + text.trim());
    const keys = texts.map((text) => this.cacheKey(request, text));
    const known = keys.map((key) => this.cached(key));
    const missing = texts.filter((_, index) => !known[index]);
    if (missing.length === 0) return Promise.resolve(known as Float32Array[]);
    const sameQueue = this.waiting.filter((job) => job.priority === request.priority).length;
    if (sameQueue >= QUEUE_LIMIT[request.priority])
      return Promise.reject(new Error('the local AI queue is full'));
    return new Promise<Float32Array[]>((resolve, reject) => {
      let off = () => {};
      const job: Job = {
        request: { ...request, texts: missing },
        priority: request.priority,
        settled: false,
        resolve: (vectors) => {
          if (job.settled) return;
          job.settled = true;
          off();
          let next = 0;
          const all = known.map((vector, index) => {
            if (vector) return vector;
            const computed = vectors[next++]!;
            this.remember(keys[index]!, computed);
            return computed;
          });
          resolve(all);
        },
        reject: (error) => {
          if (job.settled) return;
          job.settled = true;
          off();
          reject(error);
        },
      };
      off =
        cancellation?.onCancel(() => {
          const index = this.waiting.indexOf(job);
          if (index >= 0) this.waiting.splice(index, 1);
          // An active job keeps the slot until the helper answers.
          job.reject(new Error('embedding cancelled'));
        }) ?? off;
      this.waiting.push(job);
      void this.ensureStarted().catch(() => {});
      this.pump();
    });
  }

  async setDevice(device: Device): Promise<void> {
    if (device === this.requestedDevice) return;
    this.requestedDevice = device;
    await this.stopHelper(new Error('the local AI device is changing'));
    this.running = 'idle';
    this.error = null;
    this.failedUntil = 0;
  }

  close(): Promise<void> {
    this.closing ??= this.stopHelper(new Error('the local AI engine is closed'));
    return this.closing;
  }

  private async stopHelper(reason: Error) {
    this.generation++;
    this.starting = null;
    const helper = this.helper;
    this.helper = null;
    this.actualDevice = null;
    this.rejectAll(reason);
    await helper?.kill();
  }

  private rejectAll(error: Error) {
    this.active?.reject(error);
    this.active = null;
    for (const job of this.waiting.splice(0)) job.reject(error);
  }

  private cacheKey(request: EmbedRequest, text: string) {
    return createHash('sha256')
      .update(
        [
          this.bundle.release,
          request.task,
          request.overflow,
          this.bundle.embedding.dims,
          text,
        ].join('\u0000'),
      )
      .digest('hex');
  }

  private cached(key: string) {
    const vector = this.cache.get(key);
    if (vector) {
      this.cache.delete(key);
      this.cache.set(key, vector);
    }
    return vector;
  }

  private remember(key: string, vector: Float32Array) {
    this.cache.set(key, vector);
    if (this.cache.size > CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
  }

  private ensureStarted(): Promise<void> {
    if (this.running === 'ready' && this.helper) return Promise.resolve();
    if (this.starting) return this.starting;
    const generation = this.generation;
    const order: Backend[] =
      this.requestedDevice === 'auto' ? ['gpu', 'cpu'] : [this.requestedDevice];
    this.running = 'starting';
    this.error = null;
    this.starting = (async () => {
      let lastError: Error = new Error('the local AI helper did not start');
      for (const backend of order) {
        if (generation !== this.generation) return;
        try {
          const helper = await this.launch(backend, generation);
          if (generation !== this.generation) {
            await helper.kill();
            return;
          }
          this.helper = helper;
          this.actualDevice = backend;
          this.running = 'ready';
          this.starting = null;
          this.pump();
          return;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
        }
      }
      if (generation !== this.generation) return;
      this.starting = null;
      this.fail(lastError.message);
      throw lastError;
    })();
    return this.starting;
  }

  private launch(backend: Backend, generation: number): Promise<HelperProcess> {
    const dir = bundleDir(this.options.root, this.bundle);
    const runtime = this.bundle.runtime.targets[this.options.target!]!;
    // LiteRT-LM refuses a cache folder that does not exist.
    mkdirSync(join(dir, 'cache'), { recursive: true });
    const helper = (this.options.launch ?? spawnHelper)({
      executable: this.options.helperPath!,
      args: [
        '--lib',
        join(dir, runtime.library),
        '--model',
        join(dir, this.bundle.model.file),
        '--backend',
        backend,
        '--threads',
        backend === 'cpu' ? String(this.options.threads) : '0',
        '--max-input',
        String(this.bundle.embedding.maxInputTokens),
        '--cache-dir',
        join(dir, 'cache'),
        '--api-major',
        String(this.bundle.runtime.apiVersion.major),
        '--api-minor',
        String(this.bundle.runtime.apiVersion.minor),
      ],
      cwd: dir,
      env:
        this.options.env ??
        (process.platform === 'win32'
          ? { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows', PATH: dir }
          : {}),
    });
    return new Promise((resolve, reject) => {
      let started = false;
      let settled = false;
      const settle = (error: Error | null) => {
        if (settled) return;
        settled = true;
        stopTimer();
        if (error) {
          void helper.kill();
          reject(error);
        } else {
          started = true;
          resolve(helper);
        }
      };
      const stopTimer = this.after(READY_TIMEOUT_MS, () =>
        settle(new Error(`the local AI helper did not start within ${READY_TIMEOUT_MS / 1000} s`)),
      );
      helper.onLine((line) => {
        let message: HelperMessage;
        try {
          message = JSON.parse(line) as HelperMessage;
        } catch {
          return;
        }
        if (!started) {
          if (message.type === 'ready') settle(null);
          else if (message.type === 'fatal') settle(new Error(message.message));
          return;
        }
        if (generation === this.generation && helper === this.helper) this.onMessage(message);
      });
      helper.onExit((detail) => {
        if (!started) {
          settle(new Error(`the local AI helper exited: ${detail}`));
          return;
        }
        if (generation !== this.generation || helper !== this.helper) return;
        this.helper = null;
        this.fail(`the local AI helper stopped: ${detail}`);
      });
    });
  }

  private onMessage(message: HelperMessage) {
    if ((message.type !== 'result' && message.type !== 'error') || message.id !== this.activeId)
      return;
    const job = this.active;
    this.active = null;
    if (job) {
      if (message.type === 'error') job.reject(new Error(message.message));
      else if (
        message.embeddings.length !== job.request.texts.length ||
        message.embeddings.some((vector) => vector.length !== this.bundle.embedding.dims)
      )
        job.reject(new Error('the local AI helper returned an unexpected embedding shape'));
      else job.resolve(message.embeddings.map((vector) => Float32Array.from(vector)));
    }
    this.pump();
  }

  private fail(message: string) {
    this.running = 'error';
    this.error = message;
    this.actualDevice = null;
    this.failedUntil = this.now() + COOLDOWN_MS;
    this.rejectAll(new Error(message));
  }

  private pump() {
    if (!this.helper || this.running !== 'ready' || this.active) return;
    let index = this.waiting.findIndex((job) => job.priority === 'effort');
    if (index < 0) index = 0;
    const job = this.waiting.splice(index, 1)[0];
    if (!job) return;
    if (job.settled) {
      this.pump();
      return;
    }
    this.active = job;
    this.activeId = this.nextId++;
    try {
      this.helper.write(
        JSON.stringify({
          id: this.activeId,
          texts: job.request.texts,
          overflow: job.request.overflow,
          dim: this.bundle.embedding.dims,
        }),
      );
    } catch (error) {
      this.helper = null;
      this.fail(`the local AI helper stopped: ${error instanceof Error ? error.message : error}`);
    }
  }
}
