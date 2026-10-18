import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type {
  DecisionCancellation,
  DecisionProvider,
  EffortLevel,
  EffortQuestion,
  ReasoningInput,
  Scheduler,
} from '@corral/contracts';
import { chooseLevel } from './cost.ts';
import { type InputFormat, inputIds, stepInputIds } from './input.ts';
import { bundledManifest, installState } from './install.ts';
import { type CompactTokenizer, loadCompactTokenizer } from './tokenizer.ts';

// `local-model`: the mixdog effort judge (EmbeddingGemma 2 derived, ONNX, 4-bit) as a Corral
// DecisionProvider (CR-003, CR-021). Observation and opt-in request preparation share one worker.

const LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh'];
const FORMATS: readonly InputFormat[] = ['pr', 'rp', 'rpq', 'rpc', 'pack'];

/** Runs the model on token ids and returns its four logits. */
export interface JudgeSession {
  run(ids: number[]): Promise<number[]>;
  close?(): Promise<void>;
}

export interface OnnxEffortOptions {
  /** Where the model is installed (installModel). */
  dir: string;
  /** The release this build expects; another installed release is reported as stale. */
  release?: string;
  /** Loads the session; defaults to a worker thread running onnxruntime-node. */
  session?: (dir: string) => Promise<JudgeSession>;
  platform?: { platform: string; arch: string };
  now?: () => number;
  timers?: Scheduler;
}

/** onnxruntime-node ships no macOS Intel binding since 1.23 (mixdog onnx-runtime-support). */
export function onnxRuntimeSupported(platform: string, arch: string): boolean {
  return !(platform === 'darwin' && arch === 'x64');
}

interface Calibration {
  temperature: number;
  inputFormat: InputFormat;
  maxTokens: number;
  steps: boolean;
}

