import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  EffectiveHarnessSnapshot,
  ProfileContextPolicy,
  Receipt,
  RunEvent,
} from '@corral/contracts';
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
  type AssistantMessageEvent,
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
import type { SdkResources } from '../src/protocol.ts';
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
type WorkerFrame = { type?: string; failed?: boolean; [key: string]: unknown };

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
  options: {
    worker?: Worker;
    workerGate?: Gate;
    wrapStream?: (stream: StreamFn) => StreamFn;
    contextPolicy?: ProfileContextPolicy;
    /** Sees each frame the worker sends, before the host handles it. */
    onWorkerFrame?: (frame: WorkerFrame) => void;
    /** The adapter's harness resources, which an SDK role waits for before its worker. */
    harness?: () => Promise<SdkResources>;
  } = {},
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
  /** Every text fragment the worker streamed, in order. */
  const streamFrames: { modelCallId: string; chunkIndex: number; text: string }[] = [];
  const pair = () => {
    const channels = memoryChannelPair();
    channels.host.onFrame((frame) => {
      const f = frame as WorkerFrame;
      if (f.type === 'stream')
        streamFrames.push({
          modelCallId: String(f.modelCallId),
          chunkIndex: Number(f.chunkIndex),
          text: String(f.text),
        });
    });
    if (options.onWorkerFrame) {
      const seen = options.onWorkerFrame;
      channels.host.onFrame((frame) => seen(frame as WorkerFrame));
    }
    return channels;
  };
  const adapter = new PiAgentAdapter({
    spawn: () => {
      const { host, worker } = pair();
      later(() => runWorker(worker, { streamFn: stream, resolveModel: () => faux.getModel() }));
      return host;
    },
    spawnSdk: () => {
      const { host, worker } = pair();
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
    harness:
      options.harness ??
      (async () => ({ bundles: [], extensions: [], skills: [], startupCommands: [] })),
    credentials: async () => ACCESS_TOKEN,
  });
  const sdk = options.worker === 'sdk';
  const coordinator = new Coordinator({
    clock: new FakeClock(),
    ids: new SequentialIdFactory(),
    models: options.contextPolicy
      ? {
          resolve: (profile, mode) => {
            const resolved = liveModels.resolve(profile, mode);
            if (!resolved.ok || !options.contextPolicy) return resolved;
            return {
              ok: true,
              snapshot: {
                ...resolved.snapshot,
                contextWindow: options.contextPolicy.contextWindow,
                contextPolicy: options.contextPolicy,
              },
            };
          },
        }
      : liveModels,
    agents: adapter,
    ...(sdk ? { harnesses: { resolve: () => harness } } : {}),
  });
  const transport = new InProcessTransport(coordinator);
  const current = { runId: '', executionId: '' };
  /** A steer submitted synchronously, usable from a frame hook. */
  const steerNow = (
    text: string,
    commandId: string,
    delivery: 'next_request' | 'interrupt' = 'next_request',
  ) =>
    coordinator.submit({
      schemaVersion: '0.1',
      commandId,
      runId: current.runId,
      type: 'steer',
      payload: { targetExecutionId: current.executionId, text, delivery },
    });
  /** A manual compaction of the current attempt. */
  const compactNow = (commandId: string) =>
    coordinator.submit({
      schemaVersion: '0.1',
      commandId,
      runId: current.runId,
      type: 'compact_context',
      expectedControlRevision: coordinator.getSnapshot(current.runId).projection.controlRevision,
      payload: { executionId: current.executionId, attemptNo: 1 },
    });
  const start = async (brief?: string) => {
    const definition = linearCorral(['writer']);
    if (brief) definition.input.brief = brief;
    if (sdk) for (const role of definition.roles) role.harness = harness.binding;
    const { runId, receipt } = await transport.startRun({
      schemaVersion: '0.1',
      commandId: 'cmd_live',
      definition,
      mode: 'live',
    });
    if (!runId) throw new Error(JSON.stringify(receipt.error));
    const events: RunEvent[] = [];
    const published: { modelCallId: string; chunkIndex: number; text: string }[] = [];
    transport.subscribe(runId, 0, {
      onEvent: (e) => events.push(e),
      onFrame: (frame) => {
        published.push({
          modelCallId: frame.modelCallId,
          chunkIndex: frame.chunkIndex,
          text: frame.text,
        });
      },
    });
    const executionId = (
      await waitForProjection(transport, runId, (p) => p.executionOrder.length === 1)
    ).executionOrder[0];
    if (!executionId) throw new Error('no execution');
    current.runId = runId;
    current.executionId = executionId;
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
    return { runId, executionId, events, steer, directiveOf, published };
  };
  return { transport, coordinator, start, steerNow, compactNow, streamFrames };
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
const holdFirstText = (
  streamed: Gate,
  release: Gate,
  deaf = false,
  at: Exclude<AssistantMessageEvent['type'], 'done' | 'error'> = 'text_delta',
) => {
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
          if (!held && event.type === at && 'partial' in event) {
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

const contextPolicy = (mode: 'core-auto' | 'core-manual', contextWindow: number) => {
  const policy = resolveProfileContext(
    { contextWindow, compaction: { reserveTokens: 0, keepRecentTokens: 0 } },
    { contextWindow, source: 'catalog' },
    mode,
    256,
  ).policy;
  if (!policy) throw new Error('context policy');
  return policy;
};

/** The first response shows its first text, waits for `release`, then its socket closes. */
const throwAfterFirstText = (streamed: Gate, release: Gate) => {
  let calls = 0;
  return (stream: StreamFn): StreamFn =>
    (model, context, options) => {
      if (++calls > 1) return stream(model, context, options);
      const inner = stream(model, context, options);
      return {
        async *[Symbol.asyncIterator]() {
          for await (const event of await inner) {
            yield event;
            if (event.type === 'text_delta') {
              streamed.open();
              await release.wait();
              throw new Error('socket closed');
            }
          }
        },
        result: () => Promise.reject(new Error('socket closed')),
      } as unknown as ReturnType<StreamFn>;
    };
};

const compactionPhases = (events: RunEvent[]) =>
  events.flatMap((e) =>
    e.type === 'context.compaction_changed'
      ? [`${e.payload.trigger ?? 'manual'}:${e.payload.phase}`]
      : [],
  );
const purposes = (events: RunEvent[]) =>
  events.flatMap((e) => (e.type === 'model.request_recorded' ? [e.payload.purpose] : []));
/** What the summary calls streamed and left as partial output: nothing, in either worker. */
const summaryTraces = (
  events: RunEvent[],
  frames: { modelCallId: string }[],
  partials: Record<string, unknown> | undefined,
) => {
  const summaries = events.flatMap((e) =>
    e.type === 'model.request_recorded' && e.payload.purpose === 'compaction'
      ? [e.payload.modelCallId]
      : [],
  );
  return {
    summaries: summaries.length,
    frames: frames.filter((frame) => summaries.includes(frame.modelCallId)),
    partials: summaries.filter((id) => partials?.[id] !== undefined),
  };
};

describe('an automatic compaction whose summary fails', () => {
  /** The first request is a summary; it shows text, the test may steer, then it fails. */
  const summaryFails = async (worker: Worker, steering: boolean, ending: 'error' | 'throws') => {
    const streamed = new Gate(),
      release = new Gate();
    const { transport, coordinator, start, streamFrames } = runtime(
      [
        ending === 'error'
          ? fauxAssistantMessage('Partial summary before the drop.', {
              stopReason: 'error',
              errorMessage: 'fetch failed',
            })
          : fauxAssistantMessage('Partial summary, then the socket closed.'),
        // What a run that went on anyway would use: a valid summary, then the task.
        fauxAssistantMessage('Summary: keep the requirement; nothing done yet.'),
        ...writeThenSubmit(),
      ],
      {
        worker,
        contextPolicy: contextPolicy('core-auto', 4000),
        wrapStream:
          ending === 'error'
            ? holdFirstText(streamed, release)
            : throwAfterFirstText(streamed, release),
      },
    );
    const { runId, executionId, events, steer, directiveOf } = await start(
      'Keep this requirement. '.repeat(700),
    );
    await streamed.wait();
    await tick();
    if (steering) expect((await steer('Keep the API.', 'cmd_join')).status).toBe('queued');
    await tick();
    release.open();
    const final = await waitForProjection(transport, runId, settled);
    return { coordinator, runId, executionId, events, final, directiveOf, streamFrames };
  };

  it.each<[Worker, boolean, 'error' | 'throws']>([
    ['pi-core', true, 'error'],
    ['pi-core', false, 'error'],
    ['sdk', true, 'error'],
    ['sdk', false, 'error'],
    ['pi-core', true, 'throws'],
    ['pi-core', false, 'throws'],
    ['sdk', true, 'throws'],
    ['sdk', false, 'throws'],
  ])(
    'a %s execution whose summary fails ends failed after that one call (directive waiting: %s, summary %s)',
    async (worker, steering, ending) => {
      const { coordinator, runId, executionId, events, final, directiveOf, streamFrames } =
        await summaryFails(worker, steering, ending);
      expect(final.status).toBe('failed');
      // The summary's text is never streamed, so the conversation never shows it.
      expect(
        summaryTraces(events, streamFrames, coordinator.getSnapshot(runId).partialOutputs),
      ).toEqual({ summaries: 1, frames: [], partials: [] });
      expect(final.executions[executionId]?.status).toBe('failed');
      expect(final.executions[executionId]?.modelCallIds).toHaveLength(1);
      expect(purposes(events)).toEqual(['compaction']);
      expect(compactionPhases(events)).toEqual(['automatic:started', 'automatic:failed']);
      if (steering) {
        expect((await directiveOf('cmd_join'))?.status).toBe('expired');
        expect(coordinator.getReceipt(runId, 'cmd_join')?.status).toBe('expired');
      }
    },
  );

  it.each<Worker>(['pi-core', 'sdk'])(
    'a %s summary that succeeds streams nothing either',
    async (worker) => {
      const { transport, coordinator, start, streamFrames } = runtime(
        [
          fauxAssistantMessage('Summary: keep the requirement; nothing done yet.'),
          ...writeThenSubmit(),
        ],
        { worker, contextPolicy: contextPolicy('core-auto', 4000) },
      );
      const { runId, events } = await start('Keep this requirement. '.repeat(700));
      const final = await waitForProjection(transport, runId, settled);
      expect(final.status).toBe('succeeded');
      expect(compactionPhases(events)).toEqual(['automatic:started', 'automatic:completed']);
      expect(
        summaryTraces(events, streamFrames, coordinator.getSnapshot(runId).partialOutputs),
      ).toEqual({ summaries: 1, frames: [], partials: [] });
    },
  );
});

describe('a manual compaction waiting on the turn in flight', () => {
  const SUMMARY = 'Summary that keeps the required task.';
  /**
   * The first turn shows text and holds; the test asks for a manual compaction, may steer or
   * interrupt, then lets the turn end as `first` says.
   */
  const waitingCompaction = async (
    worker: Worker,
    first: 'fails' | 'whole' | 'cut',
    steering: boolean,
  ) => {
    const streamed = new Gate(),
      release = new Gate();
    const seen: unknown[][] = [];
    const { transport, coordinator, start, compactNow, streamFrames } = runtime(
      [
        first === 'fails'
          ? fauxAssistantMessage('Partial answer before the drop.', {
              stopReason: 'error',
              errorMessage: 'fetch failed',
            })
          : fauxAssistantMessage(
              [fauxText('Drafting first.'), fauxToolCall('write_artifact', { text: 'Draft.' })],
              { stopReason: 'toolUse' },
            ),
        // The SDK answers the interrupt in a turn of its own before it compacts.
        ...(first === 'cut' && worker === 'sdk'
          ? [
              fauxAssistantMessage([fauxToolCall('write_artifact', { text: 'Cited draft.' })], {
                stopReason: 'toolUse',
              }),
            ]
          : []),
        fauxAssistantMessage(SUMMARY),
        ...writeThenSubmit(seen),
      ],
      {
        worker,
        contextPolicy: contextPolicy('core-manual', 64000),
        wrapStream: holdFirstText(streamed, release),
      },
    );
    const { runId, executionId, events, steer, directiveOf } = await start(
      'Keep this requirement. '.repeat(40),
    );
    await streamed.wait();
    await tick();
    expect(compactNow('cmd_compact').status).toBe('accepted');
    if (first === 'cut')
      expect((await steer('Stop and cite.', 'cmd_join', 'interrupt')).requestedBoundary).toBe(
        'immediate',
      );
    else if (steering) expect((await steer('Keep the API.', 'cmd_join')).status).toBe('queued');
    await tick();
    release.open();
    const final = await waitForProjection(transport, runId, settled);
    const summary = summaryTraces(
      events,
      streamFrames,
      coordinator.getSnapshot(runId).partialOutputs,
    );
    return { coordinator, runId, executionId, events, final, directiveOf, seen, summary };
  };

  it.each<[Worker, boolean]>([
    ['pi-core', true],
    ['pi-core', false],
    ['sdk', true],
    ['sdk', false],
  ])(
    'a %s turn that fails after text ends the execution failed and skips the waiting compaction (directive waiting: %s)',
    async (worker, steering) => {
      const { coordinator, runId, executionId, events, final, directiveOf, summary } =
        await waitingCompaction(worker, 'fails', steering);
      expect(summary).toEqual({ summaries: 0, frames: [], partials: [] });
      expect(final.status).toBe('failed');
      expect(final.executions[executionId]?.status).toBe('failed');
      expect(final.executions[executionId]?.modelCallIds).toHaveLength(1);
      expect(purposes(events)).toEqual(['turn']);
      expect(compactionPhases(events)).toEqual(['manual:queued', 'manual:skipped']);
      if (steering) {
        expect((await directiveOf('cmd_join'))?.status).toBe('expired');
        expect(coordinator.getReceipt(runId, 'cmd_join')?.status).toBe('expired');
      }
    },
  );

  it.each<Worker>(['pi-core', 'sdk'])(
    'after a whole %s turn the waiting compaction runs and the execution goes on',
    async (worker) => {
      const { events, final, summary } = await waitingCompaction(worker, 'whole', false);
      expect(final.status).toBe('succeeded');
      expect(summary).toEqual({ summaries: 1, frames: [], partials: [] });
      expect(purposes(events)).toEqual(['turn', 'compaction', 'turn', 'turn']);
      expect(compactionPhases(events)).toEqual([
        'manual:queued',
        'manual:started',
        'manual:completed',
      ]);
    },
  );

  it.each<Worker>(['pi-core', 'sdk'])(
    'after a %s turn cut by an interrupt the waiting compaction still runs and the execution goes on',
    async (worker) => {
      const { executionId, events, final, directiveOf, summary } = await waitingCompaction(
        worker,
        'cut',
        false,
      );
      expect(final.status).toBe('succeeded');
      expect(summary).toEqual({ summaries: 1, frames: [], partials: [] });
      const [cut] = final.executions[executionId]?.modelCallIds ?? [];
      expect(final.modelCalls[cut ?? '']?.interrupted).toBe(true);
      // pi-core compacts while preparing the request after the cut; the SDK first answers the
      // directive in its own turn, then compacts once Pi is idle and prompts it to go on.
      expect(purposes(events)).toEqual(
        worker === 'sdk'
          ? ['turn', 'turn', 'compaction', 'turn', 'turn']
          : ['turn', 'compaction', 'turn', 'turn'],
      );
      expect(compactionPhases(events)).toEqual([
        'manual:queued',
        'manual:started',
        'manual:completed',
      ]);
      expect((await directiveOf('cmd_join'))?.status).toBe('delivered');
    },
  );
});

describe('a directive that reaches the worker around the end of a turn', () => {
  const failingAfterText = () => [
    fauxAssistantMessage('Partial answer before the drop.', {
      stopReason: 'error',
      errorMessage: 'fetch failed',
    }),
    ...writeThenSubmit(),
  ];
  const microtasks = async (n: number) => {
    for (let i = 0; i < n; i++) await Promise.resolve();
  };

  it.each<[Worker, 'next_request' | 'interrupt']>([
    ['pi-core', 'next_request'],
    ['pi-core', 'interrupt'],
    ['sdk', 'next_request'],
    ['sdk', 'interrupt'],
  ])(
    'a %s directive (%s) sent any number of microtasks after the host saw the failed response never carries the execution on',
    async (worker, delivery) => {
      const outcomes: string[] = [];
      for (let n = 0; n <= 60; n++) {
        let sent: Promise<Receipt> | undefined;
        const { transport, coordinator, start, steerNow } = runtime(failingAfterText(), {
          worker,
          onWorkerFrame: (frame) => {
            if (frame.type !== 'observe' || !frame.failed || sent) return;
            sent = microtasks(n).then(() => steerNow('Keep the API.', 'cmd_late', delivery));
          },
        });
        const { runId, executionId, directiveOf } = await start();
        const final = await waitForProjection(transport, runId, settled);
        const receipt = await sent;
        const directive = await directiveOf('cmd_late');
        const ending =
          receipt?.status === 'rejected'
            ? `rejected:${receipt.error?.code}`
            : `${directive?.status}/${coordinator.getReceipt(runId, 'cmd_late')?.status}`;
        outcomes.push(
          `n=${n} ${final.status} calls=${final.executions[executionId]?.modelCallIds.length} ${ending}`,
        );
      }
      const expected = outcomes.map((line) => {
        const n = line.split(' ')[0];
        return line.endsWith('rejected:TARGET_TERMINAL')
          ? `${n} failed calls=1 rejected:TARGET_TERMINAL`
          : `${n} failed calls=1 expired/expired`;
      });
      expect(outcomes).toEqual(expected);
    },
    60_000,
  );

  /** Calls `before`, then holds the first response's last event for `k` microtasks. */
  const beforeFirstEnd = (k: number, before: () => void) => {
    let calls = 0;
    return (stream: StreamFn): StreamFn =>
      (model, context, options) => {
        if (++calls > 1) return stream(model, context, options);
        const inner = stream(model, context, options);
        const out = createAssistantMessageEventStream();
        void (async () => {
          const source = await inner;
          for await (const event of source) {
            if (event.type === 'error' || event.type === 'done') {
              before();
              await microtasks(k);
            }
            out.push(event);
          }
          out.end(await source.result());
        })();
        return out;
      };
  };

  it.each<[Worker, 'next_request' | 'interrupt']>([
    ['pi-core', 'next_request'],
    ['pi-core', 'interrupt'],
    ['sdk', 'next_request'],
    ['sdk', 'interrupt'],
  ])(
    'a %s directive (%s) sent any number of microtasks before a response that showed text fails is either a cut the execution goes on from, or expires with it',
    async (worker, delivery) => {
      const outcomes: string[] = [];
      for (let k = 0; k <= 40; k++) {
        let sent: Receipt | undefined;
        const { transport, start, steerNow } = runtime(failingAfterText(), {
          worker,
          wrapStream: beforeFirstEnd(k, () => {
            sent = steerNow('Stop and cite.', 'cmd_late', delivery);
          }),
        });
        const { runId, executionId, directiveOf } = await start();
        const final = await waitForProjection(transport, runId, settled);
        const [first] = final.executions[executionId]?.modelCallIds ?? [];
        const call = final.modelCalls[first ?? ''];
        const recorded = call?.interrupted ? 'cut' : call?.responseRef ? 'whole' : 'failed';
        outcomes.push(
          `k=${k} ${sent?.status} first=${recorded} ${final.status} calls=${final.executions[executionId]?.modelCallIds.length} ${(await directiveOf('cmd_late'))?.status}`,
        );
      }
      // Never a call recorded as failed with the execution going on anyway.
      const allowed = outcomes.map((line) => {
        const k = line.split(' ')[0];
        return line.includes('first=cut')
          ? `${k} queued first=cut succeeded calls=3 delivered`
          : `${k} queued first=failed failed calls=1 expired`;
      });
      expect(outcomes).toEqual(allowed);
      // A join never cuts; an interrupt that arrives in time does.
      if (delivery === 'next_request') expect(outcomes.join()).not.toContain('first=cut');
      else expect(outcomes.at(-1)).toContain('first=cut');
    },
    60_000,
  );

  /**
   * The first response shows text and holds; once the interrupt has cut it, the provider ends
   * it without a final event, or throws.
   */
  const cutWithout = (ending: 'no-final-event' | 'throws', streamed: Gate, release: Gate) => {
    let calls = 0;
    return (stream: StreamFn): StreamFn =>
      (model, context, options) => {
        if (++calls > 1) return stream(model, context, options);
        const inner = stream(model, context, options);
        if (ending === 'throws')
          return {
            async *[Symbol.asyncIterator]() {
              for await (const event of await inner) {
                yield event;
                if (event.type === 'text_delta') {
                  streamed.open();
                  await release.wait();
                  if (options?.signal?.aborted) throw new Error('This operation was aborted');
                }
              }
            },
            result: () => Promise.reject(new Error('This operation was aborted')),
          } as unknown as ReturnType<StreamFn>;
        const out = createAssistantMessageEventStream();
        void (async () => {
          const source = await inner;
          for await (const event of source) {
            if (event.type === 'done' || event.type === 'error') continue;
            out.push(event);
            if (event.type === 'text_delta') {
              streamed.open();
              await release.wait();
              if (options?.signal?.aborted) {
                out.end({ ...event.partial, stopReason: 'aborted' as const });
                return;
              }
            }
          }
          out.end(await source.result());
        })();
        return out;
      };
  };

  it.each<[Worker, 'no-final-event' | 'throws']>([
    ['pi-core', 'no-final-event'],
    ['pi-core', 'throws'],
    ['sdk', 'no-final-event'],
    ['sdk', 'throws'],
  ])(
    'a %s response cut by an interrupt whose provider then %s is recorded as cut and the execution goes on',
    async (worker, ending) => {
      const streamed = new Gate(),
        release = new Gate();
      const { transport, start } = runtime(
        [
          fauxAssistantMessage(
            [
              fauxText('A long answer the person did not want.'),
              fauxToolCall('write_artifact', { text: 'D.' }),
            ],
            { stopReason: 'toolUse' },
          ),
          ...writeThenSubmit(),
        ],
        { worker, wrapStream: cutWithout(ending, streamed, release) },
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
      expect(final.status).toBe('succeeded');
      const [cut, next] = final.executions[executionId]?.modelCallIds ?? [];
      expect(final.modelCalls[cut ?? '']).toMatchObject({ interrupted: true, responseRef: null });
      expect(
        events.find((e) => e.type === 'model.finished' && e.payload.modelCallId === cut)?.payload,
      ).toMatchObject({ interrupted: true });
      const directive = await directiveOf('cmd_cut');
      expect(directive?.status).toBe('delivered');
      expect(final.modelCalls[next ?? '']?.directiveIds).toEqual([directive?.directiveId]);
    },
  );

  it('a directive sent while a whole SDK reply without a tool call streams gets a turn of its own', async () => {
    const streamed = new Gate(),
      release = new Gate();
    const { transport, start } = runtime(
      [fauxAssistantMessage('A first answer without any tool call.'), ...writeThenSubmit()],
      { worker: 'sdk', wrapStream: holdFirstText(streamed, release) },
    );
    const { runId, executionId, steer, directiveOf } = await start();
    await streamed.wait();
    await tick();
    expect((await steer('Keep the API.', 'cmd_join')).status).toBe('queued');
    await tick();
    release.open();
    const final = await waitForProjection(transport, runId, settled);
    expect(final.status).toBe('succeeded');
    const directive = await directiveOf('cmd_join');
    expect(directive?.status).toBe('delivered');
    const [whole, next] = final.executions[executionId]?.modelCallIds ?? [];
    expect(final.modelCalls[whole ?? '']?.responseRef).toBe(`response_${whole}`);
    expect(final.modelCalls[next ?? '']?.directiveIds).toEqual([directive?.directiveId]);
  });

  it.each<Worker>(['pi-core', 'sdk'])(
    'a directive that reaches the %s worker after a turn ended in a tool call rides the next request',
    async (worker) => {
      let sent: Promise<Receipt> | undefined;
      const { transport, start, steerNow } = runtime(writeThenSubmit(), {
        worker,
        onWorkerFrame: (frame) => {
          if (frame.type !== 'observe' || sent) return;
          sent = microtasks(3).then(() => steerNow('Keep the API.', 'cmd_join'));
        },
      });
      const { runId, executionId, directiveOf } = await start();
      const final = await waitForProjection(transport, runId, settled);
      expect((await sent)?.status).toBe('queued');
      expect(final.status).toBe('succeeded');
      const directive = await directiveOf('cmd_join');
      expect(directive?.status).toBe('delivered');
      const [, next] = final.executions[executionId]?.modelCallIds ?? [];
      expect(final.modelCalls[next ?? '']?.directiveIds).toEqual([directive?.directiveId]);
    },
  );

  it.each<Worker>(['pi-core', 'sdk'])(
    'an interrupt that reaches the %s worker while it waits to retry a response that showed nothing carries the execution on',
    async (worker) => {
      let sent: Promise<Receipt> | undefined;
      const { transport, start, steerNow } = runtime(
        [
          // The provider asks for the retry an hour later: only the cut ends the wait.
          fauxAssistantMessage('', {
            stopReason: 'error',
            errorMessage: JSON.stringify({
              code: 'RATE_LIMIT',
              status: 429,
              retryAfterMs: 3_600_000,
              requestId: null,
            }),
          }),
          ...writeThenSubmit(),
        ],
        {
          worker,
          onWorkerFrame: (frame) => {
            if (frame.type !== 'observe' || !frame.failed || sent) return;
            sent = microtasks(100).then(() => steerNow('Stop and cite.', 'cmd_cut', 'interrupt'));
          },
        },
      );
      const { runId, executionId, directiveOf } = await start();
      const final = await waitForProjection(transport, runId, settled);
      expect((await sent)?.status).toBe('queued');
      expect(final.status).toBe('succeeded');
      const directive = await directiveOf('cmd_cut');
      expect(directive?.status).toBe('delivered');
      const [waited, next] = final.executions[executionId]?.modelCallIds ?? [];
      expect(final.modelCalls[waited ?? '']).toMatchObject({ responseRef: null, directiveIds: [] });
      expect(final.modelCalls[next ?? '']?.directiveIds).toEqual([directive?.directiveId]);
    },
  );
});

describe('empty and whitespace-only text', () => {
  /**
   * The stream frames each worker sends and the partial outputs the run keeps. `act` runs once
   * the first response, held by `wrap`, has shown its first text.
   */
  const streamed = async (
    worker: Worker,
    responses: FauxResponseStep[],
    options: {
      wrap?: (streamed: Gate, release: Gate) => (stream: StreamFn) => StreamFn;
      act?: (run: {
        steer: (text: string, commandId: string, delivery: 'interrupt') => Promise<Receipt>;
        cancel: () => Promise<Receipt>;
      }) => Promise<unknown>;
      contextPolicy?: ProfileContextPolicy;
      brief?: string;
    } = {},
  ) => {
    const gates = { streamed: new Gate(), release: new Gate() };
    const { transport, coordinator, start, streamFrames } = runtime(responses, {
      worker,
      ...(options.wrap ? { wrapStream: options.wrap(gates.streamed, gates.release) } : {}),
      ...(options.contextPolicy ? { contextPolicy: options.contextPolicy } : {}),
    });
    const { runId, executionId, steer, published } = await start(options.brief);
    if (options.act) {
      await gates.streamed.wait();
      await tick();
      await options.act({
        steer,
        cancel: () =>
          transport.sendCommand({
            schemaVersion: '0.1',
            commandId: 'cmd_cancel',
            runId,
            type: 'cancel',
            payload: { scope: { kind: 'run' }, reason: 'stop' },
          }),
      });
      await tick();
      gates.release.open();
    }
    const final = await waitForProjection(transport, runId, settled);
    const frames = streamFrames.map(
      (frame) => `${frame.modelCallId}#${frame.chunkIndex}=${JSON.stringify(frame.text)}`,
    );
    const partial = Object.fromEntries(
      Object.entries(coordinator.getSnapshot(runId).partialOutputs ?? {}).map(([id, output]) => [
        id,
        output.text,
      ]),
    );
    const calls = final.executions[executionId]?.modelCallIds ?? [];
    const shown = published.map(
      (frame) => `${frame.modelCallId}#${frame.chunkIndex}=${JSON.stringify(frame.text)}`,
    );
    return { final, frames, partial, calls, shown };
  };
  // A transient failure the provider asks to retry at once, so no retry waits.
  const failing = (text: string) =>
    fauxAssistantMessage(text, {
      stopReason: 'error',
      errorMessage: JSON.stringify({
        code: 'TRANSPORT',
        status: null,
        retryAfterMs: 0,
        requestId: null,
      }),
    });
  const submitAfterWrite: FauxResponseStep[] = [
    (context) =>
      fauxAssistantMessage(
        [fauxToolCall('submit_result', { artifactVersionIds: [lastArtifactVersion(context)] })],
        { stopReason: 'toolUse' },
      ),
    fauxAssistantMessage('Done.'),
  ];
  const whitespaceThenText = () =>
    fauxAssistantMessage(
      [fauxText('\n'), fauxText('Real text.'), fauxToolCall('write_artifact', { text: 'A.' })],
      { stopReason: 'toolUse' },
    );

  it.each<Worker>(['pi-core', 'sdk'])(
    'a %s call that fails with only an empty text sends no frame and keeps no partial output, retried or not',
    async (worker) => {
      const { final, frames, partial } = await streamed(worker, [
        failing(''),
        failing(''),
        failing(''),
      ]);
      expect(final.status).toBe('failed');
      expect(Object.keys(final.modelCalls)).toHaveLength(3);
      expect(frames).toEqual([]);
      expect(partial).toEqual({});
    },
  );

  it.each<Worker>(['pi-core', 'sdk'])(
    'a whole %s response that starts with an empty text sends only its text',
    async (worker) => {
      const { final, frames } = await streamed(worker, [
        fauxAssistantMessage(
          [fauxText(''), fauxText('Hello there.'), fauxToolCall('write_artifact', { text: 'A.' })],
          { stopReason: 'toolUse' },
        ),
        ...submitAfterWrite,
      ]);
      expect(final.status).toBe('succeeded');
      expect(frames).toEqual(['call_0001#0="Hello there."']);
    },
  );

  it.each<Worker>(['pi-core', 'sdk'])(
    'a %s call that fails after only whitespace and is retried sends no frame and keeps no partial output',
    async (worker) => {
      const { final, frames, partial } = await streamed(worker, [
        failing('\n'),
        ...writeThenSubmit(),
      ]);
      expect(final.status).toBe('succeeded');
      const [retried] = Object.keys(final.modelCalls);
      expect(frames.filter((frame) => frame.startsWith(`${retried}#`))).toEqual([]);
      expect(partial).toEqual({});
    },
  );

  it.each<Worker>(['pi-core', 'sdk'])(
    'a %s call that fails after only whitespace keeps nothing, even as the last attempt',
    async (worker) => {
      const { final, frames, partial } = await streamed(worker, [
        failing('\n'),
        failing('\n'),
        failing('\n'),
      ]);
      expect(final.status).toBe('failed');
      expect(Object.keys(final.modelCalls)).toHaveLength(3);
      expect(frames).toEqual([]);
      expect(partial).toEqual({});
    },
  );

  it.each<Worker>(['pi-core', 'sdk'])(
    'a %s call that fails after only whitespace with an error that is not retried keeps nothing',
    async (worker) => {
      const { final, frames, partial } = await streamed(worker, [
        fauxAssistantMessage('\n', {
          stopReason: 'error',
          errorMessage: JSON.stringify({
            code: 'AUTH',
            status: 401,
            retryAfterMs: null,
            requestId: null,
          }),
        }),
        ...writeThenSubmit(),
      ]);
      expect(final.status).toBe('failed');
      expect(frames).toEqual([]);
      expect(partial).toEqual({});
    },
  );

  it.each<Worker>(['pi-core', 'sdk'])(
    'a %s call that overflows the context after only whitespace keeps nothing, and its retry after the forced compaction goes on',
    async (worker) => {
      const { final, frames, partial, calls } = await streamed(
        worker,
        [
          fauxAssistantMessage([fauxToolCall('write_artifact', { text: 'First.' })], {
            stopReason: 'toolUse',
          }),
          fauxAssistantMessage('\n', {
            stopReason: 'error',
            errorMessage: JSON.stringify({
              code: 'CONTEXT_OVERFLOW',
              status: 400,
              retryAfterMs: null,
              requestId: null,
            }),
          }),
          fauxAssistantMessage('Summary that keeps the required task.'),
          ...writeThenSubmit(),
        ],
        {
          contextPolicy: contextPolicy('core-auto', 64000),
          brief: 'Keep this requirement. '.repeat(40),
        },
      );
      expect(final.status).toBe('succeeded');
      expect(final.modelCalls[calls[1] ?? '']?.responseRef).toBeNull();
      expect(frames).toEqual([]);
      expect(partial).toEqual({});
    },
  );

  it.each<Worker>(['pi-core', 'sdk'])(
    'a %s call cut by an interrupt after only whitespace keeps nothing',
    async (worker) => {
      const { final, frames, partial, calls } = await streamed(
        worker,
        [whitespaceThenText(), ...writeThenSubmit()],
        {
          wrap: holdFirstText,
          act: ({ steer }) => steer('Stop and cite.', 'cmd_cut', 'interrupt'),
        },
      );
      expect(final.status).toBe('succeeded');
      expect(final.modelCalls[calls[0] ?? '']?.interrupted).toBe(true);
      expect(frames.filter((frame) => frame.startsWith(`${calls[0]}#`))).toEqual([]);
      expect(partial).toEqual({});
    },
  );

  it.each<Worker>(['pi-core', 'sdk'])(
    'a %s call cancelled after only whitespace sends no frame',
    async (worker) => {
      const { final, frames, partial } = await streamed(
        worker,
        [whitespaceThenText(), ...writeThenSubmit()],
        { wrap: holdFirstText, act: ({ cancel }) => cancel() },
      );
      expect(final.status).toBe('cancelled');
      expect(frames).toEqual([]);
      expect(partial).toEqual({});
    },
  );

  it.each<Worker>(['pi-core', 'sdk'])(
    'a %s call whose stream throws after only whitespace sends no frame',
    async (worker) => {
      const { final, frames, partial } = await streamed(
        worker,
        [fauxAssistantMessage([fauxText('\n'), fauxText('Real text.')]), ...writeThenSubmit()],
        { wrap: throwAfterFirstText, act: async () => {} },
      );
      expect(final.status).toBe('failed');
      expect(frames).toEqual([]);
      expect(partial).toEqual({});
    },
  );

  // A tool call is not a letter: whitespace before it waits for the response to end whole.
  it.each<Worker>(['pi-core', 'sdk'])(
    'whitespace before a %s tool call goes out when the response ends whole, on the same call',
    async (worker) => {
      const { final, frames, shown } = await streamed(worker, [
        fauxAssistantMessage([fauxText('\n \n'), fauxToolCall('write_artifact', { text: 'A.' })], {
          stopReason: 'toolUse',
        }),
        ...submitAfterWrite,
      ]);
      expect(final.status).toBe('succeeded');
      expect(frames.filter((frame) => frame.startsWith('call_0001#'))).toEqual([
        'call_0001#0="\\n \\n"',
      ]);
      // The host still had the call open, so it kept and published the fragment.
      expect(shown.filter((frame) => frame.startsWith('call_0001#'))).toEqual([
        'call_0001#0="\\n \\n"',
      ]);
    },
  );

  it.each<Worker>(['pi-core', 'sdk'])(
    'whitespace before a %s tool call is not sent when the response then fails',
    async (worker) => {
      const { final, frames, partial } = await streamed(worker, [
        fauxAssistantMessage([fauxText('\n\n'), fauxToolCall('write_artifact', { text: 'A.' })], {
          stopReason: 'error',
          errorMessage: 'fetch failed',
        }),
        ...writeThenSubmit(),
      ]);
      expect(final.status).toBe('failed');
      expect(frames).toEqual([]);
      expect(partial).toEqual({});
    },
  );

  it.each<Worker>(['pi-core', 'sdk'])(
    'whitespace before a %s tool call is not sent when an interrupt cuts the call while its arguments stream',
    async (worker) => {
      const { final, frames, partial, calls } = await streamed(
        worker,
        [
          fauxAssistantMessage(
            [fauxText('\n\n'), fauxToolCall('write_artifact', { text: 'A long draft.' })],
            { stopReason: 'toolUse' },
          ),
          ...writeThenSubmit(),
        ],
        {
          wrap: (streamed, release) => holdFirstText(streamed, release, false, 'toolcall_delta'),
          act: ({ steer }) => steer('Stop and cite.', 'cmd_cut', 'interrupt'),
        },
      );
      expect(final.status).toBe('succeeded');
      expect(final.modelCalls[calls[0] ?? '']?.interrupted).toBe(true);
      expect(frames.filter((frame) => frame.startsWith(`${calls[0]}#`))).toEqual([]);
      expect(partial).toEqual({});
    },
  );

  it.each<Worker>(['pi-core', 'sdk'])(
    'whitespace before a %s tool call goes out with the first letter that follows the call',
    async (worker) => {
      const { final, frames } = await streamed(worker, [
        fauxAssistantMessage(
          [fauxText('\n\n'), fauxToolCall('write_artifact', { text: 'A.' }), fauxText('Writing.')],
          { stopReason: 'toolUse' },
        ),
        ...submitAfterWrite,
      ]);
      expect(final.status).toBe('succeeded');
      expect(frames.filter((frame) => frame.startsWith('call_0001#'))).toEqual([
        'call_0001#0="\\n\\n"',
        'call_0001#1="Writing."',
      ]);
    },
  );

  it.each<Worker>(['pi-core', 'sdk'])(
    'a whole %s response of only whitespace sends it',
    async (worker) => {
      const { final, frames, calls } = await streamed(worker, [
        fauxAssistantMessage([fauxText('\n'), fauxText('\n')]),
        ...writeThenSubmit(),
      ]);
      expect(final.modelCalls[calls[0] ?? '']?.responseRef).not.toBeNull();
      expect(frames.filter((frame) => frame.startsWith('call_0001#'))).toEqual([
        'call_0001#0="\\n"',
        'call_0001#1="\\n"',
      ]);
    },
  );

  it.each<Worker>(['pi-core', 'sdk'])(
    'whitespace after the first %s text goes out at once, and stays when the call then fails',
    async (worker) => {
      const { final, frames, partial } = await streamed(worker, [
        fauxAssistantMessage([fauxText('\n'), fauxText(' '), fauxText('Shown.'), fauxText(' \n')], {
          stopReason: 'error',
          errorMessage: 'fetch failed',
        }),
        ...writeThenSubmit(),
      ]);
      expect(final.status).toBe('failed');
      expect(frames).toEqual([
        'call_0001#0="\\n"',
        'call_0001#1=" "',
        'call_0001#2="Shown."',
        'call_0001#3=" \\n"',
      ]);
      expect(partial).toEqual({ call_0001: '\n Shown. \n' });
    },
  );

  it.each<Worker>(['pi-core', 'sdk'])(
    'a %s retry streams its text as its own call, from its first fragment',
    async (worker) => {
      const { final, frames, calls } = await streamed(worker, [
        failing('\n'),
        fauxAssistantMessage(
          [
            fauxText('\n'),
            fauxText('Hello there.'),
            fauxToolCall('write_artifact', { text: 'A.' }),
          ],
          { stopReason: 'toolUse' },
        ),
        ...submitAfterWrite,
      ]);
      expect(final.status).toBe('succeeded');
      const [failed, retry] = calls;
      expect(frames.filter((frame) => !frame.startsWith(`${failed}#`)).slice(0, 2)).toEqual([
        `${retry}#0="\\n"`,
        `${retry}#1="Hello there."`,
      ]);
      expect(frames.filter((frame) => frame.startsWith(`${failed}#`))).toEqual([]);
    },
  );

  it.each<Worker>(['pi-core', 'sdk'])(
    'a %s request sent again after a forced compaction streams its text as its own call',
    async (worker) => {
      const { final, frames, calls } = await streamed(
        worker,
        [
          fauxAssistantMessage([fauxToolCall('write_artifact', { text: 'First.' })], {
            stopReason: 'toolUse',
          }),
          fauxAssistantMessage('\n', {
            stopReason: 'error',
            errorMessage: JSON.stringify({
              code: 'CONTEXT_OVERFLOW',
              status: 400,
              retryAfterMs: null,
              requestId: null,
            }),
          }),
          fauxAssistantMessage('Summary that keeps the required task.'),
          fauxAssistantMessage(
            [fauxText('\n'), fauxText('Again.'), fauxToolCall('write_artifact', { text: 'B.' })],
            { stopReason: 'toolUse' },
          ),
          ...submitAfterWrite,
        ],
        {
          contextPolicy: contextPolicy('core-auto', 64000),
          brief: 'Keep this requirement. '.repeat(40),
        },
      );
      expect(final.status).toBe('succeeded');
      const resent = calls[3] ?? '';
      expect(frames.slice(0, 2)).toEqual([`${resent}#0="\\n"`, `${resent}#1="Again."`]);
    },
  );

  it.each<Worker>(['pi-core', 'sdk'])(
    'a %s call that ends without its final event after only whitespace keeps nothing',
    async (worker) => {
      const { final, frames, partial } = await streamed(
        worker,
        [
          fauxAssistantMessage('\n', {
            stopReason: 'error',
            errorMessage: JSON.stringify({
              code: 'AUTH',
              status: 401,
              retryAfterMs: null,
              requestId: null,
            }),
          }),
          ...writeThenSubmit(),
        ],
        {
          // The provider never sends `done` or `error`; only the result says how it ended.
          wrap: () => (stream) => {
            let calls = 0;
            return (model, context, options) => {
              if (++calls > 1) return stream(model, context, options);
              const out = createAssistantMessageEventStream();
              void (async () => {
                const source = await stream(model, context, options);
                for await (const event of source)
                  if (event.type !== 'done' && event.type !== 'error') out.push(event);
                out.end(await source.result());
              })();
              return out;
            };
          },
        },
      );
      expect(final.status).toBe('failed');
      expect(frames).toEqual([]);
      expect(partial).toEqual({});
    },
  );

  it.each<Worker>(['pi-core', 'sdk'])(
    'a whole %s response that starts with whitespace streams every character of it, in order',
    async (worker) => {
      const text = ['\n', ' \n', '\t', 'Hello there.', ' ', 'Again.'];
      const { final, frames } = await streamed(worker, [
        fauxAssistantMessage(
          [...text.map((part) => fauxText(part)), fauxToolCall('write_artifact', { text: 'A.' })],
          { stopReason: 'toolUse' },
        ),
        ...submitAfterWrite,
      ]);
      expect(final.status).toBe('succeeded');
      const first = frames.filter((frame) => frame.startsWith('call_0001#'));
      expect(first.map((frame) => frame.replace(/^call_0001#\d+=/, ''))).toEqual(
        text.map((part) => JSON.stringify(part)),
      );
      expect(
        first.map((frame) => JSON.parse(frame.replace(/^call_0001#\d+=/, '')) as string).join(''),
      ).toBe(text.join(''));
      expect(first.map((frame) => frame.match(/#(\d+)=/)?.[1])).toEqual(
        text.map((_, index) => String(index)),
      );
    },
  );
});

describe('an interrupt before the adapter hands the SDK worker over', () => {
  it('is lowered to the next request and rides the first request without cutting anything', async () => {
    const resources = new Gate();
    const { transport, start, steerNow } = runtime(writeThenSubmit(), {
      worker: 'sdk',
      harness: async () => {
        await resources.wait();
        return { bundles: [], extensions: [], skills: [], startupCommands: [] };
      },
    });
    const { runId, executionId, events, directiveOf } = await start();
    await tick();
    // The adapter is still preparing the harness resources: start() has not returned.
    const receipt = steerNow('Cite sources.', 'cmd_cut', 'interrupt');
    resources.open();
    const final = await waitForProjection(transport, runId, settled);

    expect(receipt).toMatchObject({ status: 'queued', requestedBoundary: 'next_request' });
    expect(
      events.find((e) => e.type === 'directive.accepted' && e.commandId === 'cmd_cut')?.payload,
    ).toMatchObject({ delivery: 'next_request' });
    expect(final.status).toBe('succeeded');
    const directive = await directiveOf('cmd_cut');
    expect(directive?.status).toBe('delivered');
    const [first] = final.executions[executionId]?.modelCallIds ?? [];
    expect(final.modelCalls[first ?? '']?.directiveIds).toEqual([directive?.directiveId]);
    expect(events.filter((e) => e.type === 'model.finished' && e.payload.interrupted)).toEqual([]);
  });
});
