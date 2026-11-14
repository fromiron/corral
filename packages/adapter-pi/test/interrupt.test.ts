import type { AgentObservation, AgentStartInput, RunEvent } from '@corral/contracts';
import { type RunProjection, resolveProfileContext, waitForProjection } from '@corral/core';
import { Gate, linearCorral } from '@corral/testkit';
import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  createFauxCore,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import { PiAgentAdapter } from '../src/adapter.ts';
import { memoryChannelPair } from '../src/channel.ts';
import { runWorker } from '../src/worker.ts';
import { DIRECTIVE_PREFIX } from '../src/worker-tools.ts';
import { ACCESS_TOKEN, liveRuntime, recordingHost } from './harness.ts';

// Interrupt delivery (docs/specs/features/reins.md, delivery `interrupt`): the worker cuts only a
// model response in flight, carries the directive into the next request and goes on with the
// same execution. A running tool is never cut.

const TEXT = 'Stop and cite primary sources.';
const settled = (p: RunProjection) => ['succeeded', 'failed', 'cancelled'].includes(p.status);
const tick = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const sawDirective = (context: { messages: unknown[] }) =>
  JSON.stringify(context.messages).includes(TEXT);

function lastArtifactVersion(context: { messages: unknown[] }): string {
  for (const message of [...context.messages].reverse()) {
    const result = message as {
      role?: string;
      toolName?: string;
      content?: { type: string; text?: string }[];
    };
    if (result.role !== 'toolResult' || result.toolName !== 'write_artifact') continue;
    for (const part of result.content ?? [])
      if (part.type === 'text' && part.text) {
        const value = JSON.parse(part.text) as { artifactVersionId?: string };
        if (value.artifactVersionId) return value.artifactVersionId;
      }
  }
  throw new Error('no write_artifact result in the transcript');
}

