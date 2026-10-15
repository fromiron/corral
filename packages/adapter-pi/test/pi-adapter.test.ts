import type { AgentStartInput, RunEvent, StreamFrame } from '@corral/contracts';
import { type RunProjection, waitForProjection } from '@corral/core';
import { Gate, linearCorral } from '@corral/testkit';
import { fauxAssistantMessage, fauxToolCall, getCurrentTools } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import { PiAgentAdapter } from '../src/adapter.ts';
import { memoryChannelPair } from '../src/channel.ts';
import { PROTOCOL_VERSION } from '../src/protocol.ts';
import { ACCESS_TOKEN, liveRuntime, recordingHost } from './harness.ts';

const settled = (p: RunProjection) => ['succeeded', 'failed', 'cancelled'].includes(p.status);

/** Reads the artifact version id Corral returned for the last write_artifact call. */
function lastArtifactVersion(context: { messages: unknown[] }): string {
  const text = JSON.stringify(context.messages);
  const match = [...text.matchAll(/artv_\d{4}/g)].at(-1);
  if (!match) throw new Error('no artifact version in the transcript');
  return match[0];
}

const writeThenSubmit = (text: string) => [
  fauxAssistantMessage([fauxToolCall('write_artifact', { text })], { stopReason: 'toolUse' }),
  (context: { messages: unknown[] }) =>
    fauxAssistantMessage(
      [fauxToolCall('submit_result', { artifactVersionIds: [lastArtifactVersion(context)] })],
      { stopReason: 'toolUse' },
    ),
  fauxAssistantMessage('Submitted.'),
];

async function liveRun(
  transport: ReturnType<typeof liveRuntime>['transport'],
  roles?: (d: ReturnType<typeof linearCorral>) => void,
) {
  const definition = linearCorral(['writer']);
  roles?.(definition);
  const { runId, receipt } = await transport.startRun({
    schemaVersion: '0.1',
    commandId: 'cmd_live',
    definition,
    mode: 'live',
  });
  if (!runId) throw new Error(JSON.stringify(receipt.error));
  const events: RunEvent[] = [];
  const frames: StreamFrame[] = [];
  transport.subscribe(runId, 0, { onEvent: (e) => events.push(e), onFrame: (f) => frames.push(f) });
  return { runId, events, frames };
}

