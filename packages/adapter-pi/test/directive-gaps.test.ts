import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EffectiveHarnessSnapshot, RunEvent } from '@corral/contracts';
import {
  Coordinator,
  InProcessTransport,
  type RunProjection,
  waitForProjection,
} from '@corral/core';
import { FakeClock, Gate, linearCorral, SequentialIdFactory } from '@corral/testkit';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import {
  createAssistantMessageEventStream,
  createFauxCore,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it } from 'vitest';
import { PiAgentAdapter } from '../src/adapter.ts';
import { memoryChannelPair } from '../src/channel.ts';
import { runSdkWorker } from '../src/sdk-worker.ts';
import { runWorker } from '../src/worker.ts';
import { DIRECTIVE_PREFIX, SDK_DIRECTIVE_PREFIX } from '../src/worker-tools.ts';
import { ACCESS_TOKEN, liveModels } from './harness.ts';

// Directive delivery through the real workers under a Coordinator, on the paths no other test
// pins (docs/specs/features/reins.md §2 and §5): a worker that has not started yet, and a
// stream that breaks with or without a retry.

const scratch: string[] = [];
afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const settled = (p: RunProjection) => ['succeeded', 'failed', 'cancelled'].includes(p.status);
const tick = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

const harness: EffectiveHarnessSnapshot = {
  binding: { profileId: 'writing', revision: 1 },
  snapshotHash: 'a'.repeat(64),
  piVersion: '1.3.0',
  policyRevision: 1,
  policy: 'trusted-native',
  resources: [],
  allowedTools: ['write_artifact', 'submit_result'],
  tools: [],
  diagnostics: [],
};

type Worker = 'pi-core' | 'sdk';

/** The user-role texts of one request, in order. */
const userTexts = (context: { messages: unknown[] }) =>
  (context.messages as { role: string; content: unknown }[])
    .filter((message) => message.role === 'user')
    .map((message) =>
      typeof message.content === 'string'
        ? message.content
        : (message.content as { type: string; text?: string }[])
            .map((part) => (part.type === 'text' ? (part.text ?? '') : ''))
            .join(''),
    );

