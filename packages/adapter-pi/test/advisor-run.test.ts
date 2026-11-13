import type { AdviceSeverity, CorralDefinition, RunEvent } from '@corral/contracts';
import { type RunProjection, waitForProjection } from '@corral/core';
import { Gate, linearCorral } from '@corral/testkit';
import {
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxToolCall,
  type TranscriptContext,
} from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import { ADVICE_DIRECTIVE_PREFIX } from '../src/worker-tools.ts';
import { liveRuntime } from './harness.ts';

// The Coordinator with the real core worker on both sides (docs/specs/features/advisor.md): an
// advisor watching a writer reviews its requests, and what it advises reaches the writer, or comes
// back to the advisor as the reason it was dropped. Scripted (faux) models only.

const settled = (p: RunProjection) => ['succeeded', 'failed', 'cancelled'].includes(p.status);
const said = (context: TranscriptContext) => JSON.stringify(context.messages);
const isAdvisor = (context: TranscriptContext) =>
  said(context).includes('You are an advisor in a Corral run');

function definition(): CorralDefinition {
  const corral = linearCorral(['writer']);
  corral.limits = { ...corral.limits, maxModelConcurrency: 4 };
  corral.roles.push({
    id: 'advisor_role',
    name: 'Fact checker',
    prompt: 'Flag claims without a source.',
    modelProfile: 'model-a',
    allowedWorkTools: [],
    allowedCollaborationTools: [],
    outputContract: 'notes',
  });
  corral.nodes.push({
    id: 'advisor',
    type: 'agent',
    label: 'advisor',
    roleId: 'advisor_role',
    invocation: 'observer',
    outputName: 'notes',
    review: { interval: 1, maxRequestsPerReview: 8 },
  } as CorralDefinition['nodes'][number]);
  corral.capabilityLinks.push({
    id: 'watch_writer',
    kind: 'advise',
    sourceNodeId: 'advisor',
    targetNodeId: 'writer',
  });
  return corral;
}

function lastArtifactVersion(context: TranscriptContext): string {
  for (const message of [...context.messages].reverse()) {
    const result = message as { role?: string; toolName?: string; content?: unknown };
    if (result.role !== 'toolResult' || result.toolName !== 'write_artifact') continue;
    const text = JSON.stringify(result.content);
    const id = /artifactVersionId\\":\\"([^\\]+)\\"/.exec(text)?.[1];
    if (id) return id;
  }
  throw new Error('no write_artifact result in the transcript');
}

/**
 * Faux replies by who asks: the advisor's from `advisor` in order (then quiet), the writer's from
 * `writer` in order. One shared faux queue serves both workers.
 */
function scripted(advisor: FauxResponseStep[], writer: FauxResponseStep[]) {
  const step = (list: FauxResponseStep[], fallback: string): FauxResponseStep =>
    list.shift() ?? fauxAssistantMessage(fallback);
  const dispatch: FauxResponseStep = (context, options, state, model) => {
    const next = isAdvisor(context) ? step(advisor, 'Nothing to add.') : step(writer, 'Done.');
    return typeof next === 'function' ? next(context, options, state, model) : next;
  };
  return Array.from({ length: 40 }, () => dispatch);
}

const advising = (severity: AdviceSeverity, note: string) =>
  fauxAssistantMessage([fauxToolCall('advise', { severity, note })], { stopReason: 'toolUse' });
const writing = (text: string) =>
  fauxAssistantMessage([fauxToolCall('write_artifact', { text })], { stopReason: 'toolUse' });
const submitting = (context: TranscriptContext) =>
  fauxAssistantMessage(
    [fauxToolCall('submit_result', { artifactVersionIds: [lastArtifactVersion(context)] })],
    { stopReason: 'toolUse' },
  );

async function run(transport: ReturnType<typeof liveRuntime>['transport']) {
  const { runId, receipt } = await transport.startRun({
    schemaVersion: '0.1',
    commandId: 'cmd_advised',
    definition: definition(),
    mode: 'live',
  });
  if (!runId) throw new Error(JSON.stringify(receipt.error));
  const events: RunEvent[] = [];
  transport.subscribe(runId, 0, { onEvent: (e) => events.push(e), onFrame: () => {} });
  return { runId, events };
}

const executionOf = (p: RunProjection, nodeId: string) =>
  Object.values(p.executions).find((e) => e.nodeId === nodeId);