const writeThenSubmit = (seen: boolean[]): FauxResponseStep[] => [
  (context) => {
    seen.push(sawDirective(context));
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

async function liveRun(transport: ReturnType<typeof liveRuntime>['transport'], brief?: string) {
  const definition = linearCorral(['writer']);
  if (brief) definition.input.brief = brief;
  const { runId, receipt } = await transport.startRun({
    schemaVersion: '0.1',
    commandId: 'cmd_live',
    definition,
    mode: 'live',
  });
  if (!runId) throw new Error(JSON.stringify(receipt.error));
  const events: RunEvent[] = [];
  transport.subscribe(runId, 0, { onEvent: (e) => events.push(e), onFrame: () => {} });
  const interrupt = async (
    text = TEXT,
    delivery: 'interrupt' | 'next_request' = 'interrupt',
    commandId = 'cmd_interrupt',
  ) => {
    const p = await waitForProjection(transport, runId, (p) => p.executionOrder.length === 1);
    return transport.sendCommand({
      schemaVersion: '0.1',
      commandId,
      runId,
      type: 'steer',
      payload: { targetExecutionId: p.executionOrder[0] ?? '', text, delivery },
    });
  };
  return { runId, events, interrupt };
}

function startInput(): AgentStartInput {
  const role = linearCorral(['writer']).roles[0];
  if (!role) throw new Error('no role');
  return {
    runId: 'run_1',
    executionId: 'exec_1',
    taskId: 'task_1',
    nodeId: 'writer',
    attemptNo: 1,
    role,
    modelProfile: 'model-a',
    mode: 'live',
    model: { profile: 'model-a', provider: 'openai', modelId: 'faux-1', auth: 'oauth' },
    depth: 0,
    round: null,
    criteriaVersionId: 'crit_0001',
    assignment: { kind: 'scheduled' },
    capabilities: { delegateTo: [], askTo: [] },
    inputs: [{ name: 'brief', kind: 'run_input', artifactVersionId: null, text: 'Brief.' }],
  };
}

/** The core worker under a recording host, without a Coordinator. */
function coreWorker(responses: FauxResponseStep[], overrides: Parameters<typeof recordingHost>[0]) {
  const faux = createFauxCore({});
  faux.setResponses(responses);
  const observed: AgentObservation[] = [];
  const { host } = recordingHost({
    observe: async (o) => void observed.push(o),
    ...overrides,
  });
  const adapter = new PiAgentAdapter({
    spawn: () => {
      const pair = memoryChannelPair();
      runWorker(pair.worker, { streamFn: faux.streamSimple, resolveModel: () => faux.getModel() });
      return pair.host;
    },
    credentials: async () => ACCESS_TOKEN,
  });
  return { adapter, host, observed, faux };
}

/** Index of the first message whose JSON contains `needle`. */
const indexOf = (messages: unknown[], needle: string) =>
  messages.findIndex((message) => JSON.stringify(message).includes(needle));

describe('interrupt on the core worker', () => {
  it('cuts the response in flight, carries the directive into the next request and succeeds', async () => {
    const entered = new Gate(),
      release = new Gate();
    const seen: boolean[] = [];
    const { transport } = liveRuntime([
      async (context) => {
        seen.push(sawDirective(context));
        entered.open();
        await release.wait();
        return fauxAssistantMessage('A long answer the person did not want.');
      },
      ...writeThenSubmit(seen),
    ]);
    const { runId, events, interrupt } = await liveRun(transport);
    await entered.wait();
    expect(await interrupt()).toMatchObject({ status: 'queued', requestedBoundary: 'immediate' });
    await tick();
    release.open();
    const final = await waitForProjection(transport, runId, settled);

    expect(final.status).toBe('succeeded');
    expect(seen).toEqual([false, true]);
    const [executionId] = final.executionOrder;
    // The same execution and attempt went on; nothing was retried as a new attempt.
    expect(final.executionOrder).toHaveLength(1);
    expect(final.executions[executionId ?? '']?.status).toBe('succeeded');
    const [cut, next] = final.executions[executionId ?? '']?.modelCallIds ?? [];
    const directiveId = final.directiveOrder[0] ?? '';
    expect(final.modelCalls[next ?? '']?.directiveIds).toEqual([directiveId]);
    expect(final.directives[directiveId]?.status).toBe('delivered');
    const finished = events.filter((e) => e.type === 'model.finished');
    const cutFinished = finished.find((e) => e.payload.modelCallId === cut);
    // The cut call is marked and keeps the usage its provider reported.
    expect(cutFinished?.payload).toMatchObject({ interrupted: true, certainty: 'reported' });
    expect(cutFinished?.payload.normalizedUsage.inputTokens).toBeGreaterThan(0);
    const others = finished.filter((e) => e.payload.modelCallId !== cut);
    expect(others.length).toBeGreaterThan(0);
    expect(others.map((e) => e.payload.interrupted).filter(Boolean)).toEqual([]);
  });

  it('a request cut by an interrupt is not retried, even when the provider reports a transient error', async () => {
    const entered = new Gate(),
      release = new Gate();
    const seen: boolean[] = [];
    const { transport } = liveRuntime(
      [
        async () => {
          entered.open();
          await release.wait();
          return fauxAssistantMessage('A long answer.');
        },
        ...writeThenSubmit(seen),
      ],
      {
        // A provider that reports its cut connection as a transient transport error, and no usage.
        wrapStream: (stream) => (model, context, options) => {
          const inner = stream(model, context, options);
          const out = createAssistantMessageEventStream();
          void (async () => {
            for await (const event of await inner) {
              if (event.type === 'error' && event.reason === 'aborted') {
                const failed: AssistantMessage = {
                  ...event.error,
                  stopReason: 'error',
                  errorMessage: 'fetch failed',
                  usage: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 0,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                  },
                };
                out.push({ type: 'error', reason: 'error', error: failed });
                out.end(failed);
                return;
              }
              out.push(event);
            }
            out.end(await (await inner).result());
          })();
          return out;
        },
      },
    );
    const { runId, events, interrupt } = await liveRun(transport);
    await entered.wait();
    await interrupt();
    await tick();
    release.open();
    const final = await waitForProjection(transport, runId, settled);
    expect(final.status).toBe('succeeded');
    const recorded = events.filter((e) => e.type === 'model.request_recorded');
    expect(recorded.map((e) => e.payload.purpose)).not.toContain('retry');
    expect(seen).toEqual([true]);
    // Unreported usage of the cut call is unknown, never zero.
    const [cut] = final.executions[final.executionOrder[0] ?? '']?.modelCallIds ?? [];
    const cutFinished = events.find(
      (e) => e.type === 'model.finished' && e.payload.modelCallId === cut,
    );
    expect(cutFinished?.payload).toMatchObject({
      interrupted: true,
      certainty: 'unknown',
      normalizedUsage: {
        inputTokens: null,
        outputTokens: null,
        cachedInputTokens: null,
        reasoningTokens: null,
      },
    });
  });

  it('a tool running at the interrupt runs to its end and the directive follows its result', async () => {
    const running = new Gate(),
      finish = new Gate();
    let toolFinished = false;
    const contexts: unknown[][] = [];
    const { adapter, host, observed } = coreWorker(
      [
        fauxAssistantMessage([fauxToolCall('write_artifact', { text: 'Draft.' })], {
          stopReason: 'toolUse',
        }),
        (context) => {
          contexts.push(JSON.parse(JSON.stringify(context.messages)));
          return fauxAssistantMessage('Done.');
        },
      ],
      {
        executeTool: async (toolCallId) => {
          running.open();
          await finish.wait();
          toolFinished = true;
          return { ok: true, toolCallId, result: { artifactVersionId: 'av_1' } };
        },
      },
    );
    const handle = await adapter.start(startInput(), host);
    await running.wait();
    handle.interrupt?.({ directiveId: 'dir_tool', text: TEXT, origin: 'user' as const });
    await tick();
    finish.open();
    expect((await handle.waitForSettlement()).outcome).toBe('succeeded');
    expect(toolFinished).toBe(true);
    expect(contexts).toHaveLength(1);
    const messages = contexts[0] ?? [];
    const result = messages.findIndex((m) => (m as { role?: string }).role === 'toolResult');
    expect(result).toBeGreaterThan(-1);
    expect(JSON.stringify(messages[result])).not.toContain('aborted');
    expect(indexOf(messages, `${DIRECTIVE_PREFIX}dir_tool)`)).toBeGreaterThan(result);
    expect(observed.map((o) => o.interrupted)).toEqual([undefined, undefined]);
  });

  it('an interrupt between requests cuts nothing and rides the next request', async () => {
    const authorizing = new Gate(),
      authorize = new Gate();
    const contexts: unknown[][] = [];
    const { adapter, host, observed } = coreWorker(
      [
        fauxAssistantMessage([fauxToolCall('write_artifact', { text: 'Draft.' })], {
          stopReason: 'toolUse',
        }),
        (context) => {
          contexts.push(JSON.parse(JSON.stringify(context.messages)));
          return fauxAssistantMessage('Done.');
        },
      ],
      {
        authorizeTool: async () => {
          authorizing.open();
          await authorize.wait();
          return { ok: true, toolCallId: 'tool_1' };
        },
      },
    );
    const handle = await adapter.start(startInput(), host);
    await authorizing.wait();
    handle.interrupt?.({ directiveId: 'dir_between', text: TEXT, origin: 'user' as const });
    await tick();
    authorize.open();
    expect((await handle.waitForSettlement()).outcome).toBe('succeeded');
    expect(contexts).toHaveLength(1);
    expect(indexOf(contexts[0] ?? [], `${DIRECTIVE_PREFIX}dir_between)`)).toBeGreaterThan(-1);
    expect(observed.map((o) => o.interrupted)).toEqual([undefined, undefined]);
  });

  it('a cancel after an interrupt ends the execution as cancelled', async () => {
    const entered = new Gate(),
      release = new Gate();
    let later = 0;
    const { adapter, host } = coreWorker(
      [
        async () => {
          entered.open();
          await release.wait();
          return fauxAssistantMessage('A long answer.');
        },
        () => {
          later++;
          return fauxAssistantMessage('Should not run.');
        },
      ],
      {},
    );
    const handle = await adapter.start(startInput(), host);
    await entered.wait();
    handle.interrupt?.({ directiveId: 'dir_cancel', text: TEXT, origin: 'user' as const });
    const cancelled = handle.cancel('stopped');
    await tick();
    release.open();
    await cancelled;
    expect((await handle.waitForSettlement()).outcome).toBe('cancelled');
    expect(later).toBe(0);
  });

  it('an interrupt after an automatic compaction goes on from the compacted request, not the full history', async () => {
    const policy = resolveProfileContext(
      { contextWindow: 4000, compaction: { reserveTokens: 0, keepRecentTokens: 0 } },
      { contextWindow: 4000, source: 'catalog' },
      'core-auto',
      256,
    ).policy;
    if (!policy) throw new Error('context policy');
    const summaries = async (cut: boolean) => {
      const entered = new Gate(),
        release = new Gate();
      const seen: boolean[] = [];
      const { transport } = liveRuntime(
        [
          fauxAssistantMessage('Summary that keeps the required task.'),
          async () => {
            entered.open();
            await release.wait();
            return fauxAssistantMessage([fauxToolCall('write_artifact', { text: 'Draft.' })], {
              stopReason: 'toolUse',
            });
          },
          ...(cut ? writeThenSubmit(seen) : writeThenSubmit(seen).slice(1)),
        ],
        { contextPolicy: policy },
      );
      const { runId, events, interrupt } = await liveRun(
        transport,
        'Keep this requirement. '.repeat(700),
      );
      await entered.wait();
      if (cut) await interrupt();
      await tick();
      release.open();
      const final = await waitForProjection(transport, runId, settled);
      const purposes = events
        .filter((e) => e.type === 'model.request_recorded')
        .map((e) => e.payload.purpose);
      return { status: final.status, compactions: purposes.filter((p) => p === 'compaction') };
    };
    const plain = await summaries(false);
    const interrupted = await summaries(true);
    expect(plain.status).toBe('succeeded');
    expect(interrupted.status).toBe('succeeded');
    expect(interrupted.compactions).toEqual(plain.compactions);
  });

  it('after a joined directive, an interrupt leads the next request as the last directive', async () => {
    const first = new Gate(),
      firstRelease = new Gate(),
      second = new Gate(),
      secondRelease = new Gate();
    let after: unknown[] = [];
    const { transport } = liveRuntime([
      async () => {
        first.open();
        await firstRelease.wait();
        return fauxAssistantMessage([fauxToolCall('write_artifact', { text: 'Draft.' })], {
          stopReason: 'toolUse',
        });
      },
      async () => {
        second.open();
        await secondRelease.wait();
        return fauxAssistantMessage('A long answer.');
      },
      (context) => {
        after = JSON.parse(JSON.stringify(context.messages));
        return fauxAssistantMessage(
          [fauxToolCall('submit_result', { artifactVersionIds: [lastArtifactVersion(context)] })],
          { stopReason: 'toolUse' },
        );
      },
      fauxAssistantMessage('Done.'),
    ]);
    const { runId, interrupt } = await liveRun(transport);
    await first.wait();
    await interrupt('Joined: keep the API.', 'next_request', 'cmd_join');
    firstRelease.open();
    await second.wait();
    await interrupt('Interrupt: cite sources.');
    await tick();
    secondRelease.open();
    const final = await waitForProjection(transport, runId, settled);
    expect(final.status).toBe('succeeded');
    const directiveMessages = after
      .map((message, index) => ({ index, text: JSON.stringify(message) }))
      .filter(({ text }) => text.includes(DIRECTIVE_PREFIX));
    expect(directiveMessages.map(({ text }) => text.includes('Joined'))).toEqual([true, false]);
    expect(directiveMessages.at(-1)?.text).toContain('Interrupt: cite sources.');
    // Each directive is in one message only: the joined one, then the interrupt, last.
    expect(directiveMessages).toHaveLength(2);
  });

  /** The directive messages of one request, in order, and how many state sections it holds. */
  const directivesOf = (messages: unknown[]) => ({
    directives: messages
      .map((message) => message as { role?: string; content?: unknown })
      .filter(
        (m) =>
          m.role === 'user' &&
          typeof m.content === 'string' &&
          m.content.startsWith(DIRECTIVE_PREFIX),
      )
      .map((m) => (m.content as string).slice(DIRECTIVE_PREFIX.length).split(')')[0]),
    states: messages.filter((message) => {
      const content = (message as { content?: unknown }).content;
      return typeof content === 'string' && content.startsWith('[Corral current state]');
    }).length,
  });

  /** Two directives under a Coordinator, a cut response, then the requests that follow it. */
  const twoDirectivesAroundCut = async (
    order: { text: string; delivery: 'interrupt' | 'next_request'; commandId: string }[],
  ) => {
    const entered = new Gate(),
      release = new Gate();
    const requests: unknown[][] = [];
    const capture = (context: { messages: unknown[] }) =>
      void requests.push(JSON.parse(JSON.stringify(context.messages)));
    const { transport } = liveRuntime([
      async () => {
        entered.open();
        await release.wait();
        return fauxAssistantMessage('A long answer.');
      },
      (context) => {
        capture(context);
        return fauxAssistantMessage([fauxToolCall('write_artifact', { text: 'Cited.' })], {
          stopReason: 'toolUse',
        });
      },
      (context) => {
        capture(context);
        return fauxAssistantMessage(
          [fauxToolCall('submit_result', { artifactVersionIds: [lastArtifactVersion(context)] })],
          { stopReason: 'toolUse' },
        );
      },
      fauxAssistantMessage('Done.'),
    ]);
    const { runId, interrupt } = await liveRun(transport);
    await entered.wait();
    for (const { text, delivery, commandId } of order) await interrupt(text, delivery, commandId);
    await tick();
    release.open();
    const final = await waitForProjection(transport, runId, settled);
    const ids = Object.fromEntries(
      final.directiveOrder.map((id) => [final.directives[id]?.text ?? '', id]),
    );
    return { final, requests, ids };
  };

  it('a joined directive still waiting at the cut goes ahead of the interrupt, which comes last', async () => {
    const { final, requests, ids } = await twoDirectivesAroundCut([
      { text: 'Joined: keep the API.', delivery: 'next_request', commandId: 'cmd_join' },
      { text: 'Interrupt: cite sources.', delivery: 'interrupt', commandId: 'cmd_interrupt' },
    ]);
    expect(final.status).toBe('succeeded');
    const joined = ids['Joined: keep the API.'] ?? '';
    const cutIn = ids['Interrupt: cite sources.'] ?? '';
    expect(requests).toHaveLength(2);
    // Right after the cut and in the request after it: arrival order, the interrupt last.
    for (const messages of requests)
      expect(directivesOf(messages)).toEqual({ directives: [joined, cutIn], states: 1 });
    for (const id of [joined, cutIn]) {
      expect(final.directives[id]?.status).toBe('delivered');
      expect(
        Object.values(final.modelCalls).filter((call) => call.directiveIds.includes(id)),
      ).toHaveLength(1);
    }
    const [, resumed] = final.executions[final.executionOrder[0] ?? '']?.modelCallIds ?? [];
    expect([...(final.modelCalls[resumed ?? '']?.directiveIds ?? [])].sort()).toEqual(
      [joined, cutIn].sort(),
    );
  });

  it('a directive joining after the interrupt follows it', async () => {
    const { final, requests, ids } = await twoDirectivesAroundCut([
      { text: 'Interrupt: cite sources.', delivery: 'interrupt', commandId: 'cmd_interrupt' },
      { text: 'Joined: keep the API.', delivery: 'next_request', commandId: 'cmd_join' },
    ]);
    expect(final.status).toBe('succeeded');
    const joined = ids['Joined: keep the API.'] ?? '';
    const cutIn = ids['Interrupt: cite sources.'] ?? '';
    const last = requests.at(-1) ?? [];
    expect(directivesOf(last)).toEqual({ directives: [cutIn, joined], states: 1 });
    for (const messages of requests) expect(directivesOf(messages).states).toBe(1);
    for (const id of [joined, cutIn]) {
      expect(final.directives[id]?.status).toBe('delivered');
      expect(
        Object.values(final.modelCalls).filter((call) => call.directiveIds.includes(id)),
      ).toHaveLength(1);
    }
  });

  it('a directive that arrived while the cut request waited for its permit goes ahead of the interrupt', async () => {
    const waiting = new Gate(),
      grant = new Gate(),
      entered = new Gate(),
      release = new Gate();
    const requests: unknown[][] = [];
    let prepares = 0;
    const { adapter, host } = coreWorker(
      [
        async () => {
          entered.open();
          await release.wait();
          return fauxAssistantMessage('A long answer.');
        },
        (context) => {
          requests.push(JSON.parse(JSON.stringify(context.messages)));
          return fauxAssistantMessage('Done.');
        },
      ],
      {
        // A host that grants the permit without asking for a new preparation.
        prepareModelRequest: async () => {
          prepares++;
          if (prepares === 1) {
            waiting.open();
            await grant.wait();
          }
          return {
            modelCallId: `call_${prepares}`,
            contextSnapshotId: `ctx_${prepares}`,
            profile: 'model-a',
            maxOutputTokens: 256,
            directives: [],
          };
        },
      },
    );
    const handle = await adapter.start(startInput(), host);
    await waiting.wait();
    handle.pushDirective?.({
      directiveId: 'dir_wait',
      text: 'Keep the API.',
      origin: 'user' as const,
    });
    await tick();
    grant.open();
    await entered.wait();
    handle.interrupt?.({ directiveId: 'dir_cut', text: TEXT, origin: 'user' as const });
    await tick();
    release.open();
    expect((await handle.waitForSettlement()).outcome).toBe('succeeded');
    expect(requests).toHaveLength(1);
    expect(directivesOf(requests[0] ?? []).directives).toEqual(['dir_wait', 'dir_cut']);
  });

  it('an interrupt while a retry waits for its permit is not cut; the reprepared retry carries it', async () => {
    const retrying = new Gate(),
      permit = new Gate();
    const contexts: string[] = [];
    let prepares = 0;
    const answer = (context: { messages: unknown[] }) => {
      contexts.push(JSON.stringify(context.messages));
      return fauxAssistantMessage('Done.');
    };
    const { adapter, host, observed } = coreWorker(
      [
        fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'fetch failed' }),
        answer,
        answer,
      ],
      {
        prepareModelRequest: async () => {
          prepares++;
          if (prepares === 2) {
            retrying.open();
            await permit.wait();
            // As the Coordinator does: the protected context now lists the new directive.
            throw new Error('CONTEXT_STALE');
          }
          return {
            modelCallId: `call_${prepares}`,
            contextSnapshotId: `ctx_${prepares}`,
            profile: 'model-a',
            maxOutputTokens: 256,
            directives: [],
          };
        },
      },
    );
    const handle = await adapter.start(startInput(), host);
    await retrying.wait();
    handle.interrupt?.({ directiveId: 'dir_retry', text: TEXT, origin: 'user' as const });
    await tick();
    permit.open();
    expect((await handle.waitForSettlement()).outcome).toBe('succeeded');
    expect(prepares).toBe(3);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.split(`${DIRECTIVE_PREFIX}dir_retry)`)).toHaveLength(2);
    expect(observed.map((o) => o.interrupted).filter(Boolean)).toEqual([]);
  });

  const retryUnderCoordinator = async (wait: number) => {
    const seen: boolean[] = [];
    let send: (() => void) | undefined;
    let holdOnce = false;
    const { transport, clock } = liveRuntime(
      [
        fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'fetch failed' }),
        ...writeThenSubmit(seen),
      ],
      {
        onWorkerFrame: (frame) => {
          const f = frame as { type?: string; retryIndex?: number };
          if (f.type !== 'prepare_request' || f.retryIndex !== 1) return;
          if (!wait) send?.();
          else {
            holdOnce = true;
            // Once the Coordinator holds the retry for the provider wait, interrupt, then let it pass.
            setTimeout(() => {
              send?.();
              setTimeout(() => clock.advance(wait), 20);
            }, 20);
          }
        },
        retryAfterMs: () => {
          if (!holdOnce) return 0;
          holdOnce = false;
          return wait;
        },
      },
    );
    const { runId, events, interrupt } = await liveRun(transport);
    send = () => void interrupt();
    const final = await waitForProjection(transport, runId, settled);
    const directiveId = final.directiveOrder[0] ?? '';
    return { final, events, seen, directiveId };
  };

  it('an interrupt sent as the retry asks the Coordinator for its permit rides that retry', async () => {
    const { final, events, seen, directiveId } = await retryUnderCoordinator(0);
    expect(final.status).toBe('succeeded');
    expect(seen).toEqual([true]);
    expect(final.directives[directiveId]?.status).toBe('delivered');
    expect(
      Object.values(final.modelCalls).filter((call) => call.directiveIds.includes(directiveId)),
    ).toHaveLength(1);
    expect(events.filter((e) => e.type === 'model.finished' && e.payload.interrupted)).toEqual([]);
  });

  it('an interrupt while the Coordinator holds the retry for a provider wait rides that retry', async () => {
    const { final, events, seen, directiveId } = await retryUnderCoordinator(150);
    expect(final.status).toBe('succeeded');
    expect(seen).toEqual([true]);
    expect(final.directives[directiveId]?.status).toBe('delivered');
    expect(
      Object.values(final.modelCalls).filter((call) => call.directiveIds.includes(directiveId)),
    ).toHaveLength(1);
    expect(events.filter((e) => e.type === 'model.finished' && e.payload.interrupted)).toEqual([]);
  });

  it('an interrupt while a transient retry is being prepared rides that retry, uncut', async () => {
    const contexts: string[] = [];
    let protectedReads = 0;
    let handle: Awaited<ReturnType<PiAgentAdapter['start']>> | undefined;
    const { adapter, host, observed } = coreWorker(
      [
        fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'fetch failed' }),
        (context) => {
          contexts.push(JSON.stringify(context.messages));
          return fauxAssistantMessage('Done.');
        },
      ],
      {
        // The retry's preparation starts with its own protected-context read.
        protectedContext: () => {
          if (++protectedReads === 2)
            handle?.interrupt?.({ directiveId: 'dir_prep', text: TEXT, origin: 'user' as const });
          return undefined as never;
        },
      },
    );
    handle = await adapter.start(startInput(), host);
    expect((await handle.waitForSettlement()).outcome).toBe('succeeded');
    expect(protectedReads).toBe(2);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.split(`${DIRECTIVE_PREFIX}dir_prep)`)).toHaveLength(2);
    expect(observed.map((o) => o.interrupted).filter(Boolean)).toEqual([]);
  });

  it('an interrupt during the summary of an overflow recovery rides the recovered request, uncut', async () => {
    const summarizing = new Gate(),
      summarize = new Gate();
    const seen: boolean[] = [];
    const { transport } = liveRuntime([
      {
        ...fauxAssistantMessage(''),
        stopReason: 'error',
        errorMessage: JSON.stringify({
          code: 'CONTEXT_OVERFLOW',
          status: 400,
          retryAfterMs: null,
          requestId: null,
        }),
      },
      async () => {
        summarizing.open();
        await summarize.wait();
        return fauxAssistantMessage('Keep the marker requirement and submit the final artifact.');
      },
      ...writeThenSubmit(seen),
    ]);
    const { runId, events, interrupt } = await liveRun(
      transport,
      `${'Reference context. '.repeat(1000)} Save overflow recovered.`,
    );
    await summarizing.wait();
    await interrupt();
    await tick();
    summarize.open();
    const final = await waitForProjection(transport, runId, settled);
    expect(final.status).toBe('succeeded');
    expect(seen).toEqual([true]);
    const directiveId = final.directiveOrder[0] ?? '';
    expect(final.directives[directiveId]?.status).toBe('delivered');
    expect(
      Object.values(final.modelCalls).filter((call) => call.directiveIds.includes(directiveId)),
    ).toHaveLength(1);
    expect(events.filter((e) => e.type === 'model.finished' && e.payload.interrupted)).toEqual([]);
  });

  it('a provider that finishes despite the cut leaves no interrupt mark', async () => {
    const entered = new Gate(),
      release = new Gate();
    const contexts: string[] = [];
    const faux = createFauxCore({});
    faux.setResponses([
      async () => {
        entered.open();
        await release.wait();
        return fauxAssistantMessage([fauxToolCall('write_artifact', { text: 'Draft.' })], {
          stopReason: 'toolUse',
        });
      },
      (context) => {
        contexts.push(JSON.stringify(context.messages));
        return fauxAssistantMessage('Done.');
      },
    ]);
    const observed: AgentObservation[] = [];
    const { host } = recordingHost({ observe: async (o) => void observed.push(o) });
    const adapter = new PiAgentAdapter({
      spawn: () => {
        const pair = memoryChannelPair();
        runWorker(pair.worker, {
          // The provider never sees the abort and answers in full.
          streamFn: (model, context, options) =>
            faux.streamSimple(model, context, { ...options, signal: undefined }),
          resolveModel: () => faux.getModel(),
        });
        return pair.host;
      },
      credentials: async () => ACCESS_TOKEN,
    });
    const handle = await adapter.start(startInput(), host);
    await entered.wait();
    handle.interrupt?.({ directiveId: 'dir_late', text: TEXT, origin: 'user' as const });
    await tick();
    release.open();
    expect((await handle.waitForSettlement()).outcome).toBe('succeeded');
    expect(observed.map((o) => o.interrupted).filter(Boolean)).toEqual([]);
    expect(contexts[0]?.split(`${DIRECTIVE_PREFIX}dir_late)`)).toHaveLength(2);
  });
});
