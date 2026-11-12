import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EffectiveHarnessSnapshot, RunEvent } from '@corral/contracts';
import {
  Coordinator,
  InProcessTransport,
  type RunProjection,
  resolveProfileContext,
  waitForProjection,
} from '@corral/core';
import { FakeClock, Gate, linearCorral, SequentialIdFactory } from '@corral/testkit';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import {
  createAssistantMessageEventStream,
  createFauxCore,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it } from 'vitest';
import { PiAgentAdapter } from '../src/adapter.ts';
import { memoryChannelPair } from '../src/channel.ts';
import { runSdkWorker } from '../src/sdk-worker.ts';
import { runWorker } from '../src/worker.ts';
import { DIRECTIVE_PREFIX, SDK_DIRECTIVE_PREFIX, unfinished } from '../src/worker-tools.ts';
import { ACCESS_TOKEN, liveModels, liveRuntime } from './harness.ts';

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

describe('directives sent while the worker is starting', () => {
  it.each<Worker>(['pi-core', 'sdk'])(
    'directives sent while the %s worker is starting ride its first request in arrival order, one message each, and are delivered; the interrupt stays an interrupt and cuts nothing',
    async (worker) => {
      const gate = new Gate();
      const seen: unknown[][] = [];
      const { transport, start } = runtime(writeThenSubmit(seen), { worker, workerGate: gate });
      const { runId, executionId, events, steer, directiveOf } = await start();
      expect((await steer('Keep the API.', 'cmd_join')).status).toBe('queued');
      // The adapter handed the worker over before it sent `ready`: the interrupt is not lowered,
      // and with no response to cut it rides the same first request, after the join.
      expect(await steer('Cite sources.', 'cmd_cut', 'interrupt')).toMatchObject({
        status: 'queued',
        requestedBoundary: 'immediate',
      });
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
      expect(
        events.find((e) => e.type === 'directive.accepted' && e.commandId === 'cmd_cut')?.payload,
      ).toMatchObject({ delivery: 'interrupt' });
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

/**
 * Holds the first response after its first text until `release` opens. A provider that hears
 * the abort meanwhile ends the response there as aborted; a `deaf` one answers in full.
 */
const holdFirstText = (streamed: Gate, release: Gate, deaf = false) => {
  let calls = 0;
  return (stream: StreamFn): StreamFn =>
    (model, context, options) => {
      if (++calls > 1) return stream(model, context, options);
      const inner = stream(model, context, deaf ? { ...options, signal: undefined } : options);
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
            if (!deaf && options?.signal?.aborted) {
              const aborted = { ...event.partial, stopReason: 'aborted' as const };
              out.push({ type: 'error', reason: 'aborted', error: aborted });
              out.end(aborted);
              return;
            }
          }
        }
        out.end(await source.result());
      })();
      return out;
    };
};

const prefixOf = (worker: Worker) => (worker === 'sdk' ? SDK_DIRECTIVE_PREFIX : DIRECTIVE_PREFIX);

describe('a stream that breaks', () => {
  /** The first response shows text, the test may steer, then its stream drops. */
  const brokenAfterText = async (worker: Worker, steering: boolean) => {
    const streamed = new Gate(),
      release = new Gate();
    const { transport, coordinator, start } = runtime(
      [
        fauxAssistantMessage('Partial answer before the drop.', {
          stopReason: 'error',
          errorMessage: 'fetch failed',
        }),
        ...writeThenSubmit(),
      ],
      { worker, wrapStream: holdFirstText(streamed, release) },
    );
    const { runId, executionId, steer, directiveOf } = await start();
    await streamed.wait();
    await tick();
    if (steering) expect((await steer('Keep the API.', 'cmd_join')).status).toBe('queued');
    release.open();
    const final = await waitForProjection(transport, runId, settled);
    return { coordinator, runId, executionId, final, directiveOf };
  };

  it.each<[Worker, boolean]>([
    ['pi-core', true],
    ['pi-core', false],
    ['sdk', true],
    ['sdk', false],
  ])(
    'a %s stream that breaks after it showed text ends the execution failed after that one call (directive waiting: %s)',
    async (worker, steering) => {
      const { coordinator, runId, executionId, final, directiveOf } = await brokenAfterText(
        worker,
        steering,
      );
      expect(final.status).toBe('failed');
      expect(final.executions[executionId]?.status).toBe('failed');
      // Text was already shown: nothing is retried, and a waiting directive starts no turn.
      expect(final.executions[executionId]?.modelCallIds).toHaveLength(1);
      if (steering) {
        expect((await directiveOf('cmd_join'))?.status).toBe('expired');
        expect(coordinator.getReceipt(runId, 'cmd_join')?.status).toBe('expired');
      }
    },
  );

  it.each<Worker>(['pi-core', 'sdk'])(
    'a %s call that breaks after it showed text records no confirmed response and keeps the text only as partial output',
    async (worker) => {
      const { coordinator, runId, executionId, final } = await brokenAfterText(worker, true);
      const [broken] = final.executions[executionId]?.modelCallIds ?? [];
      const call = final.modelCalls[broken ?? ''];
      expect(call).toMatchObject({ finished: true, responseRef: null, certainty: 'reported' });
      expect(coordinator.getSnapshot(runId).partialOutputs?.[broken ?? '']?.text).toContain(
        'Partial',
      );
    },
  );

  it.each<Worker>(['pi-core', 'sdk'])(
    'a directive that arrives while a %s request fails before showing anything rides its retry, once',
    async (worker) => {
      const entered = new Gate(),
        release = new Gate();
      const seen: unknown[][] = [];
      const { transport, coordinator, start } = runtime(
        [
          async () => {
            entered.open();
            await release.wait();
            return fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'fetch failed' });
          },
          ...writeThenSubmit(seen),
        ],
        { worker },
      );
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
      // A failure before any text leaves no partial output and no confirmed response.
      expect(final.modelCalls[failed ?? '']?.responseRef).toBeNull();
      expect(coordinator.getSnapshot(runId).partialOutputs?.[failed ?? '']).toBeUndefined();
      expect(final.modelCalls[retry ?? '']?.responseRef).not.toBeNull();
      expect(final.modelCalls[retry ?? '']?.directiveIds).toEqual([directiveId]);
      expect(final.directives[directiveId]?.status).toBe('delivered');
      expect(
        Object.values(final.modelCalls).filter((call) => call.directiveIds.includes(directiveId)),
      ).toHaveLength(1);
      expect(
        userTexts({ messages: seen[0] ?? [] }).filter((text) =>
          text.startsWith(`${prefixOf(worker)}${directiveId})`),
        ),
      ).toHaveLength(1);
    },
  );

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

