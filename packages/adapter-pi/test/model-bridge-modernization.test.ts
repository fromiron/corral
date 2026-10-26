import { createStreamDecoder } from '@corral/pi-runtime-port';
import {
  type AssistantMessage,
  type AssistantMessageEvent,
  createAssistantMessageEventStream,
  createFauxCore,
  fauxAssistantMessage,
  normalizeContext,
} from '@earendil-works/pi-ai';
import { expect, it } from 'vitest';
import { memoryChannelPair } from '../src/channel.ts';
import { type ModelBroker, modelBridgeChannel, workerModelBridge } from '../src/model-bridge.ts';

const model = {
  ...createFauxCore({ provider: 'faux', models: [{ id: 'fixture', name: 'Fixture' }] }).models[0]!,
  maxTokens: 32,
};
const context = normalizeContext({ messages: [] });
function fixture(streamFn: ModelBroker['streamFn']) {
  const { host, worker } = memoryChannelPair();
  const frames: unknown[] = [];
  worker.onFrame((frame) => frames.push(structuredClone(frame)));
  const channel = modelBridgeChannel(host, { model, streamFn });
  const bridge = workerModelBridge(worker);
  let sequence = 0;
  return {
    channel,
    bridge,
    frames,
    async request() {
      channel.send({
        type: 'permit',
        modelCallId: `call_${++sequence}`,
        apiKey: 'private',
        maxOutputTokens: 1000,
        sessionId: 'host-conversation',
        cacheRetention: 'short',
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      return bridge.streamFn(model, context, {
        sessionId: 'untrusted-worker',
        onPayload: (payload) => payload,
      });
    },
  };
}
const completed: ModelBroker['streamFn'] = () => {
  const stream = createAssistantMessageEventStream();
  const message = fauxAssistantMessage('done');
  stream.push({ type: 'done', reason: 'stop', message });
  stream.end(message);
  return stream;
};
it('bridge permits more than 100 logical requests without retaining every id', async () => {
  const f = fixture(completed);
  let closed = false;
  f.channel.onExit(() => {
    closed = true;
  });
  for (let i = 0; i < 105; i++) {
    const stream = await f.request();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closed, `request ${i + 1} must remain live`).toBe(false);
    expect((await stream.result()).stopReason).toBe('stop');
  }
});
it('host applies the model maximum and its own conversation/cache options', async () => {
  const options: unknown[] = [];
  const f = fixture((selected, messages, request) => {
    options.push(request);
    return completed(selected, messages, request);
  });
  await (await f.request()).result();
  expect(options).toEqual([
    expect.objectContaining({
      maxTokens: 32,
      sessionId: 'host-conversation',
      cacheRetention: 'short',
      maxRetries: 0,
    }),
  ]);
});

it('host delivery honors a slow IPC writer before sending the terminal event', async () => {
  const pair = memoryChannelPair();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const channel = modelBridgeChannel(
    {
      ...pair.host,
      sendAsync: async (frame: unknown) => {
        await blocked;
        pair.host.send(frame);
      },
    },
    { model, streamFn: completed },
  );
  const bridge = workerModelBridge(pair.worker);
  channel.send({ type: 'permit', modelCallId: 'backpressure', apiKey: null, maxOutputTokens: 32 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const stream = bridge.streamFn(model, context);
  let ended = false;
  void stream.result().then(() => {
    ended = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  try {
    expect(ended).toBe(false);
  } finally {
    release();
  }
  expect((await stream.result()).stopReason).toBe('stop');
});
it.each([1, 64])(
  '64KiB in %i blocks and 64-byte deltas stays below 1MiB on the wire',
  async (blocks) => {
    const f = fixture(() => {
      const stream = createAssistantMessageEventStream();
      const content: { type: 'text'; text: string }[] = [];
      const partial = (): AssistantMessage => ({
        ...fauxAssistantMessage(''),
        content: content.map((block) => ({ ...block })),
        stopReason: 'stop',
      });
      stream.push({ type: 'start', partial: partial() });
      for (let block = 0; block < blocks; block++) {
        content.push({ type: 'text', text: '' });
        stream.push({ type: 'text_start', contentIndex: block, partial: partial() });
        for (let i = 0; i < 1024 / blocks; i++) {
          content[block]!.text += 'x'.repeat(64);
          stream.push({
            type: 'text_delta',
            contentIndex: block,
            delta: 'x'.repeat(64),
            partial: partial(),
          });
        }
        stream.push({
          type: 'text_end',
          contentIndex: block,
          content: content[block]!.text,
          partial: partial(),
        });
      }
      stream.push({ type: 'done', reason: 'stop', message: partial() });
      stream.end(partial());
      return stream;
    });
    const seen: AssistantMessageEvent[] = [];
    for await (const event of await f.request()) seen.push(event);
    expect(
      seen
        .filter((event) => event.type === 'text_delta')
        .map((event) => event.delta)
        .join(''),
    ).toBe('x'.repeat(65536));
    expect(Buffer.byteLength(JSON.stringify(f.frames))).toBeLessThan(1024 * 1024);
    expect(seen.at(-1)?.type).toBe('done');
  },
);

it('cancellation settles the worker without waiting for channel termination', async () => {
  const pair = memoryChannelPair();
  const channel = modelBridgeChannel(pair.host, {
    model,
    streamFn: (_m, _c, options) => {
      const stream = createAssistantMessageEventStream();
      options?.signal?.addEventListener('abort', () => {
        const error = { ...fauxAssistantMessage(''), stopReason: 'aborted' as const };
        stream.push({ type: 'error', reason: 'aborted', error });
        stream.end(error);
      });
      return stream;
    },
  });
  const bridge = workerModelBridge(pair.worker);
  channel.send({ type: 'permit', modelCallId: 'call_1', apiKey: null, maxOutputTokens: 32 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const abort = new AbortController();
  const stream = bridge.streamFn(model, context, { signal: abort.signal });
  let result: string | undefined;
  void stream.result().then((message) => {
    result = message.stopReason;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  channel.send({ type: 'cancel' });
  abort.abort();
  await new Promise<void>((resolve) => setImmediate(resolve));
  try {
    expect(result).toBe('aborted');
  } finally {
    channel.kill();
  }
});

it('decoder does not duplicate text already present in a mutable provider partial', () => {
  const decode = createStreamDecoder();
  const partial = fauxAssistantMessage('abc');
  decode({ type: 'start', partial });
  decode({ type: 'text_start', contentIndex: 0, block: partial.content[0] });
  const event = decode({ type: 'text_delta', contentIndex: 0, delta: 'abc' });
  expect('partial' in event && event.partial.content[0]).toEqual({ type: 'text', text: 'abc' });
});

it('decoder preserves opaque thinking present at the start without deltas', () => {
  const decode = createStreamDecoder();
  const partial: AssistantMessage = {
    ...fauxAssistantMessage(''),
    content: [{ type: 'thinking', thinking: 'opaque', redacted: true }],
  };
  decode({ type: 'start', partial });
  const event = decode({ type: 'thinking_start', contentIndex: 0, block: partial.content[0] });
  expect('partial' in event && event.partial.content[0]).toEqual(partial.content[0]);
});
