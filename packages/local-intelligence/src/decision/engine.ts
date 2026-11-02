import { type HelperProcess, spawnHelper } from '../engine/helper.ts';
import type {
  DecisionBackend,
  DecisionEngineOptions,
  DecisionEngineState,
  DecisionEngineStatus,
  DecisionErrorCode,
  DecisionInput,
  DecisionInputMetadata,
  DecisionLevel,
  DecisionRequestOptions,
  DecisionResult,
  FourScores,
} from './types.ts';

const LEVELS: readonly DecisionLevel[] = ['low', 'medium', 'high', 'xhigh'];
const INPUT_ERRORS = new Set<DecisionErrorCode>([
  'invalid_request',
  'invalid_budget',
  'input_too_long',
  'invalid_response',
]);

export class DecisionEngineError extends Error {
  readonly code: DecisionErrorCode;
  constructor(code: DecisionErrorCode) {
    super(`local decision engine: ${code}`);
    this.name = 'DecisionEngineError';
    this.code = code;
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

interface OwnedHelper {
  process: HelperProcess;
  loaded: ReturnType<typeof deferred<void>>;
  hasLoaded: boolean;
  exited: boolean;
  stopTimer: () => void;
}
interface WireRequest {
  owner: OwnedHelper;
  id: number;
  input: DecisionInput;
  result: ReturnType<typeof deferred<DecisionResult>>;
}
interface Job {
  input: DecisionInput;
  options: DecisionRequestOptions;
  settled: boolean;
  resolve(value: DecisionResult): void;
  reject(error: Error): void;
}

/** An explicitly configured process controller; no installer, model choice, or request replay. */
export class LocalDecisionEngine {
  private readonly options: DecisionEngineOptions;
  private readonly warmup: readonly DecisionInput[];
  private state: DecisionEngineState = 'idle';
  private actualBackend: DecisionBackend | null = null;
  private error: DecisionErrorCode | null = null;
  private failedUntil = 0;
  private owner: OwnedHelper | null = null;
  private starting: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private closed = false;
  private terminationFailed = false;
  private wire: WireRequest | null = null;
  private nextId = 1;
  private active: Job | null = null;
  private readonly waiting: Job[] = [];

  constructor(options: DecisionEngineOptions) {
    this.options = {
      ...options,
      command: {
        ...options.command,
        args: [...options.command.args],
        env: { ...options.command.env },
      },
    };
    if (
      !Number.isSafeInteger(options.contextTokens) ||
      options.contextTokens < 128 ||
      options.contextTokens > 4096 ||
      options.warmup.length === 0 ||
      (options.backend !== 'cpu' && options.backend !== 'gpu') ||
      !Number.isSafeInteger(options.queueLimit ?? 16) ||
      (options.queueLimit ?? 16) < 1 ||
      !Number.isFinite(options.startupTimeoutMs ?? 60_000) ||
      (options.startupTimeoutMs ?? 60_000) <= 0 ||
      !Number.isFinite(options.retryDelayMs ?? 60_000) ||
      (options.retryDelayMs ?? 60_000) < 0
    )
      throw new DecisionEngineError('invalid_request');
    this.warmup = options.warmup.map((input) => this.input(input));
  }

  private now() {
    return (this.options.now ?? Date.now)();
  }

  private after(ms: number, fn: () => void): () => void {
    if (this.options.timers) return this.options.timers.after(ms, fn);
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  }

  status(): DecisionEngineStatus {
    return {
      state: this.state,
      requestedBackend: this.options.backend,
      actualBackend: this.actualBackend,
      release: this.options.release,
      calibrationVersion: this.options.calibrationVersion ?? null,
      error: this.error,
    };
  }

  isReady() {
    return this.state === 'ready' && this.owner !== null && !this.stopping;
  }

  available(): true | string {
    const code = this.unavailable();
    return code ? new DecisionEngineError(code).message : true;
  }

  private unavailable(): DecisionErrorCode | null {
    if (this.closed) return 'closed';
    if (this.terminationFailed || this.now() < this.failedUntil) return 'unavailable';
    return null;
  }

  warmUp(): Promise<void> {
    return this.ensureStarted();
  }

  decide(input: DecisionInput, options: DecisionRequestOptions): Promise<DecisionResult> {
    const unavailable = this.unavailable();
    if (unavailable) return Promise.reject(new DecisionEngineError(unavailable));
    if (options.signal?.aborted || options.cancellation?.aborted)
      return Promise.reject(new DecisionEngineError('cancelled'));
    if (!Number.isFinite(options.deadlineMs))
      return Promise.reject(new DecisionEngineError('invalid_request'));
    if (options.deadlineMs <= this.now()) return Promise.reject(new DecisionEngineError('timeout'));
    let snapshot: DecisionInput;
    try {
      snapshot = this.input(input);
    } catch (error) {
      return Promise.reject(
        error instanceof DecisionEngineError ? error : new DecisionEngineError('invalid_request'),
      );
    }
    if (this.waiting.length >= (this.options.queueLimit ?? 16))
      return Promise.reject(new DecisionEngineError('queue_full'));
    return new Promise((resolve, reject) => {
      const cleanup: (() => void)[] = [];
      const finish = () => {
        if (job.settled) return false;
        job.settled = true;
        for (const off of cleanup.splice(0)) off();
        return true;
      };
      const job: Job = {
        input: snapshot,
        options: { ...options },
        settled: false,
        resolve: (value) => {
          if (finish()) resolve(value);
        },
        reject: (error) => {
          if (finish()) reject(error);
        },
      };
      this.waiting.push(job);
      cleanup.push(this.after(options.deadlineMs - this.now(), () => this.cancel(job, 'timeout')));
      if (options.signal) {
        const cancel = () => this.cancel(job, 'cancelled');
        options.signal.addEventListener('abort', cancel, { once: true });
        cleanup.push(() => options.signal?.removeEventListener('abort', cancel));
      }
      if (options.cancellation) {
        const off = options.cancellation.onCancel(() => this.cancel(job, 'cancelled'));
        if (job.settled) off();
        else cleanup.push(off);
      }
      this.pump();
    });
  }

  private input(input: DecisionInput): DecisionInput {
    if (
      !input ||
      (input.op !== 'effort' && input.op !== 'meeting') ||
      typeof input.prompt !== 'string' ||
      !input.prompt.trim()
    )
      throw new DecisionEngineError('invalid_request');
    if (
      input.inputBudget !== undefined &&
      (!Number.isSafeInteger(input.inputBudget) ||
        input.inputBudget <= 128 ||
        input.inputBudget > this.options.contextTokens - (input.op === 'meeting' ? 24 : 0))
    )
      throw new DecisionEngineError('invalid_budget');
    const common = {
      prompt: input.prompt,
      ...(input.inputBudget === undefined ? {} : { inputBudget: input.inputBudget }),
    };
    if (input.op === 'effort') return { ...common, op: 'effort' };
    if (
      !Array.isArray(input.participantIds) ||
      input.participantIds.length === 0 ||
      input.participantIds.length > 32 ||
      input.participantIds.some(
        (id) => typeof id !== 'string' || id === 'NONE' || !/^[A-Za-z0-9_-]{1,64}$/.test(id),
      ) ||
      new Set(input.participantIds).size !== input.participantIds.length
    )
      throw new DecisionEngineError('invalid_request');
    return { ...common, op: 'meeting', participantIds: [...input.participantIds] };
  }

  private cancel(job: Job, code: 'cancelled' | 'timeout') {
    if (job.settled) return;
    const index = this.waiting.indexOf(job);
    if (index >= 0) this.waiting.splice(index, 1);
    job.reject(new DecisionEngineError(code));
    if (this.active === job) void this.stopOwned(code).catch(() => {});
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.state = 'closed';
    this.rejectAll('closed');
    this.closing = this.terminationFailed
      ? Promise.reject(new DecisionEngineError('helper_failed'))
      : this.stopOwned('closed');
    return this.closing;
  }

  private rejectAll(code: DecisionErrorCode) {
    this.active?.reject(new DecisionEngineError(code));
    for (const job of this.waiting.splice(0)) job.reject(new DecisionEngineError(code));
  }

  private stopOwned(code: DecisionErrorCode): Promise<void> {
    if (this.stopping) return this.stopping;
    const owner = this.owner;
    if (!owner) return Promise.resolve();
    this.owner = null;
    this.actualBackend = null;
    owner.stopTimer();
    owner.loaded.reject(new DecisionEngineError(code));
    if (this.wire?.owner === owner) {
      this.wire.result.reject(new DecisionEngineError(code));
      this.wire = null;
    }
    if (!this.closed && this.state !== 'error') this.state = 'stopping';
    const stopping = (async () => {
      try {
        if (!owner.exited) await owner.process.kill();
      } catch {
        // Without confirmed termination another process must not be launched.
        this.terminationFailed = true;
        this.error = 'helper_failed';
        if (!this.closed) this.state = 'error';
        this.rejectAll('helper_failed');
        throw new DecisionEngineError('helper_failed');
      }
    })().finally(() => {
      if (this.stopping === stopping) this.stopping = null;
      if (this.state === 'stopping') this.state = 'idle';
      this.pump();
    });
    this.stopping = stopping;
    return stopping;
  }

  private fail(owner: OwnedHelper, code: DecisionErrorCode) {
    if (this.owner !== owner || this.closed) return;
    this.state = 'error';
    this.error = code;
    this.failedUntil = this.now() + (this.options.retryDelayMs ?? 60_000);
    this.rejectAll(code);
    void this.stopOwned(code).catch(() => {});
  }

  private ensureStarted(): Promise<void> {
    const code = this.unavailable();
    if (code) return Promise.reject(new DecisionEngineError(code));
    if (this.stopping) return this.stopping.then(() => this.ensureStarted());
    if (this.isReady()) return Promise.resolve();
    if (this.starting) return this.starting;
    this.state = 'starting';
    this.error = null;
    const starting = this.start().finally(() => {
      if (this.starting === starting) this.starting = null;
    });
    this.starting = starting;
    return starting;
  }

  private async start() {
    let owner: OwnedHelper | undefined;
    try {
      const process = (this.options.launch ?? spawnHelper)(this.options.command);
      owner = {
        process,
        loaded: deferred<void>(),
        hasLoaded: false,
        exited: false,
        stopTimer: () => {},
      };
      this.owner = owner;
      const current = owner;
      owner.stopTimer = this.after(this.options.startupTimeoutMs ?? 60_000, () =>
        this.fail(current, 'startup_timeout'),
      );
      process.onLine((line) => this.onLine(current, line));
      process.onExit(() => {
        current.exited = true;
        this.fail(current, 'helper_failed');
      });
      await owner.loaded.promise;
      if (this.owner !== owner || this.closed)
        throw new DecisionEngineError(this.closed ? 'closed' : 'cancelled');
      this.state = 'warming';
      for (const input of this.warmup) await this.exchange(owner, input);
      if (this.owner !== owner || this.closed)
        throw new DecisionEngineError(this.closed ? 'closed' : 'cancelled');
      owner.stopTimer();
      this.state = 'ready';
      this.pump();
    } catch (error) {
      const code = error instanceof DecisionEngineError ? error.code : 'startup_failed';
      if (owner) this.fail(owner, code);
      else if (!this.closed) {
        this.state = 'error';
        this.error = code;
        this.failedUntil = this.now() + (this.options.retryDelayMs ?? 60_000);
        this.rejectAll(code);
      }
      if (this.stopping) await this.stopping;
      throw new DecisionEngineError(code);
    }
  }

  private onLine(owner: OwnedHelper, line: string) {
    if (this.owner !== owner || this.closed) return;
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      message = parsed as Record<string, unknown>;
    } catch {
      this.fail(owner, 'invalid_response');
      return;
    }
    if (!owner.hasLoaded) {
      if (
        message.type !== 'ready' ||
        message.protocol !== 1 ||
        message.backend !== this.options.backend
      ) {
        this.fail(owner, message.type === 'error' ? 'startup_failed' : 'invalid_response');
        return;
      }
      owner.hasLoaded = true;
      this.actualBackend = this.options.backend;
      this.state = 'loaded';
      owner.loaded.resolve();
      return;
    }
    const pending = this.wire;
    if (!pending || pending.owner !== owner || message.id !== pending.id) return;
    if (message.type === 'error' && message.error === 'inference_failed') {
      this.fail(owner, 'helper_failed');
      return;
    }
    this.wire = null;
    if (message.type === 'error') {
      const code = INPUT_ERRORS.has(message.error as DecisionErrorCode)
        ? (message.error as DecisionErrorCode)
        : 'invalid_response';
      pending.result.reject(new DecisionEngineError(code));
      return;
    }
    try {
      pending.result.resolve(this.result(pending.input, message));
    } catch {
      pending.result.reject(new DecisionEngineError('invalid_response'));
    }
  }

  private exchange(owner: OwnedHelper, input: DecisionInput): Promise<DecisionResult> {
    if (this.owner !== owner || this.wire)
      return Promise.reject(new DecisionEngineError('unavailable'));
    const pending: WireRequest = {
      owner,
      input,
      id: this.nextId++,
      result: deferred<DecisionResult>(),
    };
    this.wire = pending;
    try {
      owner.process.write(JSON.stringify({ ...input, id: pending.id }));
    } catch {
      this.fail(owner, 'helper_failed');
    }
    return pending.result.promise;
  }

  private result(input: DecisionInput, message: Record<string, unknown>): DecisionResult {
    const original = message.originalPromptTokens;
    const used = message.usedPromptTokens;
    const budget = input.inputBudget ?? null;
    if (
      message.type !== 'result' ||
      !Number.isSafeInteger(original) ||
      !Number.isSafeInteger(used) ||
      (used as number) < 1 ||
      (original as number) < (used as number) ||
      message.promptTokens !== used ||
      (used as number) > this.options.contextTokens - (input.op === 'meeting' ? 24 : 0) ||
      message.inputBudget !== budget ||
      message.inputTruncated !== (original !== used) ||
      (budget !== null && (used as number) > budget) ||
      (original !== used && (budget === null || used !== budget)) ||
      message.inputTokenFingerprintAlgorithm !== 'fnv1a64-le-u32' ||
      typeof message.inputTokenFingerprint !== 'string' ||
      !/^[0-9a-f]{16}$/.test(message.inputTokenFingerprint)
    )
      throw new DecisionEngineError('invalid_response');
    const metadata: DecisionInputMetadata = {
      originalPromptTokens: original as number,
      usedPromptTokens: used as number,
      inputBudget: budget,
      inputTruncated: original !== used,
      inputTokenFingerprint: message.inputTokenFingerprint,
      inputTokenFingerprintAlgorithm: 'fnv1a64-le-u32',
    };
    const common = { ...metadata, release: this.options.release, backend: this.options.backend };
    if (input.op === 'meeting') {
      const ids = message.participantIds;
      if (
        !Array.isArray(ids) ||
        ids.some((id) => typeof id !== 'string' || !input.participantIds.includes(id)) ||
        new Set(ids).size !== ids.length
      )
        throw new DecisionEngineError('invalid_response');
      return { ...common, op: 'meeting', participantIds: [...ids] as string[] };
    }
    const scores = (value: unknown): FourScores => {
      if (
        !Array.isArray(value) ||
        value.length !== 4 ||
        value.some((score) => typeof score !== 'number' || !Number.isFinite(score))
      )
        throw new DecisionEngineError('invalid_response');
      return [...value] as [number, number, number, number];
    };
    const logits = scores(message.logits);
    const probabilities = scores(message.probabilities);
    const level = LEVELS[logits.indexOf(Math.max(...logits))];
    if (!level) throw new DecisionEngineError('invalid_response');
    const weights = logits.map((score) => Math.exp(score - Math.max(...logits)));
    const total = weights.reduce((sum, score) => sum + score, 0);
    if (
      message.level !== level ||
      probabilities.some((score) => score < 0 || score > 1) ||
      Math.abs(probabilities.reduce((sum, score) => sum + score, 0) - 1) > 1e-6 ||
      probabilities.some((score, index) => {
        const weight = weights[index];
        return weight === undefined || Math.abs(score - weight / total) > 1e-6;
      })
    )
      throw new DecisionEngineError('invalid_response');
    return { ...common, op: 'effort', level, logits, probabilities };
  }

  private pump() {
    if (this.closed || this.active || this.stopping || this.waiting.length === 0) return;
    const code = this.unavailable();
    if (code) {
      this.rejectAll(code);
      return;
    }
    if (!this.isReady()) {
      void this.ensureStarted().catch((error) => {
        const code = error instanceof DecisionEngineError ? error.code : 'startup_failed';
        for (const job of this.waiting.splice(0)) job.reject(new DecisionEngineError(code));
      });
      return;
    }
    const effort = this.waiting.findIndex((job) => job.input.op === 'effort');
    const job = this.waiting.splice(effort < 0 ? 0 : effort, 1)[0];
    const owner = this.owner;
    if (!job || !owner) return;
    if (
      job.options.signal?.aborted ||
      job.options.cancellation?.aborted ||
      job.options.deadlineMs <= this.now()
    ) {
      job.reject(
        new DecisionEngineError(job.options.deadlineMs <= this.now() ? 'timeout' : 'cancelled'),
      );
      this.pump();
      return;
    }
    this.active = job;
    void this.exchange(owner, job.input)
      .then((result) => {
        if (job.options.signal?.aborted || job.options.cancellation?.aborted)
          this.cancel(job, 'cancelled');
        else if (job.options.deadlineMs <= this.now()) this.cancel(job, 'timeout');
        else job.resolve(result);
      })
      .catch((error: Error) => job.reject(error))
      .finally(() => {
        if (this.active === job) this.active = null;
        this.pump();
      });
  }
}
