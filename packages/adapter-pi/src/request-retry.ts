import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  type Model,
} from '@earendil-works/pi-ai';
import { cancellableDelay, providerFailure, retryDelay } from './ported/dsh/retry.ts';

/** Each open obtains a new host permit; only the final attempt reaches the agent loop. */
export function managedRetryStream(options: {
  model: Pick<Model<string>, 'id' | 'provider' | 'api'>;
  open(attempt: number): Promise<AssistantMessageEventStream> | AssistantMessageEventStream;
  signal: AbortSignal;
  beforeRetry?(message: AssistantMessage): void | Promise<void>;
  onContextOverflow?(): Promise<boolean> | boolean;
  random?: () => number;
  delay?: (ms: number, signal: AbortSignal) => Promise<boolean>;
}) {
  const out = createAssistantMessageEventStream();
  void (async () => {
    let contextRecovered = false;
    for (let attempt = 0; ; attempt++) {
      const stream = await options.open(attempt);
      let partial = false;
      let terminal:
        | Extract<import('@earendil-works/pi-ai').AssistantMessageEvent, { type: 'done' | 'error' }>
        | undefined;
      for await (const event of stream) {
        if (event.type === 'done' || event.type === 'error') terminal = event;
        else {
          if ('delta' in event && event.delta.length) partial = true;
          out.push(event);
        }
      }
      const message = await stream.result();
      if (
        message.stopReason === 'error' &&
        !partial &&
        !options.signal.aborted &&
        !contextRecovered &&
        attempt < 2 &&
        options.onContextOverflow &&
        providerFailure(message.errorMessage ?? '').code === 'CONTEXT_OVERFLOW'
      ) {
        await options.beforeRetry?.(message);
        contextRecovered = true;
        if (await options.onContextOverflow()) continue;
      }
      const delay =
        message.stopReason === 'error' && !partial && !options.signal.aborted
          ? retryDelay(
              providerFailure(message.errorMessage ?? ''),
              attempt,
              options.random ?? Math.random,
            )
          : null;
      if (delay === null) {
        out.push(
          terminal ??
            (message.stopReason === 'error' || message.stopReason === 'aborted'
              ? { type: 'error', reason: message.stopReason, error: message }
              : {
                  type: 'done',
                  reason: message.stopReason === 'pending' ? 'deferred' : message.stopReason,
                  message,
                }),
        );
        out.end(message);
        return;
      }
      await options.beforeRetry?.(message);
      if (!(await (options.delay ?? cancellableDelay)(delay, options.signal))) {
        const aborted = { ...message, stopReason: 'aborted' as const, errorMessage: 'CANCELLED' };
        out.push({ type: 'error', reason: 'aborted', error: aborted });
        out.end(aborted);
        return;
      }
    }
  })().catch(() => {
    const message: AssistantMessage = {
      role: 'assistant',
      content: [],
      api: options.model.api,
      provider: options.model.provider,
      model: options.model.id,
      timestamp: Date.now(),
      stopReason: options.signal.aborted ? 'aborted' : 'error',
      errorMessage: 'managed request failed',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    out.push({
      type: 'error',
      reason: options.signal.aborted ? 'aborted' : 'error',
      error: message,
    });
    out.end(message);
  });
  return out;
}