describe('a response cut by an interrupt', () => {
  const cutAfterText = async (worker: Worker, deaf: boolean) => {
    const streamed = new Gate(),
      release = new Gate();
    const { transport, coordinator, start } = runtime(
      [
        fauxAssistantMessage(
          [
            fauxText('A long answer the person did not want.'),
            fauxToolCall('write_artifact', { text: 'Draft.' }),
          ],
          { stopReason: 'toolUse' },
        ),
        ...writeThenSubmit(),
      ],
      { worker, wrapStream: holdFirstText(streamed, release, deaf) },
    );
    const { runId, executionId, events, steer, directiveOf } = await start();
    await streamed.wait();
    await tick();
    expect((await steer('Stop and cite.', 'cmd_cut', 'interrupt')).requestedBoundary).toBe(
      'immediate',
    );
    await tick();
    release.open();
    const final = await waitForProjection(transport, runId, settled);
    const [first, next] = final.executions[executionId]?.modelCallIds ?? [];
    return {
      coordinator,
      runId,
      events,
      final,
      first: first ?? '',
      next: next ?? '',
      directiveOf,
    };
  };

  it.each<Worker>(['pi-core', 'sdk'])(
    'a %s call cut after it showed text keeps that text only as partial output; the execution goes on and the next call carries the directive',
    async (worker) => {
      const { coordinator, runId, events, final, first, next, directiveOf } = await cutAfterText(
        worker,
        false,
      );
      expect(final.status).toBe('succeeded');
      expect(final.modelCalls[first]).toMatchObject({ interrupted: true, responseRef: null });
      const cut = events.find(
        (e) => e.type === 'model.finished' && e.payload.modelCallId === first,
      );
      expect(cut?.payload).toMatchObject({ interrupted: true, responseRef: null });
      expect(coordinator.getSnapshot(runId).partialOutputs?.[first]?.text).toContain('A long');
      expect(final.modelCalls[next]?.responseRef).toBe(`response_${next}`);
      expect(final.modelCalls[next]).not.toHaveProperty('interrupted');
      const directive = await directiveOf('cmd_cut');
      expect(directive?.status).toBe('delivered');
      expect(final.modelCalls[next]?.directiveIds).toEqual([directive?.directiveId]);
    },
  );

  it('a call whose provider ignored the cut and finished is a whole response', async () => {
    const { coordinator, runId, final, first } = await cutAfterText('pi-core', true);
    expect(final.status).toBe('succeeded');
    expect(final.modelCalls[first]?.responseRef).toBe(`response_${first}`);
    expect(final.modelCalls[first]).not.toHaveProperty('interrupted');
    expect(coordinator.getSnapshot(runId).partialOutputs?.[first]).toBeUndefined();
  });
});

