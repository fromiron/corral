import './csp.ts';
import { TERMINAL_RUN_STATUSES } from '@corral/contracts';
import {
  Coordinator,
  exportRunArchive,
  InMemoryRunStore,
  InProcessTransport,
  LocalHeuristicProvider,
} from '@corral/core';
import { ScriptedAgentAdapter, SequentialIdFactory } from '@corral/testkit';
import { createDemoReply, DEMO_TURNS, demoPlansFor, publishDemoPlan } from './demo/script.ts';
import { DemoWorkspace } from './demo/workspace.ts';
import {
  DEMO_WORKSPACE_METHODS,
  type DemoMessage,
  type DemoRequest,
  type DemoResponse,
} from './demo-protocol.ts';

let delayMs = 1500;
const store = new InMemoryRunStore();
// The demo's work folder and the file tools on it.
const files = new DemoWorkspace(store);
const transport = new InProcessTransport(
  new Coordinator({
    store,
    files,
    clock: { nowIso: () => new Date().toISOString(), monotonicMs: () => performance.now() },
    // A namespace per page load: demo runs vanish on reload, and a session saved in this
    // browser must not mistake a new run for an old one with the same number.
    ids: new SequentialIdFactory(crypto.randomUUID().slice(0, 4)),
    timers: {
      after(ms, fn) {
        const timer = setTimeout(fn, ms);
        return () => clearTimeout(timer);
      },
    },
    // The demo shows effort judgments with the rule baseline; the local AI judge runs only in
    // the local server. Observe only: nothing changes what the simulated agents do.
    judgments: {
      providers: [new LocalHeuristicProvider()],
      settings: { reasoning_effort: { mode: 'observe', providers: ['local-heuristic'] } },
    },
    agents: new ScriptedAgentAdapter({
      turns: DEMO_TURNS,
      reply: createDemoReply(),
      // The demo writes answers and versions read into its replies (demo/script.ts).
      appendNotes: false,
      beforeReply: () => new Promise((resolve) => setTimeout(resolve, delayMs)),
      // A multi-step request publishes a real checklist; a short reply returns null and stays plan-free.
      script: async (input, host) => {
        if (demoPlansFor(input)) {
          await publishDemoPlan(input, host, undefined, delayMs);
        }
        return null;
      },
    }),
  }),
);
const subscriptions = new Map<number, () => void>();
const send = (message: DemoResponse) => self.postMessage(message);

/** A run in a session with a working copy gets start and end snapshots, as on the server. */
async function startRun(...args: Parameters<typeof transport.startRun>) {
  const sessionId = args[0].sessionId;
  const startTree = files.runStarting(sessionId);
  const result = await transport.startRun(...args);
  if (result.runId && startTree && sessionId) {
    const runId = result.runId;
    files.runStarted(runId, sessionId, startTree);
    const stop = transport.subscribe(runId, 0, {
      onEvent: (event) => {
        if (event.type === 'run.state_changed' && TERMINAL_RUN_STATUSES.has(event.payload.to)) {
          files.runEnded(runId);
          queueMicrotask(stop);
        }
      },
    });
  }
  return result;
}

function request(message: DemoRequest): Promise<unknown> {
  switch (message.method) {
    case 'startRun':
      return startRun(...message.args);
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
  } else if (message.type === 'history') {
    try {
      send({
        type: 'result',
        id: message.id,
        value: exportRunArchive(store, message.runId, { privateTranscript: true }),
      });
    } catch {
      send({ type: 'error', id: message.id, message: 'The run history is unavailable.' });
    }
  } else if (message.type === 'workspace') {
    // Only the listed methods; errors carry their message (no paths exist in the demo).
    try {
      if (!(DEMO_WORKSPACE_METHODS as readonly string[]).includes(message.method))
        throw new Error('unknown demo workspace call');
      const method = files[message.method] as (...args: unknown[]) => unknown;
      void Promise.resolve(method.apply(files, message.args)).then(
        (value) => send({ type: 'result', id: message.id, value }),
        (error: unknown) =>
          send({
            type: 'error',
            id: message.id,
            message: error instanceof Error ? error.message : 'Demo request failed.',
          }),
      );
    } catch (error) {
      send({
        type: 'error',
        id: message.id,
        message: error instanceof Error ? error.message : 'Demo request failed.',
      });
    }
  } else {
    void request(message).then(
      (value) => send({ type: 'result', id: message.id, value }),
      () => send({ type: 'error', id: message.id, message: 'Demo request failed.' }),
    );
  }
});
