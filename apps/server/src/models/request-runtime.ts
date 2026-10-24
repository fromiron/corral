import { createHash, randomUUID } from 'node:crypto';
import { ContextMeter, requestOutputCap } from '@corral/adapter-pi';
import { cancellableDelay, providerFailure } from '@corral/adapter-pi/request-policy';
import type {
  DecisionCancellation,
  ModelAttempt,
  ModelAttemptStore,
  ModelRequestIntent,
} from '@corral/contracts';
import { accountModelStream } from '@corral/pi-runtime-port';
import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Model,
  type Models,
  normalizeContext,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai';

export function cancellationFromSignal(signal: AbortSignal): DecisionCancellation {
  return {
    get aborted() {
      return signal.aborted;
    },
    onCancel(fn) {
      signal.addEventListener('abort', fn, { once: true });
      if (signal.aborted) fn();
      return () => signal.removeEventListener('abort', fn);
    },
  };
}
export interface RequestRuntimeOptions {
  store: ModelAttemptStore;
  onUsage?(intent: ModelRequestIntent): void;
  acquire(signal: DecisionCancellation): Promise<() => void>;
  adopt?(intent: ModelRequestIntent): {
    release(): void;
    queueWaitMs?: number;
    lateUsage(
      usage: import('@corral/contracts').ModelUsage,
      rawUsage: Record<string, unknown>,
    ): Promise<void>;
  };
  now?: () => Date;
  newId?: () => string;
}
/** Owns physical provider observations; domain completion remains with Coordinator. */
export class ModelRequestRuntime {
  private readonly options: RequestRuntimeOptions;
  private readonly cooldowns = new Map<string, number>();
  constructor(options: RequestRuntimeOptions) {
    this.options = options;
  }
  retryAfterMs(provider: string) {
    const remaining =
      (this.cooldowns.get(provider) ?? 0) - (this.options.now?.() ?? new Date()).getTime();
    if (remaining <= 0) this.cooldowns.delete(provider);
    return Math.max(0, remaining);
  }
  chooserUsage(requestId: string) {
    const attempts = this.options.store
      .list(requestId)
      .filter(
        (attempt) =>
          attempt.intent.owner.kind === 'chooser' &&
          attempt.intent.requestId === requestId &&
          attempt.prepared,
      );
    if (!attempts.length) return null;
    const usage = { inputTokens: 0, outputTokens: 0 };
    for (const attempt of attempts) {
      const { inputTokens, outputTokens } = attempt.usage;
      if (inputTokens === null || outputTokens === null) return null;
      usage.inputTokens += inputTokens;
      usage.outputTokens += outputTokens;
    }
    return usage;
  }
  stream(
    models: Pick<Models, 'streamSimple'>,
    model: Model<string>,
    context: Parameters<Models['streamSimple']>[1],
    intent: ModelRequestIntent,
    options: SimpleStreamOptions = {},
    admitted = false,
    billing?: { subscription: boolean; rates?: Model<string>['cost'] },
    snapshot?: import('@corral/contracts').ModelProfileSnapshot,
    meter = new ContextMeter(),
    onDispatch?: () => () => void,
  ) {
    const out = createAssistantMessageEventStream();
    const now = () => (this.options.now?.() ?? new Date()).toISOString();
    const signal = options.signal ?? new AbortController().signal;
    const normalizedContext = normalizeContext(context);
    const attempt: ModelAttempt = {
      version: 2,
      attemptId: this.options.newId?.() ?? randomUUID(),
      intent,
      provider: model.provider,
      modelId: model.id,
      startedAt: now(),
      endedAt: null,
      status: 'started',
      payloadHash: null,
      payloadBytes: null,
      firstEventAt: null,
      failure: null,
      usage: {
        version: 2,
        inputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        source: 'unknown',
        costStatus: billing?.subscription ? 'subscription' : 'unknown',
        costUsd: null,
      },
    };
    const save = () => this.options.store.put(attempt);
    let lease: ReturnType<NonNullable<RequestRuntimeOptions['adopt']>> | undefined;
    let providerReportedUsage = false;
    const observe = async (message: AssistantMessage) => {
      const u = message.usage;
      if (providerReportedUsage) Object.assign(u, { corralReported: true });
      const reported =
        providerReportedUsage ||
        u.input + u.output + u.cacheRead + u.cacheWrite > 0 ||
        u.totalTokens > 0;
      if (reported)
        attempt.usage = {
          ...attempt.usage,
          source: 'reported',
          inputTokens: u.input + u.cacheRead + u.cacheWrite,
          outputTokens: u.output,
          reasoningTokens: u.reasoning ?? null,
          cacheReadTokens: u.cacheRead,
          cacheWriteTokens: u.cacheWrite,
        };
      if (reported && billing?.rates && !billing.subscription) {
        const rates = billing.rates;
        if (
          [rates.input, rates.output, rates.cacheRead, rates.cacheWrite].every(
            (rate) => Number.isFinite(rate) && rate >= 0,
          )
        ) {
          attempt.usage.costStatus = 'estimated';
          attempt.usage.pricing = {
            source: 'pi-ai-1.3.0-catalog',
            usdPerMillion: {
              input: rates.input,
              output: rates.output,
              cacheRead: rates.cacheRead,
              cacheWrite: rates.cacheWrite,
            },
          };
          attempt.usage.costUsd =
            (u.input * rates.input +
              u.output * rates.output +
              u.cacheRead * rates.cacheRead +
              u.cacheWrite * rates.cacheWrite) /
            1_000_000;
        }
      }
      attempt.endedAt = now();
      attempt.status = signal.aborted
        ? 'cancelled'
        : message.stopReason === 'error'
          ? 'failed'
          : message.stopReason === 'aborted'
            ? 'cancelled'
            : ['pending', 'deferred'].includes(message.stopReason)
              ? 'unknown'
              : 'completed';
      if (message.content.length) attempt.firstEventAt ??= now();
      if (message.stopReason === 'error')
        attempt.failure = providerFailure(message.errorMessage ?? '', response);
      if (attempt.failure?.code === 'RATE_LIMIT' && attempt.failure.retryAfterMs)
        this.cooldowns.set(
          model.provider,
          (this.options.now?.() ?? new Date()).getTime() +
            Math.max(this.retryAfterMs(model.provider), attempt.failure.retryAfterMs),
        );
      save();
      this.options.onUsage?.(intent);
      meter.observe(normalizedContext, model, message);
      if (signal.aborted && reported)
        await lease?.lateUsage(
          {
            inputTokens: attempt.usage.inputTokens,
            outputTokens: attempt.usage.outputTokens,
            cachedInputTokens: attempt.usage.cacheReadTokens,
            reasoningTokens: attempt.usage.reasoningTokens,
          },
          { ...u },
        );
    };
    let response: { status: number; headers: Headers } | undefined;
    void (async () => {
      let release: (() => void) | undefined;
      let finishRequest: (() => void) | undefined;
      let ended = false;
      const releaseOnce = () => {
        const held = release;
        release = undefined;
        held?.();
      };
      const terminate = (code: string) => {
        if (ended) return;
        ended = true;
        const message: AssistantMessage = {
          role: 'assistant',
          api: model.api,
          provider: model.provider,
          model: model.id,
          content: [],
          timestamp: Date.now(),
          stopReason: signal.aborted ? 'aborted' : 'error',
          errorMessage: code,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        };
        out.push({ type: 'error', reason: signal.aborted ? 'aborted' : 'error', error: message });
        out.end(message);
      };
      const aborted = () => {
        attempt.status = 'cancelled';
        attempt.endedAt = now();
        try {
          save();
        } catch {
          terminate('STORAGE_ERROR');
        } finally {
          terminate('CANCELLED');
        }
      };
      try {
        const queuedAt = (this.options.now?.() ?? new Date()).getTime();
        if (admitted) {
          lease = this.options.adopt?.(intent);
          release = lease?.release;
        } else {
          for (;;) {
            const wait = this.retryAfterMs(model.provider);
            if (wait && !(await cancellableDelay(wait, signal))) signal.throwIfAborted();
            release = await this.options.acquire(cancellationFromSignal(signal));
            if (!this.retryAfterMs(model.provider)) break;
            releaseOnce();
          }
        }
        signal.throwIfAborted();
        attempt.queueWaitMs =
          lease?.queueWaitMs ??
          Math.max(0, (this.options.now?.() ?? new Date()).getTime() - queuedAt);
        const measured = meter.measure(normalizedContext, model);
        const estimatedInputTokens = measured.tokens;
        const outputAllowance = requestOutputCap(
          model,
          options.maxTokens ?? model.maxTokens,
          estimatedInputTokens,
        );
        attempt.policy = {
          version: 2,
          provider: model.provider,
          modelId: model.id,
          api: model.api,
          contextWindow: model.contextWindow,
          maxOutputTokens: model.maxTokens,
          cacheRetention: options.cacheRetention ?? 'short',
          maxRetries: 2,
          providerRetries: 0,
          ...(snapshot
            ? {
                profileId: snapshot.profile,
                auth: snapshot.auth,
                ...(snapshot.endpointHash ? { endpointHash: snapshot.endpointHash } : {}),
                ...(snapshot.contextPolicy
                  ? { configRevision: snapshot.contextPolicy.configRevision }
                  : {}),
                ...(snapshot.cachePolicy ? { cacheSource: snapshot.cachePolicy.source } : {}),
              }
            : {}),
        };
        save();
        signal.addEventListener('abort', aborted, { once: true });
        finishRequest = onDispatch?.();
        const stream = accountModelStream(
          models.streamSimple(model, normalizedContext, {
            ...options,
            toolChoice: intent.purpose === 'compaction' ? 'none' : options.toolChoice,
            maxRetries: 0,
            maxTokens: outputAllowance,
            fetch: async (input, init) => {
              const received = await (options.fetch ?? globalThis.fetch)(input, init);
              response = { status: received.status, headers: new Headers(received.headers) };
              return received;
            },
            onProviderStreamEvent: async (data, selected) => {
              if (data && typeof data === 'object') {
                const event = data as {
                  usage?: Record<string, unknown>;
                  response?: { usage?: Record<string, unknown> };
                  message?: { usage?: Record<string, unknown> };
                  usageMetadata?: Record<string, unknown>;
                  metadata?: { usage?: Record<string, unknown> };
                };
                const usage =
                  event.usage ??
                  event.response?.usage ??
                  event.message?.usage ??
                  event.usageMetadata ??
                  event.metadata?.usage;
                if (usage && typeof usage === 'object') {
                  const input =
                    usage.prompt_tokens ??
                    usage.input_tokens ??
                    usage.promptTokenCount ??
                    usage.inputTokens;
                  const output =
                    usage.completion_tokens ??
                    usage.output_tokens ??
                    usage.candidatesTokenCount ??
                    usage.outputTokens;
                  if (
                    Number.isSafeInteger(input) &&
                    Number(input) >= 0 &&
                    Number.isSafeInteger(output) &&
                    Number(output) >= 0
                  )
                    providerReportedUsage = true;
                }
              }
              await options.onProviderStreamEvent?.(data, selected);
            },
            onPayload: async (payload, selected) => {
              const prepared = (await options.onPayload?.(payload, selected)) ?? payload;
              const serialized = JSON.stringify(prepared);
              attempt.payloadHash = createHash('sha256').update(serialized).digest('hex');
              attempt.payloadBytes = Buffer.byteLength(serialized);
              attempt.prepared = {
                inputRevision: intent.revision,
                inputHash: attempt.payloadHash,
                estimatedInputTokens,
                measurement:
                  measured.source === 'usage_anchor' ? 'usage-anchor-v2' : 'dsh-density-v2',
                outputAllowance,
                cacheNamespace: options.sessionId ?? null,
              };
              save();
              return prepared;
            },
            onResponse: async (received, selected) => {
              response = { status: received.status, headers: new Headers(received.headers) };
              await options.onResponse?.(received, selected);
            },
          }),
          observe,
        );
        for await (const event of stream) {
          if ('delta' in event || event.type === 'done') attempt.firstEventAt ??= now();
          if (!ended)
            out.push(
              event.type === 'error'
                ? {
                    ...event,
                    error: {
                      ...event.error,
                      errorMessage: JSON.stringify(
                        providerFailure(event.error.errorMessage ?? '', response),
                      ),
                    },
                  }
                : event,
            );
        }
        const result = await stream.result();
        if (!ended) {
          ended = true;
          out.end(result);
        }
      } catch (error) {
        attempt.status = signal.aborted ? 'cancelled' : attempt.payloadHash ? 'unknown' : 'failed';
        attempt.endedAt = now();
        attempt.failure = providerFailure(error, response);
        try {
          save();
        } catch {
          terminate('STORAGE_ERROR');
        }
        terminate(JSON.stringify(attempt.failure));
      } finally {
        signal.removeEventListener('abort', aborted);
        finishRequest?.();
        releaseOnce();
      }
    })();
    return out;
  }
}