describe('what marks a call unfinished', () => {
  it('a response is unfinished only when it ended in an error or an abort', () => {
    for (const stopReason of ['error', 'aborted'] as const)
      expect(unfinished({ stopReason })).toBe(true);
    for (const stopReason of ['stop', 'length', 'toolUse'] as const)
      expect(unfinished({ stopReason })).toBe(false);
  });

  it.each<Worker>(['pi-core', 'sdk'])(
    'a %s response stopped by its length limit is a whole, confirmed response',
    async (worker) => {
      const { transport, start } = runtime(
        [
          fauxAssistantMessage('An answer cut by the output limit.', { stopReason: 'length' }),
          ...writeThenSubmit(),
        ],
        { worker },
      );
      const { runId, executionId, events } = await start();
      const final = await waitForProjection(transport, runId, settled);
      const [first] = final.executions[executionId]?.modelCallIds ?? [];
      expect(final.modelCalls[first ?? '']?.responseRef).toBe(`response_${first}`);
      expect(events.some((e) => e.type === 'model.finished' && e.payload.interrupted)).toBe(false);
    },
  );

  /** Wraps only the first stream. */
  const firstStream =
    (wrap: (inner: ReturnType<StreamFn>) => ReturnType<StreamFn>) =>
    (stream: StreamFn): StreamFn => {
      let calls = 0;
      return (model, context, options) =>
        ++calls > 1 ? stream(model, context, options) : wrap(stream(model, context, options));
    };

  it('an SDK stream that ends without its final event, in an error, records no confirmed response', async () => {
    const { transport, coordinator, start } = runtime(
      [
        fauxAssistantMessage('Partial answer, no final event.', {
          stopReason: 'error',
          errorMessage: 'fetch failed',
        }),
        ...writeThenSubmit(),
      ],
      {
        worker: 'sdk',
        // The provider never sends `done` or `error`; only the result says how it ended.
        wrapStream: firstStream((inner) => {
          const out = createAssistantMessageEventStream();
          void (async () => {
            const source = await inner;
            for await (const event of source)
              if (event.type !== 'done' && event.type !== 'error') out.push(event);
            out.end(await source.result());
          })();
          return out;
        }),
      },
    );
    const { runId, executionId } = await start();
    const final = await waitForProjection(transport, runId, settled);
    const [first] = final.executions[executionId]?.modelCallIds ?? [];
    expect(final.modelCalls[first ?? '']).toMatchObject({ finished: true, responseRef: null });
    expect(coordinator.getSnapshot(runId).partialOutputs?.[first ?? '']?.text).toContain('Partial');
  });

  it('an SDK stream that throws after it showed text records no confirmed response', async () => {
    const { transport, coordinator, start } = runtime(
      [fauxAssistantMessage('Partial answer, then the socket closed.'), ...writeThenSubmit()],
      {
        worker: 'sdk',
        wrapStream: firstStream(
          (inner) =>
            ({
              async *[Symbol.asyncIterator]() {
                for await (const event of await inner) {
                  yield event;
                  if (event.type === 'text_delta') throw new Error('socket closed');
                }
              },
              result: () => Promise.reject(new Error('socket closed')),
            }) as unknown as ReturnType<StreamFn>,
        ),
      },
    );
    const { runId, executionId } = await start();
    const final = await waitForProjection(transport, runId, settled);
    const [first] = final.executions[executionId]?.modelCallIds ?? [];
    expect(final.modelCalls[first ?? '']).toMatchObject({ finished: true, responseRef: null });
    expect(coordinator.getSnapshot(runId).partialOutputs?.[first ?? '']?.text).toContain('Partial');
  });

  /** A pi-core run whose brief forces an automatic compaction first. */
  const compacting = async (
    responses: FauxResponseStep[],
    wrapStream?: (stream: StreamFn) => StreamFn,
  ) => {
    const policy = resolveProfileContext(
      { contextWindow: 4000, compaction: { reserveTokens: 0, keepRecentTokens: 0 } },
      { contextWindow: 4000, source: 'catalog' },
      'core-auto',
      256,
    ).policy;
    if (!policy) throw new Error('context policy');
    const { transport } = liveRuntime(responses, {
      contextPolicy: policy,
      ...(wrapStream ? { wrapStream } : {}),
    });
    const definition = linearCorral(['writer']);
    definition.input.brief = 'Keep this requirement. '.repeat(700);
    const { runId, receipt } = await transport.startRun({
      schemaVersion: '0.1',
      commandId: 'cmd_live',
      definition,
      mode: 'live',
    });
    if (!runId) throw new Error(JSON.stringify(receipt.error));
    const events: RunEvent[] = [];
    transport.subscribe(runId, 0, { onEvent: (e) => events.push(e), onFrame: () => {} });
    const final = await waitForProjection(transport, runId, settled);
    const summaries = events.flatMap((e) =>
      e.type === 'model.request_recorded' && e.payload.purpose === 'compaction'
        ? [e.payload.modelCallId]
        : [],
    );
    return { final, summaries };
  };

  it('a pi-core compaction summary that ends in an error records no confirmed response', async () => {
    const { final, summaries } = await compacting([
      fauxAssistantMessage('Partial summ', { stopReason: 'error', errorMessage: 'fetch failed' }),
      ...writeThenSubmit(),
    ]);
    expect(final.status).toBe('failed');
    expect(summaries.length).toBeGreaterThan(0);
    for (const id of summaries)
      expect(final.modelCalls[id]).toMatchObject({ finished: true, responseRef: null });
  });

  it('a pi-core compaction summary whose stream throws records no confirmed response', async () => {
    const { final, summaries } = await compacting(
      writeThenSubmit(),
      firstStream(() => {
        throw new Error('socket closed');
      }),
    );
    expect(final.status).toBe('failed');
    expect(summaries.length).toBeGreaterThan(0);
    for (const id of summaries)
      expect(final.modelCalls[id]).toMatchObject({ finished: true, responseRef: null });
  });
});