describe('an advisor on the real worker, under the Coordinator', () => {
  it('a concern rides the writer’s next request under the advisor’s heading', async () => {
    const advised = new Gate();
    let carried = '';
    const { transport } = liveRuntime(
      scripted(
        [
          advising('concern', 'The cheese claim has no source.'),
          () => {
            advised.open();
            return fauxAssistantMessage('That is all.');
          },
        ],
        [
          writing('Draft: the moon is made of cheese.'),
          async () => {
            await advised.wait();
            return writing('Draft, second pass.');
          },
          (context) => {
            carried = said(context);
            return submitting(context);
          },
        ],
      ),
    );
    const { runId, events } = await run(transport);
    const final = await waitForProjection(transport, runId, settled);
    expect(final.status).toBe('succeeded');
    expect(executionOf(final, 'advisor')?.status).toBe('succeeded');
    expect(carried).toContain(`${ADVICE_DIRECTIVE_PREFIX}concern from Fact checker`);
    expect(carried).toContain('> The cheese claim has no source.');
    const admitted = events.find((e) => e.type === 'advice.admitted');
    expect(admitted?.payload).toMatchObject({ severity: 'concern', delivery: 'next_request' });
    // The advisor submitted nothing; the run's output is the writer's.
    expect(
      Object.values(final.artifacts).filter(
        (a) => a.authorExecutionId === executionOf(final, 'advisor')?.executionId,
      ),
    ).toEqual([]);
  });

  it('a blocker cuts the writer’s streaming response and leads its next request', async () => {
    const advised = new Gate();
    const streaming = new Gate();
    let carried = '';
    const { transport } = liveRuntime(
      scripted(
        [
          async () => {
            await streaming.wait();
            return advising('blocker', 'Stop: the brief asks for primary sources only.');
          },
          () => {
            advised.open();
            return fauxAssistantMessage('That is all.');
          },
        ],
        [
          writing('Draft: a blog says so.'),
          async (_context, options) => {
            streaming.open();
            await new Promise<void>((resolve) => {
              if (options?.signal?.aborted) resolve();
              options?.signal?.addEventListener('abort', () => resolve(), { once: true });
            });
            return fauxAssistantMessage('A long answer built on the blog.');
          },
          (context) => {
            carried = said(context);
            return writing('Draft from primary sources.');
          },
          submitting,
        ],
      ),
    );
    const { runId, events } = await run(transport);
    const final = await waitForProjection(transport, runId, settled);
    expect(final.status).toBe('succeeded');
    const admitted = events.find((e) => e.type === 'advice.admitted');
    expect(admitted?.payload).toMatchObject({ severity: 'blocker', delivery: 'interrupt' });
    const writer = executionOf(final, 'writer')?.executionId;
    const cut = events.filter(
      (e) =>
        e.type === 'model.finished' &&
        final.modelCalls[e.payload.modelCallId]?.executionId === writer &&
        e.payload.interrupted,
    );
    expect(cut).toHaveLength(1);
    expect(carried).toContain(`${ADVICE_DIRECTIVE_PREFIX}blocker from Fact checker`);
  });

  it('“no problem, carry on” is dropped as noise, and the advisor is told why', async () => {
    const reviewed = new Gate();
    let toldAdvisor = '';
    const { transport } = liveRuntime(
      scripted(
        [
          advising('nit', 'No problem, continue.'),
          (context) => {
            toldAdvisor = said(context);
            reviewed.open();
            return fauxAssistantMessage('That is all.');
          },
        ],
        [
          writing('Draft.'),
          async (context) => {
            await reviewed.wait();
            return submitting(context);
          },
        ],
      ),
    );
    const { runId, events } = await run(transport);
    const final = await waitForProjection(transport, runId, settled);
    expect(final.status).toBe('succeeded');
    expect(events.filter((e) => e.type === 'advice.admitted')).toEqual([]);
    const suppressed = events.find((e) => e.type === 'advice.suppressed');
    expect(suppressed?.payload).toMatchObject({ reason: 'noise' });
    expect(toldAdvisor).toContain('Not delivered (noise)');
    expect(final.directiveOrder).toEqual([]);
  });
});

describe('pausing a run while its advisor reviews', () => {
  it('the advisor’s next request waits for resume, then the review goes on', async () => {
    const entered = new Gate();
    const release = new Gate();
    const { transport } = liveRuntime(
      scripted(
        [
          async () => {
            entered.open();
            await release.wait();
            return advising('concern', 'The cheese claim has no source.');
          },
          fauxAssistantMessage('That is all.'),
        ],
        [writing('Draft: the moon is made of cheese.'), submitting],
      ),
    );
    const { runId } = await run(transport);
    await entered.wait();
    const control = async (type: 'pause' | 'resume') => {
      const p = await transport.getSnapshot(runId);
      return transport.sendCommand({
        schemaVersion: '0.1',
        commandId: `cmd_${type}`,
        runId,
        type,
        expectedControlRevision: p.projection.controlRevision,
        payload: { scope: 'run' },
      });
    };
    await control('pause');
    release.open();
    const paused = await waitForProjection(transport, runId, (p) => p.status === 'paused');
    const advisorCalls = (p: RunProjection) => executionOf(p, 'advisor')?.modelCallIds.length ?? 0;
    expect(advisorCalls(paused)).toBe(1);
    await control('resume');
    const final = await waitForProjection(transport, runId, settled);
    expect(final.status).toBe('succeeded');
    expect(advisorCalls(final)).toBeGreaterThan(1);
    expect(executionOf(final, 'advisor')?.status).toBe('succeeded');
  });
});
