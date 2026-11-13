import {
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  type Model,
} from '@earendil-works/pi-ai';
import { cancellableDelay, providerFailure, retryDelay } from './ported/dsh/retry.ts';

/**
 * A cut response can be asked for again only while it has shown the consumer nothing that
 * a repeat would duplicate: reasoning and whitespace-only text have not answered yet, while
 * body text, a tool call (even just begun) or an image would be repeated or re-executed.
 */
export function isReplaySafe(partial: Pick<AssistantMessage, 'content'>): boolean {
  return partial.content.every(
    (block) => block.type === 'thinking' || (block.type === 'text' && block.text.trim() === ''),
  );
}

/**
 * The text fragments one call streams to the host, shared by both workers. Whitespace before
 * the response has shown anything waits and goes out, fragment by fragment, just before what
 * it shows first (text or a tool call). A response that ends whole sends what still waits; one
 * that ends unfinished before showing anything sends nothing. Empty fragments are never sent.
 */
export function streamedText(send: (text: string) => void) {
  let waiting: string[] | null = [];
  const release = () => {
    const pending = waiting ?? [];
    waiting = null;
    for (const text of pending) send(text);
  };
  return {
    event(event: AssistantMessageEvent) {
      if (event.type === 'done' || event.type === 'error') return;
      if (waiting && !isReplaySafe(event.partial)) release();
      if (event.type !== 'text_delta' || !event.delta) return;
      if (waiting) waiting.push(event.delta);
      else send(event.delta);
    },
    /** The call ended; `whole` when its response is a confirmed one. */
    end(whole: boolean) {
      if (whole) release();
      waiting = null;
    },
  };
}

/**
 * The wait before a failed attempt is asked for again, or null when it is not (context-overflow
 * recovery aside). `responseStarted` says whether the attempt sent any event before it ended.
 */
export function retryDelayAfter(
  message: AssistantMessage,
  attempt: number,
  responseStarted: boolean,
  random: () => number = Math.random,
): number | null {
  if (message.stopReason !== 'error' || !isReplaySafe(message)) return null;
  return retryDelay(
    providerFailure(message.errorMessage ?? '', undefined, { responseStarted }),
    attempt,
    random,
  );
}

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
      // Events stay held while the attempt is replay-safe, so a retry leaves no trace in the consumer.
      let held: AssistantMessageEvent[] | null = [];
      let terminal: Extract<AssistantMessageEvent, { type: 'done' | 'error' }> | undefined;
      let responseStarted = false;
      for await (const event of stream) {
        if (event.type === 'done' || event.type === 'error') {
          terminal = event;
          continue;
        }
        responseStarted = true;
        if (held) {
          held.push(event);
          if (!isReplaySafe(event.partial)) {
            for (const heldEvent of held) out.push(heldEvent);
            held = null;
          }
        } else out.push(event);
      }
      const message = await stream.result();
      const failure = () =>
        providerFailure(message.errorMessage ?? '', undefined, { responseStarted });
      const replaySafe = held !== null && isReplaySafe(message);
      if (
        message.stopReason === 'error' &&
        replaySafe &&
        !options.signal.aborted &&
        !contextRecovered &&
        attempt < 2 &&
        options.onContextOverflow &&
        failure().code === 'CONTEXT_OVERFLOW'
      ) {
        await options.beforeRetry?.(message);
        contextRecovered = true;
        if (await options.onContextOverflow()) continue;
      }
      const delay =
        held !== null && !options.signal.aborted
          ? retryDelayAfter(message, attempt, responseStarted, options.random)
          : null;
      if (delay === null) {
        for (const heldEvent of held ?? []) out.push(heldEvent);
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