function lastArtifactVersion(context: { messages: unknown[] }): string {
  const found = JSON.stringify(context.messages).match(/artifactVersionId\\?":\\?"([^"\\]+)/g);
  const last = found?.at(-1)?.match(/artifactVersionId\\?":\\?"([^"\\]+)/)?.[1];
  if (!last) throw new Error('no write_artifact result in the transcript');
  return last;
}

/** Writes and submits a result, then answers; `seen` records each request's context. */
const writeThenSubmit = (seen: unknown[][] = []): FauxResponseStep[] => [
  (context) => {
    seen.push(JSON.parse(JSON.stringify(context.messages)));
    return fauxAssistantMessage([fauxToolCall('write_artifact', { text: 'Cited.' })], {
      stopReason: 'toolUse',
    });
  },
  (context) =>
    fauxAssistantMessage(
      [fauxToolCall('submit_result', { artifactVersionIds: [lastArtifactVersion(context)] })],
      { stopReason: 'toolUse' },
    ),
  fauxAssistantMessage('Done.'),
];

/**
 * The Coordinator with the Pi adapter on a faux model. The worker starts only when `workerGate`
 * opens: until then the execution exists and its handle drops what it is pushed.
 */
function runtime(
  responses: FauxResponseStep[],
  options: { worker?: Worker; workerGate?: Gate; wrapStream?: (stream: StreamFn) => StreamFn } = {},
) {
  const faux = createFauxCore({});
  faux.setResponses(responses);
  const stream: StreamFn = options.wrapStream
    ? options.wrapStream(faux.streamSimple)
    : faux.streamSimple;
  const later = (run: () => void) => {
    if (options.workerGate) void options.workerGate.wait().then(run);
    else run();
  };
  const adapter = new PiAgentAdapter({
    spawn: () => {
      const { host, worker } = memoryChannelPair();
      later(() => runWorker(worker, { streamFn: stream, resolveModel: () => faux.getModel() }));
      return host;
    },
    spawnSdk: () => {
      const { host, worker } = memoryChannelPair();
      const directory = mkdtempSync(join(tmpdir(), 'corral-directive-gaps-'));
      scratch.push(directory);
      later(() =>
        runSdkWorker(worker, {
          streamFn: stream,
          resolveModel: () => faux.getModel(),
          directory,
          now: () => 1000,
        }),
      );
      return host;
    },
    harness: async () => ({ bundles: [], extensions: [], skills: [], startupCommands: [] }),
    credentials: async () => ACCESS_TOKEN,
  });
  const sdk = options.worker === 'sdk';
  const coordinator = new Coordinator({
    clock: new FakeClock(),
    ids: new SequentialIdFactory(),
    models: liveModels,
    agents: adapter,
    ...(sdk ? { harnesses: { resolve: () => harness } } : {}),
  });
  const transport = new InProcessTransport(coordinator);
  const start = async () => {
    const definition = linearCorral(['writer']);
    if (sdk) for (const role of definition.roles) role.harness = harness.binding;
    const { runId, receipt } = await transport.startRun({
      schemaVersion: '0.1',
      commandId: 'cmd_live',
      definition,
      mode: 'live',
    });
    if (!runId) throw new Error(JSON.stringify(receipt.error));
    const events: RunEvent[] = [];
    transport.subscribe(runId, 0, { onEvent: (e) => events.push(e), onFrame: () => {} });
    const executionId = (
      await waitForProjection(transport, runId, (p) => p.executionOrder.length === 1)
    ).executionOrder[0];
    if (!executionId) throw new Error('no execution');
    const steer = (
      text: string,
      commandId: string,
      delivery: 'next_request' | 'interrupt' = 'next_request',
    ) =>
      transport.sendCommand({
        schemaVersion: '0.1',
        commandId,
        runId,
        type: 'steer',
        payload: { targetExecutionId: executionId, text, delivery },
      });
    const directiveOf = async (commandId: string) => {
      const { projection } = await transport.getSnapshot(runId);
      const accepted = events.find(
        (e): e is Extract<RunEvent, { type: 'directive.accepted' }> =>
          e.type === 'directive.accepted' && e.commandId === commandId,
      );
      return accepted ? projection.directives[accepted.payload.directiveId] : undefined;
    };
    return { runId, executionId, events, steer, directiveOf };
  };
  return { transport, coordinator, start };
}

describe('directives sent before the worker starts', () => {
  it.each<Worker>(['pi-core', 'sdk'])(
    'directives sent before the %s worker starts ride its first request in arrival order, one message each, and are delivered',
    async (worker) => {
      const gate = new Gate();
      const seen: unknown[][] = [];
      const { transport, start } = runtime(writeThenSubmit(seen), { worker, workerGate: gate });
      const { runId, executionId, events, steer, directiveOf } = await start();
      expect((await steer('Keep the API.', 'cmd_join')).status).toBe('queued');
      // An interrupt with no response to cut rides the same first request, after the join.
      expect((await steer('Cite sources.', 'cmd_cut', 'interrupt')).status).toBe('queued');
      expect((await directiveOf('cmd_join'))?.status).toBe('queued');
      expect((await directiveOf('cmd_cut'))?.status).toBe('queued');
      gate.open();
      const final = await waitForProjection(transport, runId, settled);

      expect(final.status).toBe('succeeded');
      const join = (await directiveOf('cmd_join'))?.directiveId ?? '';
      const cut = (await directiveOf('cmd_cut'))?.directiveId ?? '';
      const [first] = final.executions[executionId]?.modelCallIds ?? [];
      expect(final.modelCalls[first ?? '']?.directiveIds).toEqual([join, cut]);
      expect(final.directives[join]?.status).toBe('delivered');
      expect(final.directives[cut]?.status).toBe('delivered');
      const prefix = worker === 'sdk' ? SDK_DIRECTIVE_PREFIX : DIRECTIVE_PREFIX;
      const directiveMessages = userTexts({ messages: seen[0] ?? [] }).filter((text) =>
        text.startsWith(prefix),
      );
      // Each directive is its own message, in the order they arrived.
      expect(directiveMessages).toHaveLength(2);
      expect(directiveMessages[0]).toContain(`${join})`);
      expect(directiveMessages[0]).toContain('Keep the API.');
      expect(directiveMessages[1]).toContain(`${cut})`);
      expect(directiveMessages[1]).toContain('Cite sources.');
      expect(events.filter((e) => e.type === 'model.finished' && e.payload.interrupted)).toEqual(
        [],
      );
    },
  );
});

describe('a stream that breaks', () => {
  /** The first response shows text, the test steers, then its stream drops. */
  const brokenAfterText = async () => {
    const streamed = new Gate(),
      release = new Gate();
    let calls = 0;
    const { transport, coordinator, start } = runtime(
      [
        fauxAssistantMessage('Partial answer before the drop.', {
          stopReason: 'error',
          errorMessage: 'fetch failed',
        }),
        ...writeThenSubmit(),
      ],
      {
        // The first response holds after its first text until the test lets the drop through.
        wrapStream: (stream) => (model, context, options) => {
          if (++calls > 1) return stream(model, context, options);
          const inner = stream(model, context, options);
          const out = createAssistantMessageEventStream();
          void (async () => {
            const source = await inner;
            let held = false;
            for await (const event of source) {
              out.push(event);
              if (!held && event.type === 'text_delta') {
                held = true;
                streamed.open();
                await release.wait();
              }
            }
            out.end(await source.result());
          })();
          return out;
        },
      },
    );
    const { runId, executionId, steer, directiveOf } = await start();
    await streamed.wait();
    await tick();
    expect((await steer('Keep the API.', 'cmd_join')).status).toBe('queued');
    release.open();
    const final = await waitForProjection(transport, runId, settled);
    return { coordinator, runId, executionId, final, directiveOf };
  };

  it('a stream that breaks after it showed text fails the target without a retry and keeps the partial output', async () => {
    const { coordinator, runId, executionId, final } = await brokenAfterText();
    expect(final.status).toBe('failed');
    expect(final.executions[executionId]?.status).toBe('failed');
    const [broken, ...rest] = final.executions[executionId]?.modelCallIds ?? [];
    // Text was already shown, so nothing was retried.
    expect(rest).toEqual([]);
    const { partialOutputs } = coordinator.getSnapshot(runId);
    expect(partialOutputs?.[broken ?? '']?.text).toContain('Partial');
  });

  it('a directive waiting when the stream breaks after text expires with the failed target', async () => {
    const { coordinator, runId, final, directiveOf } = await brokenAfterText();
    expect(final.status).toBe('failed');
    expect((await directiveOf('cmd_join'))?.status).toBe('expired');
    expect(coordinator.getReceipt(runId, 'cmd_join')?.status).toBe('expired');
  });

  it('a directive that arrives while a request fails before showing anything rides its retry, once', async () => {
    const entered = new Gate(),
      release = new Gate();
    const seen: unknown[][] = [];
    const { transport, start } = runtime([
      async () => {
        entered.open();
        await release.wait();
        return fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'fetch failed' });
      },
      ...writeThenSubmit(seen),
    ]);
    const { runId, executionId, events, steer, directiveOf } = await start();
    await entered.wait();
    await steer('Keep the API.', 'cmd_join');
    await tick();
    release.open();
    const final = await waitForProjection(transport, runId, settled);

    expect(final.status).toBe('succeeded');
    expect(
      events.filter((e) => e.type === 'model.request_recorded').map((e) => e.payload.purpose),
    ).toContain('retry');
    const directiveId = (await directiveOf('cmd_join'))?.directiveId ?? '';
    const [failed, retry] = final.executions[executionId]?.modelCallIds ?? [];
    expect(final.modelCalls[failed ?? '']?.directiveIds).toEqual([]);
    expect(final.modelCalls[retry ?? '']?.directiveIds).toEqual([directiveId]);
    expect(final.directives[directiveId]?.status).toBe('delivered');
    expect(
      Object.values(final.modelCalls).filter((call) => call.directiveIds.includes(directiveId)),
    ).toHaveLength(1);
    expect(
      userTexts({ messages: seen[0] ?? [] }).filter((text) =>
        text.startsWith(`${DIRECTIVE_PREFIX}${directiveId})`),
      ),
    ).toHaveLength(1);
  });

  it('a directive the failed request already carried is in its retry once', async () => {
    const gate = new Gate();
    const contexts: unknown[][] = [];
    const { transport, start } = runtime(
      [
        (context) => {
          contexts.push(JSON.parse(JSON.stringify(context.messages)));
          return fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'fetch failed' });
        },
        ...writeThenSubmit(contexts),
      ],
      { workerGate: gate },
    );
    const { runId, steer, directiveOf } = await start();
    await steer('Keep the API.', 'cmd_join');
    gate.open();
    const final = await waitForProjection(transport, runId, settled);

    expect(final.status).toBe('succeeded');
    const directiveId = (await directiveOf('cmd_join'))?.directiveId ?? '';
    expect(final.directives[directiveId]?.status).toBe('delivered');
    expect(contexts).toHaveLength(2);
    for (const messages of contexts)
      expect(
        userTexts({ messages }).filter((text) =>
          text.startsWith(`${DIRECTIVE_PREFIX}${directiveId})`),
        ),
      ).toHaveLength(1);
  });
});
