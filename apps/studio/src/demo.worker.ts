import './csp.ts';
import { Coordinator, InProcessTransport } from '@corral/core';
import { defaultReply, ScriptedAgentAdapter, SequentialIdFactory } from '@corral/testkit';
import type { DemoMessage, DemoRequest, DemoResponse } from './demo-protocol.ts';

let delayMs = 1500;
const transport = new InProcessTransport(
  new Coordinator({
    clock: { nowIso: () => new Date().toISOString(), monotonicMs: () => performance.now() },
    ids: new SequentialIdFactory(),
    timers: {
      after(ms, fn) {
        const timer = setTimeout(fn, ms);
        return () => clearTimeout(timer);
      },
    },
    agents: new ScriptedAgentAdapter({
      turns: 2,
      reply: (turn, input, permit) =>
        [
          defaultReply(turn, input, permit),
          `role prompt: ${input.role.prompt}`,
          `model profile: ${input.modelProfile}`,
          ...input.inputs.map((value) => `${value.name}: ${value.text}`),
        ].join('\n'),
      beforeReply: () => new Promise((resolve) => setTimeout(resolve, delayMs)),
    }),
  }),
);
const subscriptions = new Map<number, () => void>();
const send = (message: DemoResponse) => self.postMessage(message);

function request(message: DemoRequest): Promise<unknown> {
  switch (message.method) {
    case 'startRun':
      return transport.startRun(...message.args);
    case 'sendCommand':
      return transport.sendCommand(...message.args);
    case 'getReceipt':
      return transport.getReceipt(...message.args);
    case 'getSnapshot':
      return transport.getSnapshot(...message.args);
    case 'getArtifactText':
      return transport.getArtifactText(...message.args);
    case 'listRuns':
      return transport.listRuns(...message.args);
    case 'getRunDefinition':
      return transport.getRunDefinition(...message.args);
  }
}

self.addEventListener('message', (event: MessageEvent<DemoMessage>) => {
  const message = event.data;
  if (message.type === 'configure') {
    if (Number.isFinite(message.delayMs) && message.delayMs >= 0 && message.delayMs <= 60_000) {
      delayMs = message.delayMs;
    }
  } else if (message.type === 'unsubscribe') {
    subscriptions.get(message.id)?.();
    subscriptions.delete(message.id);
  } else if (message.type === 'subscribe') {
    subscriptions.set(
      message.id,
      transport.subscribe(message.runId, message.afterSeq, {
        onEvent: (event) => send({ type: 'event', id: message.id, event }),
        onFrame: (frame) => send({ type: 'frame', id: message.id, frame }),
        onError: () =>
          send({
            type: 'subscription_error',
            id: message.id,
            message: 'Demo subscription stopped.',
          }),
      }),
    );
  } else {
    void request(message).then(
      (value) => send({ type: 'result', id: message.id, value }),
      () => send({ type: 'error', id: message.id, message: 'Demo request failed.' }),
    );
  }
});
