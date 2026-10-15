import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type {
  DecisionCancellation,
  DecisionProvider,
  EffortLevel,
  EffortQuestion,
} from '@corral/contracts';
import { chooseLevel } from './cost.ts';
import { type InputFormat, inputIds } from './input.ts';
import { bundledManifest, installState } from './install.ts';
import { type CompactTokenizer, loadCompactTokenizer } from './tokenizer.ts';

// `local-model`: the mixdog effort judge (EmbeddingGemma 2 derived, ONNX, 4-bit) as a Corral
// DecisionProvider (CR-003 D1 as changed by Bell on 2026-10-16, C-072). Observe only: its answer
// is recorded, never applied to a request.

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
}

/** onnxruntime-node ships no macOS Intel binding since 1.23 (mixdog onnx-runtime-support). */
export function onnxRuntimeSupported(platform: string, arch: string): boolean {
  return !(platform === 'darwin' && arch === 'x64');
}

interface Calibration {
  temperature: number;
  inputFormat: InputFormat;
  maxTokens: number;
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
    temperature: temperature > 0 ? temperature : 1,
    inputFormat: FORMATS.includes(format) ? format : 'pr',
    maxTokens: maxTokens > 2 ? maxTokens : 256,
  };
}

/** A worker-thread session; the worker loads the model once and stays resident. */
export async function workerSession(dir: string): Promise<JudgeSession> {
  const worker = new Worker(new URL('./onnx-worker.ts', import.meta.url), { workerData: { dir } });
  const pending = new Map<number, { resolve(v: number[]): void; reject(e: Error): void }>();
  let next = 0;
  await new Promise<void>((resolve, reject) => {
    worker.once('error', reject);
    worker.on(
      'message',
      (m: { type: string; id?: number; logits?: number[]; message?: string }) => {
        if (m.type === 'ready') resolve();
        else if (m.type === 'load-error') reject(new Error(m.message));
        else if (m.id !== undefined) {
          const call = pending.get(m.id);
          pending.delete(m.id);
          if (m.type === 'result' && m.logits) call?.resolve(m.logits);
          else call?.reject(new Error(m.message ?? 'judgment failed'));
          // An idle resident worker must not keep the process alive.
          if (pending.size === 0) worker.unref();
        }
      },
    );
  });
  worker.unref();
  return {
    run: (ids) =>
      new Promise((resolve, reject) => {
        const id = ++next;
        pending.set(id, { resolve, reject });
        // A judgment in flight keeps the process alive until its answer arrives.
        worker.ref();
        worker.postMessage({ id, ids });
      }),
    close: async () => {
      await worker.terminate();
    },
  };
}

export class OnnxEffortProvider implements DecisionProvider {
  readonly id = 'local-model';
  readonly version: string;
  readonly privacy = 'local' as const;
  /** The first judgment after start loads the model; `warmUp` hides that. */
  readonly timeoutMs = 1_500;
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
    this.loaded ??= (async () => {
      const dir = this.options.dir;
      const tokenizer = loadCompactTokenizer(dir);
      const session = await (this.options.session ?? workerSession)(dir);
      return { session, tokenizer, cal: calibration(dir) };
    })();
    // A failed load is retried on the next judgment.
    this.loaded.catch(() => {
      this.loaded = null;
    });
    return this.loaded;
  }

  async decide(question: EffortQuestion, _cancellation: DecisionCancellation) {
    const { session, tokenizer, cal } = await this.warmUp();
    const ids = inputIds(tokenizer, cal.inputFormat, cal.maxTokens, {
      request: question.input.excerpt,
    });
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
    const loaded = await this.loaded?.catch(() => null);
    await loaded?.session.close?.();
  }
}