function calibration(dir: string): Calibration {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(readFileSync(join(dir, 'calibration.json'), 'utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    // defaults below
  }
  const temperature = Number(raw.temperature);
  const maxTokens = Number(raw.maxTokens);
  const format = String(raw.inputFormat) as InputFormat;
  return {
    steps: raw.steps === 1,
    temperature: temperature > 0 ? temperature : 1,
    inputFormat: FORMATS.includes(format) ? format : 'pr',
    maxTokens: maxTokens > 2 ? maxTokens : 256,
  };
}

/** A worker-thread session; the worker loads the model once and stays resident. */
export async function workerSession(dir: string): Promise<JudgeSession> {
  const worker = new Worker(new URL('./onnx-worker.ts', import.meta.url), { workerData: { dir } });
  let next = 0,
    stopped = false;
  let rejectLoad: (error: Error) => void = () => {};
  const pending = new Map<
    number,
    { resolve(v: number[]): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }
  >();
  const rejectAll = (error: Error) => {
    rejectLoad(error);
    for (const call of pending.values()) {
      clearTimeout(call.timer);
      call.reject(error);
    }
    pending.clear();
  };
  let closing: Promise<void> | null = null;
  const close = () => {
    closing ??= (async () => {
      stopped = true;
      await worker.terminate();
      rejectAll(new Error('judge worker stopped'));
    })();
    return closing;
  };
  worker.on('error', (error) => {
    rejectAll(error);
    void close();
  });
  worker.on('exit', () => {
    stopped = true;
    rejectAll(new Error('judge worker exited'));
  });
  await new Promise<void>((resolve, reject) => {
    rejectLoad = reject;
    const timer = setTimeout(() => void close(), 10000);
    worker.on('message', (message: { type: string; id?: number; logits?: number[] }) => {
      if (message.type === 'ready') {
        clearTimeout(timer);
        resolve();
      } else if (message.type === 'load-error') {
        clearTimeout(timer);
        void close();
      } else if (message.id !== undefined) {
        const call = pending.get(message.id);
        if (!call) return;
        pending.delete(message.id);
        clearTimeout(call.timer);
        if (message.type === 'result' && message.logits) call.resolve(message.logits);
        else call.reject(new Error('judge inference failed'));
        if (!pending.size) worker.unref();
      }
    });
    worker.once('exit', () => clearTimeout(timer));
  }).catch(async (error: unknown) => {
    await close();
    throw error;
  });
  worker.unref();
  return {
    run: (ids) =>
      new Promise((resolve, reject) => {
        if (stopped) {
          reject(new Error('judge worker stopped'));
          return;
        }
        const id = ++next;
        // Replacement is possible only after terminate/exit rejects the real in-flight call.
        const timer = setTimeout(() => void close(), 10000);
        pending.set(id, { resolve, reject, timer });
        worker.ref();
        worker.postMessage({ id, ids });
      }),
    close,
  };
}

export class OnnxEffortProvider implements DecisionProvider {
  readonly id = 'local-model';
  readonly version: string;
  readonly privacy = 'local' as const;
  /**
   * 1.5 s per judgment once the model is loaded. Until then a judgment also waits for the load
   * (a few seconds after start), so it is not counted as a timeout: judgments are observed only
   * and no request waits for them (CR-003).
   */
  get timeoutMs(): number {
    return this.ready ? 1_500 : 20_000;
  }
  private ready = false;
  private active = false;
  private closed = false;
  private failedUntil = 0;
  private readonly queue: { start(): void; cancel(): void }[] = [];
  private get now() {
    return this.options.now ?? Date.now;
  }
  private after(ms: number, fn: () => void): () => void {
    if (this.options.timers) return this.options.timers.after(ms, fn);
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  }
  private pump() {
    if (!this.active && !this.closed) this.queue.shift()?.start();
  }
  private queued(
    input: ReasoningInput,
    cancellation: DecisionCancellation,
    apply: boolean,
  ): Promise<unknown> {
    if (this.closed || cancellation.aborted) return Promise.reject(new Error('judge cancelled'));
    if (this.queue.length >= 3) return Promise.reject(new Error('judge queue full'));
    return new Promise((resolve, reject) => {
      let settled = false;
      let off = () => {},
        stop = () => {};
      const finish = (error: Error | null, value?: unknown) => {
        if (settled) return;
        settled = true;
        off();
        stop();
        if (error) reject(error);
        else resolve(value);
      };
      const entry = {
        cancel: (error = new Error('judge cancelled')) => {
          const index = this.queue.indexOf(entry);
          if (index >= 0) this.queue.splice(index, 1);
          finish(error);
        },
        start: () => {
          if (settled) {
            this.pump();
            return;
          }
          this.active = true;
          stop();
          stop = this.after(apply ? (this.ready ? 1500 : 3000) : this.timeoutMs, () =>
            finish(new Error('judge timeout', { cause: 'timeout' })),
          );
          // A timed-out caller does not release occupancy while inference is still running.
          void this.infer(input)
            .then(
              (value) => finish(null, value),
              async (error: unknown) => {
                await this.loaded?.then((loaded) => loaded.session.close?.()).catch(() => {});
                this.loaded = null;
                this.ready = false;
                this.failedUntil = this.now() + 60000;
                finish(error instanceof Error ? error : new Error('judge failed'));
              },
            )
            .finally(() => {
              this.active = false;
              this.pump();
            });
        },
      };
      this.queue.push(entry);
      stop = this.after(1000, () =>
        entry.cancel(new Error('judge queue timeout', { cause: 'timeout' })),
      );
      off = cancellation.onCancel(entry.cancel);
      this.pump();
    });
  }
  readonly questions = [{ kind: 'reasoning_effort' as const, version: 1 }];
  private readonly options: OnnxEffortOptions;
  private loaded: Promise<{
    session: JudgeSession;
    tokenizer: CompactTokenizer;
    cal: Calibration;
  }> | null = null;

  constructor(options: OnnxEffortOptions) {
    this.options = options;
    this.version = options.release ?? bundledManifest().release;
  }

  available(): true | string {
    const { platform, arch } = this.options.platform ?? process;
    if (!onnxRuntimeSupported(platform, arch))
      return `no onnxruntime build for ${platform}-${arch}`;
    const state = installState(this.options.dir, { ...bundledManifest(), release: this.version });
    if (state === 'missing') return 'not installed: run `corral judge install`';
    if (state === 'stale') return 'an older release is installed: run `corral judge install`';
    return true;
  }

  /** Loads tokenizer and model ahead of the first judgment. */
  warmUp() {
    if (this.closed || this.now() < this.failedUntil)
      return Promise.reject(new Error('judge load cooldown'));
    this.loaded ??= (async () => {
      const dir = this.options.dir;
      const tokenizer = loadCompactTokenizer(dir);
      const session = await (this.options.session ?? workerSession)(dir);
      return { session, tokenizer, cal: calibration(dir) };
    })();
    // A failed load is retried on the next judgment.
    this.loaded.then(
      () => {
        this.ready = true;
      },
      () => {
        this.loaded = null;
        this.ready = false;
        this.failedUntil = this.now() + 60000;
      },
    );
    return this.loaded;
  }

  decide(question: EffortQuestion, cancellation: DecisionCancellation) {
    return this.queued(
      {
        kind: 'turn',
        request: question.input.excerpt,
        prev: '',
        prevRequest: '',
        step: 0,
        plan: '',
        calls: [],
        directiveIds: [],
      },
      cancellation,
      false,
    );
  }

  decideRequest(input: ReasoningInput, cancellation: DecisionCancellation) {
    return this.queued(input, cancellation, true);
  }

  private async infer(input: ReasoningInput) {
    const { session, tokenizer, cal } = await this.warmUp();
    if (input.kind === 'step' && !cal.steps)
      throw new Error('judge calibration does not support steps');
    const ids =
      input.kind === 'step'
        ? stepInputIds(tokenizer, cal.maxTokens, input)
        : inputIds(tokenizer, cal.inputFormat, cal.maxTokens, input);
    const logits = (await session.run(ids)).map((v) => v / cal.temperature);
    if (logits.length !== 4 || logits.some((v) => !Number.isFinite(v)))
      throw new Error('the model did not return four logits');
    const top = Math.max(...logits);
    const exp = logits.map((v) => Math.exp(v - top));
    const sum = exp.reduce((a, b) => a + b, 0);
    const probs = exp.map((v) => v / sum);
    return {
      answer: LEVELS[chooseLevel(probs)] ?? 'medium',
      probabilities: {
        low: probs[0] ?? 0,
        medium: probs[1] ?? 0,
        high: probs[2] ?? 0,
        xhigh: probs[3] ?? 0,
      },
      evidenceLevel: 'model_probability' as const,
    };
  }

  async close() {
    this.closed = true;
    for (const entry of [...this.queue]) entry.cancel();
    const loaded = await this.loaded?.catch(() => null);
    await loaded?.session.close?.();
  }
}
