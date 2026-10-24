import {
  createAssistantMessageEventStream,
  createFauxCore,
  fauxAssistantMessage,
  normalizeContext,
} from '@earendil-works/pi-ai';
import { expect, it } from 'vitest';
import { memoryChannelPair } from '../src/channel.ts';
import { modelBridgeChannel, workerModelBridge } from '../src/model-bridge.ts';
import { LEGACY_PROTOCOL_VERSION } from '../src/protocol.ts';

it('[TC-SBX-002-H] [TC-SBX-002-N] the host keeps credentials and permit limits, refuses changed payloads and replayed calls', async () => {
  const { host, worker } = memoryChannelPair();
  const faux = createFauxCore({ provider: 'faux', models: [{ id: 'fixture', name: 'Fixture' }] });
  const model = faux.models[0];
  const calls: unknown[] = [],
    received: unknown[] = [];
  let aborted = false;
  const channel = modelBridgeChannel(host, {
    model,
    streamFn: (_model, _context, options) => {
      calls.push({ key: options?.apiKey, max: options?.maxTokens });
      options?.signal?.addEventListener('abort', () => {
        aborted = true;
      });
      const result = createAssistantMessageEventStream();
      void (async () => {
        try {
          await options?.onPayload?.({ model: model.id }, model);
          const message = fauxAssistantMessage('ok');
          result.push({ type: 'done', reason: 'stop', message });
          result.end(message);
        } catch {
          const error = { ...fauxAssistantMessage(''), stopReason: 'error' as const };
          result.push({ type: 'error', reason: 'error', error });
          result.end(error);
        }
      })();
      return result;
    },
  });
  const bridge = workerModelBridge(worker);
  bridge.port.onFrame((frame) => received.push(frame));
  const permit = {
    type: 'permit',
    protocolVersion: LEGACY_PROTOCOL_VERSION,
    executionId: 'exec_1',
    requestId: 'req_1',
    modelCallId: 'mc_1',
    apiKey: 'private-key',
    maxOutputTokens: 17,
    directives: [],
  };
  channel.send(permit);
  await Promise.resolve();
  const first = bridge.streamFn(model, normalizeContext({ messages: [] }), {
    maxTokens: 9999,
    apiKey: 'worker-key',
    onPayload: () => ({ model: 'changed' }),
  });
  expect((await first.result()).stopReason).toBe('error');
  expect(calls).toEqual([{ key: 'private-key', max: 17 }]);
  expect(JSON.stringify(received)).not.toContain('private-key');
  expect(received).toContainEqual(expect.objectContaining({ apiKey: null }));
  await Promise.resolve();
  channel.send({ ...permit, modelCallId: 'mc_2' });
  await Promise.resolve();
  const controller = new AbortController();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const second = bridge.streamFn(model, normalizeContext({ messages: [] }), {
    signal: controller.signal,
    onPayload: async () => {
      controller.abort();
      await held;
    },
  });
  expect((await second.result()).stopReason).toBe('aborted');
  await expect.poll(() => aborted).toBe(true);
  release();
  await Promise.resolve();
  await Promise.resolve();
  const exited = new Promise<void>((resolve) => channel.onExit(() => resolve()));
  worker.send({ bridge: 'model', type: 'request', id: 'stream_3', context: { messages: [] } });
  await exited;
  expect(calls).toHaveLength(2);
});
