import { canonicalJson, ReasoningResolution } from '@corral/contracts';
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
import { reasoningRequest } from './reasoning.ts';
import { providerRequestFence } from './request-fence.ts';

const LIMIT = 16 * 1024 * 1024;
const id = z.string().regex(/^stream_[1-9][0-9]{0,5}$/);
const Request = z.discriminatedUnion('type', [
  z.strictObject({
    bridge: z.literal('model'),
    type: z.literal('request'),
    id,
    context: z.strictObject({ messages: z.array(z.record(z.string(), z.unknown())).max(10_000) }),
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
  reasoning: ReasoningResolution.optional(),
});
const isBridge = (frame: unknown): frame is Record<string, unknown> =>
  Boolean(frame && typeof frame === 'object' && (frame as { bridge?: unknown }).bridge === 'model');

export interface ModelBroker {
  model: Model<Api>;
  streamFn: StreamFn;
}

/** The only network capability exposed to an isolated worker: one fixed-model stream per permit. */
export function modelBridgeChannel(channel: Channel, options: ModelBroker): Channel {
  let permit: z.infer<typeof Permit> | null = null;
  let active: { id: string; abort: AbortController; payload?: (accepted: boolean) => void } | null =
    null;
  let stopped = false;
  const seen = new Set<string>();
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
    if (JSON.stringify(raw).length > LIMIT) return fail();
    const parsed = Request.safeParse(raw);
    if (!parsed.success) return fail();
    const frame = parsed.data;
    if (frame.type === 'payload_ack') {
      if (active?.id !== frame.id && seen.has(frame.id)) return;
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
    if (!permit || active || seen.has(frame.id) || seen.size >= 100) return fail();
    seen.add(frame.id);
    const allowed = permit;
    permit = null;
    const request = { id: frame.id, abort: new AbortController() };
    active = request;
    const send = (body: Record<string, unknown>) => {
      if (stopped) return;
      const value = { bridge: 'model', id: frame.id, ...body };
      if (JSON.stringify(value).length > LIMIT) {
        fail();
        return;
      }
      channel.send(value);
    };
    void (async () => {
      try {
        const fence = providerRequestFence(options.model, undefined, request.abort.signal);
        // No worker-provided URL, headers, key, output limit or provider-specific options.
        const resolved = reasoningRequest(
          options.model,
          {
            apiKey: allowed.apiKey ?? undefined,
            maxTokens: allowed.maxOutputTokens,
            maxRetries: 0,
            ...(fence ? { fetch: fence.fetch, transport: 'sse' as const } : {}),
            signal: request.abort.signal,
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
        const stream = await options.streamFn(
          resolved.model,
          normalizeContext({ messages: frame.context.messages as Message[] }),
          resolved.options,
        );
        for await (const event of stream) {
          // Provider exceptions can include authentication headers; never pass diagnostic bodies.
          send({
            type: 'event',
            event:
              event.type === 'error'
                ? { ...event, error: { ...event.error, errorMessage: 'provider request failed' } }
                : event,
          });
        }
        send({ type: 'end' });
      } catch {
        send({ type: 'failed' });
      } finally {
        active = null;
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
      cleanup(): void;
    }
  >();
  const fail = (entry: NonNullable<ReturnType<typeof pending.get>>) => {
    const error = {
      role: 'assistant' as const,
      content: [],
      api: entry.model.api,
      provider: entry.model.provider,
      model: entry.model.id,
      timestamp: Date.now(),
      stopReason: 'error' as const,
      errorMessage: 'host model stream failed',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    entry.stream.push({ type: 'error', reason: 'error', error });
    entry.stream.end(error);
  };
  channel.onFrame((raw) => {
    if (!isBridge(raw)) {
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
    } else if (raw.type === 'event') entry.stream.push(raw.event as AssistantMessageEvent);
    else if (raw.type === 'end' || raw.type === 'failed') {
      if (raw.type === 'failed') fail(entry);
      else entry.stream.end();
      entry.cleanup();
      pending.delete(String(raw.id));
    }
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
      const abort = () => channel.send({ bridge: 'model', type: 'cancel', id: streamId });
      pending.set(streamId, {
        model,
        options,
        stream,
        cleanup: () => options?.signal?.removeEventListener('abort', abort),
      });
      options?.signal?.addEventListener('abort', abort, { once: true });
      channel.send({ bridge: 'model', type: 'request', id: streamId, context });
      if (options?.signal?.aborted) abort();
      return stream;
    },
  };
}
