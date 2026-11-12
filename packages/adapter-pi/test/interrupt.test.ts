import type { AgentObservation, AgentStartInput, RunEvent } from '@corral/contracts';
import { type RunProjection, waitForProjection } from '@corral/core';
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

async function liveRun(transport: ReturnType<typeof liveRuntime>['transport']) {
  const { runId, receipt } = await transport.startRun({
    schemaVersion: '0.1',
    commandId: 'cmd_live',
    definition: linearCorral(['writer']),
    mode: 'live',
  });
  if (!runId) throw new Error(JSON.stringify(receipt.error));
  const events: RunEvent[] = [];
  transport.subscribe(runId, 0, { onEvent: (e) => events.push(e), onFrame: () => {} });
  const interrupt = async () => {
    const p = await waitForProjection(transport, runId, (p) => p.executionOrder.length === 1);
    return transport.sendCommand({
      schemaVersion: '0.1',
      commandId: 'cmd_interrupt',
      runId,
      type: 'steer',
      payload: { targetExecutionId: p.executionOrder[0] ?? '', text: TEXT, delivery: 'interrupt' },
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
    handle.interrupt?.({ directiveId: 'dir_tool', text: TEXT });
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
    handle.interrupt?.({ directiveId: 'dir_between', text: TEXT });
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
    handle.interrupt?.({ directiveId: 'dir_cancel', text: TEXT });
    const cancelled = handle.cancel('stopped');
    await tick();
    release.open();
    await cancelled;
    expect((await handle.waitForSettlement()).outcome).toBe('cancelled');
    expect(later).toBe(0);
  });
});
