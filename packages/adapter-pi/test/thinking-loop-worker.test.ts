import type { CorralDefinition } from '@corral/contracts';
import { type RunProjection, waitForProjection } from '@corral/core';
import { linearCorral } from '@corral/testkit';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream, fauxAssistantMessage } from '@earendil-works/pi-ai';
import { expect, it } from 'vitest';
import { liveRuntime } from './harness.ts';

// docs/specs/llm-runtime.md: a real worker cuts a request whose reasoning loops, through the
// signal of that attempt, and asks again with a new permit.

const terminal = (p: RunProjection) => ['succeeded', 'failed', 'cancelled'].includes(p.status);
const LOOP = 'I will open the config file again and check the value once more. ';

function definition(): CorralDefinition {
  const corral = linearCorral(['assistant']);
  corral.roles = corral.roles.map((role) => ({
    ...role,
    answer: 'final_reply' as const,
    outputContract: 'text' as const,
    allowedWorkTools: [],
    allowedCollaborationTools: [],
  }));
  return corral;
}

/** Reasoning that repeats one sentence until its request's signal aborts. */
const looping: StreamFn = (_model, _context, options) => {
  const stream = createAssistantMessageEventStream();
  const base = fauxAssistantMessage('');
  let thought = '';
  stream.push({ type: 'start', partial: { ...base, content: [] } });
  const tick = () => {
    if (options?.signal?.aborted) {
      const message = {
        ...base,
        content: [{ type: 'thinking' as const, thinking: thought }],
        stopReason: 'aborted' as const,
        errorMessage: 'Request was aborted',
      };
      stream.push({ type: 'error', reason: 'aborted', error: message });
      stream.end(message);
      return;
    }
    thought += LOOP;
    stream.push({
      type: 'thinking_delta',
      contentIndex: 0,
      delta: LOOP,
      partial: { ...base, content: [{ type: 'thinking', thinking: thought }] },
    });
    setTimeout(tick, 0);
  };
  setTimeout(tick, 0);
  return stream;
};

it('a looping first request is cut by its own signal and the second request answers', async () => {
  const signals: (AbortSignal | undefined)[] = [];
  const { transport, credentialCalls } = liveRuntime([fauxAssistantMessage('Answer.')], {
    wrapStream: (inner) => (model, context, options) => {
      signals.push(options?.signal);
      return signals.length === 1
        ? looping(model, context, options)
        : inner(model, context, options);
    },
  });
  const { runId, receipt } = await transport.startRun({
    schemaVersion: '0.1',
    commandId: 'thinking_loop_start',
    definition: definition(),
    mode: 'live',
  });
  if (!runId) throw new Error(JSON.stringify(receipt.error));
  const final = await waitForProjection(transport, runId, terminal);
  expect(final.status).toBe('succeeded');
  expect(signals).toHaveLength(2);
  expect(signals[0]?.aborted).toBe(true);
  expect(signals[1]?.aborted).toBe(false);
  expect(credentialCalls).toHaveLength(2);
  const [versionId] = final.output?.artifactVersionIds ?? [];
  expect(await transport.getArtifactText(runId, versionId ?? '')).toBe('Answer.');
});
