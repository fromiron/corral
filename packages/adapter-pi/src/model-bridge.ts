import { canonicalJson, ReasoningResolution } from '@corral/contracts';
import {
  createStreamCoalescer,
  createStreamDecoder,
  type WireStreamEvent,
} from '@corral/pi-runtime-port';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import {
  type Api,
  type AssistantMessageEvent,
  createAssistantMessageEventStream,
  type Message,
  type Model,
  normalizeContext,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import { z } from 'zod';
import type { Channel } from './channel.ts';
import { providerFailure } from './ported/dsh/retry.ts';
import { reasoningRequest, requestOutputCap } from './reasoning.ts';
import { providerRequestFence } from './request-fence.ts';

const LIMIT = 16 * 1024 * 1024;
const id = z
  .string()
  .regex(/^stream_[1-9][0-9]{0,15}$/)
  .refine((value) => Number.isSafeInteger(Number(value.slice(7))));
const Request = z.discriminatedUnion('type', [
  z.strictObject({
    bridge: z.literal('model'),
    type: z.literal('request'),
    id,
    maxOutputTokens: z.int().positive().optional(),
    context: z.strictObject({ messages: z.array(z.record(z.string(), z.unknown())) }),
  }),
  z.strictObject({
    bridge: z.literal('model'),
    type: z.literal('payload_ack'),
    id,
    accepted: z.boolean(),
  }),
  z.strictObject({ bridge: z.literal('model'), type: z.literal('cancel'), id }),
]);
const Permit = z.object({
  modelCallId: z.string(),
  apiKey: z.string().nullable(),
  maxOutputTokens: z.int().positive(),
  logicalRequestId: z.string().min(1).max(120).optional(),
  retryIndex: z.int().min(0).max(2).optional(),
  sessionId: z.string().min(1).max(256).optional(),
  cacheRetention: z.enum(['none', 'short', 'long']).optional(),
  purpose: z.enum(['turn', 'retry', 'compaction', 'extension']).optional(),
  reasoning: ReasoningResolution.optional(),
});
const isBridge = (frame: unknown): frame is Record<string, unknown> =>
  Boolean(frame && typeof frame === 'object' && (frame as { bridge?: unknown }).bridge === 'model');

export interface ModelBroker {
  model: Model<Api>;
  streamFn: StreamFn;
  withPermit?: (permit: z.infer<typeof Permit>) => StreamFn;
}

/** The only network capability exposed to an isolated worker: one fixed-model stream per permit. */
export function modelBridgeChannel(channel: Channel, options: ModelBroker): Channel {
  let permit: z.infer<typeof Permit> | null = null;
  let active: { id: string; abort: AbortController; payload?: (accepted: boolean) => void } | null =
    null;
  let stopped = false;
  let lastSequence = 0;
  const handlers: ((frame: unknown) => void)[] = [];
  const stop = () => {
    stopped = true;
    permit = null;
    active?.abort.abort();
    active?.payload?.(false);
  };
  const fail = () => {
    stop();
    channel.kill();
  };
  channel.onExit(stop);
  channel.onFrame((raw) => {
    if (!isBridge(raw)) {
      for (const handler of handlers) handler(raw);
      return;
    }
    if (stopped) return;
    if (Buffer.byteLength(JSON.stringify(raw)) > LIMIT) return fail();
    const parsed = Request.safeParse(raw);
    if (!parsed.success) return fail();
    const frame = parsed.data;
    if (frame.type === 'payload_ack') {
      if (active?.id !== frame.id && Number(frame.id.slice(7)) <= lastSequence) return;
      if (active?.id !== frame.id || !active.payload) return fail();
      const resolve = active.payload;
      delete active.payload;
      resolve(frame.accepted);
      return;
    }
    if (frame.type === 'cancel') {
      if (active?.id === frame.id) {
        active.abort.abort();
        active.payload?.(false);
      }
      return;
    }
    const sequence = Number(frame.id.slice(7));
    if (!permit || active || sequence !== lastSequence + 1) return fail();
    lastSequence = sequence;
    const allowed = permit;
    permit = null;
    const request = { id: frame.id, abort: new AbortController() };
    active = request;
    let delivery = Promise.resolve();
    const send = (body: Record<string, unknown>) => {
      if (stopped) return;
      const value = { bridge: 'model', id: frame.id, ...body };
      if (Buffer.byteLength(JSON.stringify(value)) > LIMIT) {
        fail();
        return;
      }
      delivery = delivery.then(() =>
        channel.sendAsync ? channel.sendAsync(value) : channel.send(value),
      );
      void delivery.catch(fail);
    };
    void (async () => {
      let response: { status: number; headers: Headers } | undefined;
      try {
        const fence = providerRequestFence(options.model, undefined, request.abort.signal);
        // No worker-provided URL, headers, key, output limit or provider-specific options.
        const resolved = reasoningRequest(
          options.model,
          {
            apiKey: allowed.apiKey ?? undefined,
            maxTokens: requestOutputCap(
              options.model,
              Math.min(allowed.maxOutputTokens, frame.maxOutputTokens ?? allowed.maxOutputTokens),
            ),
            sessionId: allowed.sessionId,
            cacheRetention: allowed.cacheRetention,
            maxRetries: 0,
            ...(fence ? { fetch: fence.fetch, transport: 'sse' as const } : {}),
            signal: request.abort.signal,
            onResponse: (received) => {
              response = { status: received.status, headers: new Headers(received.headers) };
            },
            onPayload: async (payload) => {
              if (request.abort.signal.aborted || stopped) throw new Error('cancelled');
              const accepted = await new Promise<boolean>((resolve) => {
                if (!active || active.id !== request.id) {
                  resolve(false);
                  return;
                }
                active.payload = resolve;
                send({ type: 'payload', payload });
              });
              if (!accepted || request.abort.signal.aborted || stopped)
                throw new Error('provider payload refused');
              fence?.approve(payload);
              return payload;
            },
          },
          allowed.reasoning,
        );
        const stream = await (options.withPermit?.(allowed) ?? options.streamFn)(
          resolved.model,
          normalizeContext({ messages: frame.context.messages as Message[] }),
          resolved.options,
        );
        const coalescer = createStreamCoalescer((event) => send({ type: 'event', event }));
        let terminal: AssistantMessageEvent | undefined;
        try {
          for await (const event of stream) {
            // Provider exceptions can include authentication headers; never pass diagnostic bodies.
            const safeEvent =
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
                : event;
            if (safeEvent.type === 'done' || safeEvent.type === 'error') terminal = safeEvent;
            else coalescer.push(safeEvent);
            await delivery;
          }
        } finally {
          coalescer.dispose();
          await delivery;
        }
        // Pi settles result() on the terminal event, so allow the next permit before delivery.
        active = null;
        if (terminal) coalescer.push(terminal);
        send({ type: 'end' });
        await delivery;
      } catch (error) {
        if (active === request) active = null;
        send({ type: 'failed', failure: providerFailure(error, response) });
      } finally {
        if (active === request) active = null;
      }
    })();
  });
  return {
    send: (raw) => {
      const frame = raw as { type?: string };
      if (frame.type === 'permit') {
        if (permit || active) {
          fail();
          return;
        }
        permit = Permit.parse(raw);
        channel.send({ ...(raw as object), apiKey: null });
      } else {
        if (frame.type === 'cancel') stop();
        channel.send(raw);
      }
    },
    onFrame: (handler) => {
      handlers.push(handler);
    },
    onExit: (handler) => channel.onExit(handler),
    kill: () => {
      stop();
      channel.kill();
    },
  };
}

/** Preserve the ordinary worker protocol while routing provider I/O through its owning host. */
export function workerModelBridge(channel: Channel): {
  port: Channel;
  streamFn: (
    model: Model<string>,
    context: Parameters<StreamFn>[1],
    options?: SimpleStreamOptions,
  ) => ReturnType<typeof createAssistantMessageEventStream>;
} {
  const handlers: ((frame: unknown) => void)[] = [];
  let sequence = 0;
  const pending = new Map<
    string,
    {
      model: Model<string>;
      options?: SimpleStreamOptions;
      stream: ReturnType<typeof createAssistantMessageEventStream>;
      decode: ReturnType<typeof createStreamDecoder>;
      cleanup(): void;
    }
  >();
  const fail = (
    entry: NonNullable<ReturnType<typeof pending.get>>,
    failure?: unknown,
    reason: 'error' | 'aborted' = 'error',
  ) => {
    const error = {
      role: 'assistant' as const,
      content: [],
      api: entry.model.api,
      provider: entry.model.provider,
      model: entry.model.id,
      timestamp: Date.now(),
      stopReason: reason,
      errorMessage: failure ? JSON.stringify(failure) : 'host model stream failed',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    entry.stream.push({ type: 'error', reason, error });
    entry.stream.end(error);
  };
  channel.onFrame((raw) => {
    if (!isBridge(raw)) {
      if ((raw as { type?: string })?.type === 'cancel') {
        for (const entry of pending.values()) {
          fail(entry, { code: 'CANCELLED' }, 'aborted');
          entry.cleanup();
        }
        pending.clear();
      }
      for (const handler of handlers) handler(raw);
      return;
    }
    const entry = pending.get(String(raw.id));
    if (!entry) return;
    if (raw.type === 'payload') {
      void (async () => {
        let accepted = false;
        try {
          const before = canonicalJson(raw.payload);
          const returned = await entry.options?.onPayload?.(raw.payload, entry.model);
          accepted =
            !entry.options?.signal?.aborted && canonicalJson(returned ?? raw.payload) === before;
        } catch {
          /* A failed mandatory hook refuses the request. */
        }
        channel.send({ bridge: 'model', type: 'payload_ack', id: raw.id, accepted });
      })();
    } else if (raw.type === 'event') {
      try {
        entry.stream.push(entry.decode(raw.event as WireStreamEvent));
      } catch {
        fail(entry);
        entry.cleanup();
        pending.delete(String(raw.id));
        channel.kill();
      }
    } else if (raw.type === 'end' || raw.type === 'failed') {
      if (raw.type === 'failed') fail(entry, raw.failure);
      else entry.stream.end();
      entry.cleanup();
      pending.delete(String(raw.id));
    }
  });
  channel.onExit(() => {
    for (const entry of pending.values()) {
      fail(entry);
      entry.cleanup();
    }
    pending.clear();
  });
  return {
    port: {
      ...channel,
      onFrame: (handler) => {
        handlers.push(handler);
      },
    },
    streamFn: (model, context, options) => {
      const stream = createAssistantMessageEventStream(),
        streamId = `stream_${++sequence}`;
      const abort = () => {
        const entry = pending.get(streamId);
        if (!entry) return;
        fail(entry, { code: 'CANCELLED' }, 'aborted');
        entry.cleanup();
        pending.delete(streamId);
        channel.send({ bridge: 'model', type: 'cancel', id: streamId });
      };
      pending.set(streamId, {
        model,
        options,
        stream,
        decode: createStreamDecoder(),
        cleanup: () => options?.signal?.removeEventListener('abort', abort),
      });
      if (options?.signal?.aborted) {
        const entry = pending.get(streamId)!;
        fail(entry, { code: 'CANCELLED' }, 'aborted');
        pending.delete(streamId);
        return stream;
      }
      options?.signal?.addEventListener('abort', abort, { once: true });
      channel.send({
        bridge: 'model',
        type: 'request',
        id: streamId,
        context,
        ...(options?.maxTokens ? { maxOutputTokens: options.maxTokens } : {}),
      });
      return stream;
    },
  };
}