describe('Pi adapter under the Coordinator (C-017–C-019)', () => {
  it('runs a live step: the model writes and submits through Corral tools', async () => {
    const { transport, credentialCalls } = liveRuntime(writeThenSubmit('Final answer.'));
    const { runId, events } = await liveRun(transport);
    const final = await waitForProjection(transport, runId, settled);
    expect(final.status).toBe('succeeded');
    const output = final.output?.artifactVersionIds[0] ?? '';
    expect(await transport.getArtifactText(runId, output)).toBe('Final answer.');
    // One credential lookup per model request, and the token is in no event.
    expect(credentialCalls).toEqual(['openai/faux-1', 'openai/faux-1', 'openai/faux-1']);
    await Promise.resolve();
    expect(JSON.stringify(events)).not.toContain(ACCESS_TOKEN);
  });

  it('[TC-RNS-001-H] [TC-RACE-01] a steer sent during request 1 reaches request 2 only', async () => {
    const gate = new Gate();
    const seen: boolean[] = [];
    const sawDirective = (context: { messages: unknown[] }) =>
      JSON.stringify(context.messages).includes('Use primary sources only.');
    const { transport } = liveRuntime([
      async (context) => {
        seen.push(sawDirective(context));
        await gate.wait();
        return fauxAssistantMessage([fauxToolCall('write_artifact', { text: 'Draft.' })], {
          stopReason: 'toolUse',
        });
      },
      (context) => {
        seen.push(sawDirective(context));
        return fauxAssistantMessage(
          [fauxToolCall('submit_result', { artifactVersionIds: [lastArtifactVersion(context)] })],
          { stopReason: 'toolUse' },
        );
      },
      fauxAssistantMessage('Done.'),
    ]);
    const { runId } = await liveRun(transport);
    const inFlight = await waitForProjection(
      transport,
      runId,
      (p) => Object.keys(p.modelCalls).length === 1,
    );
    const executionId = inFlight.executionOrder[0] ?? '';
    const receipt = await transport.sendCommand({
      schemaVersion: '0.1',
      commandId: 'cmd_steer',
      runId,
      type: 'steer',
      payload: {
        targetExecutionId: executionId,
        text: 'Use primary sources only.',
        delivery: 'next_request',
      },
    });
    expect(receipt.status).toBe('queued');
    gate.open();
    const final = await waitForProjection(transport, runId, settled);

    expect(seen).toEqual([false, true]);
    const [call1, call2] = final.executions[executionId]?.modelCallIds ?? [];
    const directiveId = final.directiveOrder[0] ?? '';
    expect(final.modelCalls[call1 ?? '']?.directiveIds).toEqual([]);
    expect(final.modelCalls[call2 ?? '']?.directiveIds).toEqual([directiveId]);
    expect(final.directives[directiveId]?.status).toBe('delivered');
  });

  it('[TC-SEC-001-N] a call the host refuses is blocked and never starts, though Pi saw it', async () => {
    const { transport } = liveRuntime([
      // An offered tool, but naming a version this execution never wrote.
      fauxAssistantMessage([fauxToolCall('submit_result', { artifactVersionIds: ['artv_9999'] })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('I could not submit.'),
    ]);
    const { runId, events } = await liveRun(transport);
    const final = await waitForProjection(transport, runId, settled);
    await Promise.resolve();
    expect(final.status).toBe('failed');
    const types = events.map((e) => e.type);
    expect(types).toContain('tool.blocked');
    expect(types).not.toContain('tool.started');
    expect(types).not.toContain('task.submitted');
  });

  it('offers a role only the tools it may use', async () => {
    const offered: string[][] = [];
    const { transport } = liveRuntime([
      (context) => {
        offered.push(getCurrentTools(context.messages).map((t) => t.name));
        return fauxAssistantMessage('Nothing to do.');
      },
    ]);
    const { runId } = await liveRun(transport, (d) => {
      for (const role of d.roles) role.allowedWorkTools = [];
    });
    await waitForProjection(transport, runId, settled);
    expect(offered).toEqual([['submit_result']]);
  });

  it('[TC-SEC-001-H] the model sees only Corral tools: no shell or code tool exists', async () => {
    const offered: string[][] = [];
    const { transport } = liveRuntime([
      (context) => {
        offered.push(getCurrentTools(context.messages).map((t) => t.name));
        return fauxAssistantMessage('Nothing to do.');
      },
    ]);
    const { runId } = await liveRun(transport);
    await waitForProjection(transport, runId, settled);
    expect(offered).toEqual([['write_artifact', 'submit_result']]);
  });

  it('streams text to live subscribers and records normalized usage once per request', async () => {
    const { transport } = liveRuntime(
      [fauxAssistantMessage('A streamed answer with several words in it.')],
      { tokensPerSecond: 2000 },
    );
    const { runId, events, frames } = await liveRun(transport);
    await waitForProjection(transport, runId, settled);
    await Promise.resolve();
    expect(frames.map((f) => f.text).join('')).toBe('A streamed answer with several words in it.');
    expect(frames.map((f) => f.chunkIndex)).toEqual(frames.map((_, i) => i));
    const finished = events.filter((e) => e.type === 'model.finished');
    expect(finished).toHaveLength(1);
    const usage = finished[0]?.type === 'model.finished' ? finished[0].payload : null;
    expect(usage?.certainty).toBe('reported');
    expect(usage?.normalizedUsage.outputTokens).toBeGreaterThan(0);
    // Cached and reasoning counts the provider reported (0 here) are kept, not dropped to null.
    expect(usage?.normalizedUsage.cachedInputTokens).toBe(0);
  });
});

function startInput(): AgentStartInput {
  const definition = linearCorral(['writer']);
  const role = definition.roles[0];
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
    inputs: [{ name: 'brief', kind: 'run_input', artifactVersionId: null, text: 'Brief.' }],
  };
}

/** An adapter whose worker end is driven by the test. */
function scriptedWorker(graceMs = 50) {
  const pair = memoryChannelPair();
  const received: { type: string }[] = [];
  pair.worker.onFrame((frame) => received.push(frame as { type: string }));
  const adapter = new PiAgentAdapter({
    spawn: () => pair.host,
    credentials: async () => ACCESS_TOKEN,
    cancelGraceMs: graceMs,
  });
  return { adapter, worker: pair.worker, received };
}

const tick = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe('worker lifecycle and protocol checks (C-017)', () => {
  it('starts the worker only after it says it is ready, bound to one execution', async () => {
    const { adapter, worker, received } = scriptedWorker();
    await adapter.start(startInput(), recordingHost().host);
    await tick();
    expect(received).toEqual([]);
    worker.send({ type: 'ready', protocolVersion: PROTOCOL_VERSION });
    await tick();
    expect(received.map((f) => f.type)).toEqual(['start']);
    expect(JSON.stringify(received)).not.toContain(ACCESS_TOKEN);
  });

  it('fails the execution when the worker speaks for another execution', async () => {
    const { adapter, worker } = scriptedWorker();
    const handle = await adapter.start(startInput(), recordingHost().host);
    worker.send({ type: 'ready', protocolVersion: PROTOCOL_VERSION });
    worker.send({
      type: 'prepare_request',
      protocolVersion: PROTOCOL_VERSION,
      executionId: 'exec_other',
      requestId: 'req_1',
    });
    expect(await handle.waitForSettlement()).toEqual({
      outcome: 'failed',
      error: 'the model worker sent an invalid message',
    });
  });

  it('fails the execution on a malformed frame, without echoing it', async () => {
    const { adapter, worker } = scriptedWorker();
    const handle = await adapter.start(startInput(), recordingHost().host);
    worker.send({ type: 'ready', protocolVersion: PROTOCOL_VERSION });
    worker.send({ type: 'observe', secret: 'leaked-value' });
    const settlement = await handle.waitForSettlement();
    expect(settlement.outcome).toBe('failed');
    expect(JSON.stringify(settlement)).not.toContain('leaked-value');
  });

  it('fails, never completes, when the worker exits before settling', async () => {
    const { adapter, worker } = scriptedWorker();
    const handle = await adapter.start(startInput(), recordingHost().host);
    worker.send({ type: 'ready', protocolVersion: PROTOCOL_VERSION });
    await tick();
    worker.kill();
    expect(await handle.waitForSettlement()).toEqual({
      outcome: 'failed',
      error: 'the model worker stopped unexpectedly (exit 0)',
    });
  });

  it('asks the worker to stop, and terminates it after the grace period', async () => {
    const { adapter, worker, received } = scriptedWorker(30);
    const handle = await adapter.start(startInput(), recordingHost().host);
    worker.send({ type: 'ready', protocolVersion: PROTOCOL_VERSION });
    await tick();
    await handle.cancel('user cancelled');
    expect(received.map((f) => f.type)).toContain('cancel');
    expect(await handle.waitForSettlement()).toEqual({
      outcome: 'cancelled',
      error: 'the model worker did not stop in time and was terminated',
    });
  });

  it('refuses to run simulated or unresolved models', async () => {
    const { adapter } = scriptedWorker();
    const input = { ...startInput(), mode: 'mock' as const };
    await expect(adapter.start(input, recordingHost().host)).rejects.toThrow(/live/);
  });
});
