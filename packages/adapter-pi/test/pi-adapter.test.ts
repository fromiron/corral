import type { AgentStartInput, RunEvent, StreamFrame } from '@corral/contracts';
import { type RunProjection, waitForProjection } from '@corral/core';
import { collaborationCorral, Gate, linearCorral } from '@corral/testkit';
import { fauxAssistantMessage, fauxToolCall, getCurrentTools } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import { PiAgentAdapter } from '../src/adapter.ts';
import { type Channel, memoryChannelPair } from '../src/channel.ts';
import { LEGACY_PROTOCOL_VERSION as PROTOCOL_VERSION, StartFrame } from '../src/protocol.ts';
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
  it('[TC-STATUS-001-H] runs a live step: the model writes and submits through Corral tools', async () => {
    const { transport, credentialCalls } = liveRuntime(writeThenSubmit('Final answer.'));
    const { runId, events } = await liveRun(transport, (d) => {
      d.limits = { ...d.limits, maxModelCalls: 2 };
    });
    const final = await waitForProjection(transport, runId, settled);
    expect(final.status).toBe('succeeded');
    expect(Object.values(final.executions).map((e) => e.status)).toEqual(['succeeded']);
    const output = final.output?.artifactVersionIds[0] ?? '';
    expect(await transport.getArtifactText(runId, output)).toBe('Final answer.');
    // One credential lookup per model request, and the token is in no event.
    expect(credentialCalls).toEqual(['openai/faux-1', 'openai/faux-1']);
    await Promise.resolve();
    expect(JSON.stringify(events)).not.toContain(ACCESS_TOKEN);
    expect(events.find((event) => event.type === 'model.request_recorded')?.payload).toMatchObject({
      runtime: 'pi-core',
      contextEstimate: { tokens: expect.any(Number), method: 'pi-1.3.0-messages' },
      sections: expect.arrayContaining([
        expect.objectContaining({ name: 'corral_safety', source: 'corral', version: 1 }),
      ]),
    });
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

  it('keeps shell unavailable without a trusted harness while supporting the selected hashline syntax', async () => {
    const offered: string[][] = [];
    const { transport } = liveRuntime([
      (context) => {
        offered.push(getCurrentTools(context.messages).map((tool) => tool.name));
        return fauxAssistantMessage('No command launched.');
      },
    ]);
    const { runId } = await liveRun(transport, (definition) => {
      definition.roles[0]!.allowedWorkTools = ['read_file', 'write_file', 'run_command'];
      definition.roles[0]!.editingMode = 'hashline';
    });
    await waitForProjection(transport, runId, settled);
    expect(offered[0]).toContain('read_hashline');
    expect(offered[0]).toContain('edit_hashline');
    expect(offered[0]).not.toContain('run_command');
    expect(offered[0]).not.toContain('edit');
  });

  it('[TC-SEC-003-H] exposes registered document and search tools only when allowed', async () => {
    const offered: string[][] = [];
    const { transport } = liveRuntime([
      (context) => {
        offered.push(getCurrentTools(context.messages).map((tool) => tool.name));
        return fauxAssistantMessage('No external request needed.');
      },
    ]);
    const { runId } = await liveRun(transport, (definition) => {
      for (const role of definition.roles) role.allowedWorkTools = ['search', 'read_document'];
    });
    await waitForProjection(transport, runId, settled);
    expect(offered).toEqual([['search', 'read_document', 'submit_result']]);
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
    depth: 0,
    round: null,
    criteriaVersionId: 'crit_0001',
    assignment: { kind: 'scheduled' },
    capabilities: { delegateTo: [], askTo: [] },
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
  it('[TC-MEET-001-H] forwards only host meeting provenance into the worker start frame', async () => {
    const { adapter, worker, received } = scriptedWorker();
    const input = startInput();
    input.meeting = {
      sessionId: 'session_chat',
      roundId: 'message_1',
      participantId: 'participant_1',
    };
    const handle = await adapter.start(input, recordingHost().host);
    worker.send({ type: 'ready', protocolVersion: PROTOCOL_VERSION });
    await tick();
    const frame = StartFrame.parse(received.find((message) => message.type === 'start'));
    expect(frame.meeting).toEqual(input.meeting);
    worker.kill();
    await handle.waitForSettlement();
  });

  it('[TC-ABS-004-N] file previews require read permission and app/browser tools require a trusted harness', async () => {
    for (const readable of [false, true]) {
      const { adapter, worker, received } = scriptedWorker();
      const input = startInput();
      input.role.allowedWorkTools = ['preview_file', 'preview_app', 'preview_action'];
      if (readable) input.role.allowedWorkTools.push('read_file');
      const handle = await adapter.start(input, recordingHost().host);
      worker.send({ type: 'ready', protocolVersion: PROTOCOL_VERSION });
      await tick();
      const frame = StartFrame.parse(received.find((message) => message.type === 'start'));
      expect(frame.tools.includes('preview_file')).toBe(readable);
      expect(frame.tools).not.toContain('preview_app');
      expect(frame.tools).not.toContain('preview_action');
      worker.kill();
      await handle.waitForSettlement();
    }
  });

  it('[TC-ABS-010-H] offers image generation only with role permission and a configured profile', async () => {
    for (const enabled of [false, true]) {
      const { adapter, worker, received } = scriptedWorker();
      const input = startInput();
      input.role.allowedWorkTools = ['generate_image'];
      if (enabled) input.role.imageProfile = 'illustration';
      const handle = await adapter.start(input, recordingHost().host);
      worker.send({ type: 'ready', protocolVersion: PROTOCOL_VERSION });
      await tick();
      const frame = StartFrame.parse(received.find((message) => message.type === 'start'));
      expect(frame.tools.includes('generate_image')).toBe(enabled);
      expect(frame.role.imageProfile).toBe(enabled ? 'illustration' : undefined);
      worker.kill();
      await handle.waitForSettlement();
    }
  });

  it('[TC-SEC-002-N] never persists a provider error containing request text or credentials', async () => {
    const { adapter, worker } = scriptedWorker();
    const handle = await adapter.start(startInput(), recordingHost().host);
    worker.send({ type: 'ready', protocolVersion: PROTOCOL_VERSION });
    await tick();
    worker.send({
      type: 'settled',
      protocolVersion: PROTOCOL_VERSION,
      executionId: 'exec_1',
      outcome: 'failed',
      error: 'credential=opaque-provider-secret body=private-user-text /home/private/input.md',
    });
    await tick();
    worker.kill();
    const result = await handle.waitForSettlement();
    expect(result.outcome).toBe('failed');
    expect(JSON.stringify(result)).not.toMatch(/opaque-provider-secret|private-user-text|\/home\//);
  });

  it('[TC-RNS-004-N] a settled frame does not confirm worker termination before exit', async () => {
    let receive!: (frame: unknown) => void;
    let exit!: (code: number | null) => void;
    const channel: Channel = {
      send: () => {},
      onFrame: (listener) => {
        receive = listener;
      },
      onExit: (listener) => {
        exit = listener;
      },
      kill: () => {},
    };
    const adapter = new PiAgentAdapter({ spawn: () => channel, credentials: async () => null });
    const handle = await adapter.start(startInput(), recordingHost().host);
    receive({ type: 'ready', protocolVersion: PROTOCOL_VERSION });
    await tick();
    receive({
      type: 'settled',
      protocolVersion: PROTOCOL_VERSION,
      executionId: 'exec_1',
      outcome: 'cancelled',
    });
    let complete = false;
    void handle.waitForSettlement().then(() => {
      complete = true;
    });
    await tick();
    expect(complete).toBe(false);
    exit(0);
    await expect(handle.waitForSettlement()).resolves.toMatchObject({ outcome: 'cancelled' });
  });

  it('[TC-RNS-002-H] observes dispatch separately from preparing a request', async () => {
    const { adapter, worker } = scriptedWorker();
    const dispatched: string[] = [];
    const { host, calls } = recordingHost({
      modelRequestDispatched: async (id) => void dispatched.push(id),
    });
    await adapter.start(startInput(), host);
    worker.send({ type: 'ready', protocolVersion: PROTOCOL_VERSION });
    worker.send({
      type: 'prepare_request',
      protocolVersion: PROTOCOL_VERSION,
      executionId: 'exec_1',
      requestId: 'req_1',
    });
    await tick();
    expect(calls).toEqual(['prepare']);
    expect(dispatched).toEqual([]);
    worker.send({
      type: 'request_dispatched',
      protocolVersion: PROTOCOL_VERSION,
      executionId: 'exec_1',
      modelCallId: 'call_1',
    });
    await tick();
    expect(dispatched).toEqual(['call_1']);
  });

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
      terminationMode: 'forced',
    });
  });

  it('refuses to run simulated or unresolved models', async () => {
    const { adapter } = scriptedWorker();
    const input = { ...startInput(), mode: 'mock' as const };
    await expect(adapter.start(input, recordingHost().host)).rejects.toThrow(/live/);
  });
});

describe('collaboration tools through Pi (C-025)', () => {
  /** One faux model playing every role, choosing its next move from the transcript. */
  const team = (context: { messages: unknown[] }) => {
    const messages = context.messages as {
      role: string;
      toolName?: string;
      content?: { type: string; text?: string }[] | string;
    }[];
    const all = JSON.stringify(messages);
    const role = /Act as the ([A-Za-z ]+)\./.exec(all)?.[1];
    const results = messages.filter((m) => m.role === 'toolResult');
    const resultOf = (name: string) => {
      const found = results.find((r) => r.toolName === name);
      const text = Array.isArray(found?.content)
        ? found.content.map((c) => c.text ?? '').join('')
        : '';
      return found ? (JSON.parse(text || '{}') as Record<string, unknown>) : null;
    };
    const call = (name: string, args: Record<string, unknown>) =>
      fauxAssistantMessage([fauxToolCall(name, args as Parameters<typeof fauxToolCall>[1])], {
        stopReason: 'toolUse',
      });
    const writeThenSubmit = (text: string) => {
      const written = resultOf('write_artifact');
      if (!written) return call('write_artifact', { text });
      if (!resultOf('submit_result')) {
        return call('submit_result', { artifactVersionIds: [written.artifactVersionId] });
      }
      return fauxAssistantMessage('Done.');
    };
    switch (role) {
      case 'Researcher': {
        const spawned = resultOf('spawn_subagents');
        if (!spawned) {
          return call('spawn_subagents', {
            tasks: [
              { targetNodeId: 'helper', brief: 'Sources for option A.' },
              { targetNodeId: 'helper', brief: 'Sources for option B.' },
            ],
          });
        }
        if (!resultOf('await_tasks')) return call('await_tasks', { taskIds: spawned.taskIds });
        return writeThenSubmit('Notes from both helpers.');
      }
      case 'Research Helper':
        return writeThenSubmit('One part of the notes.');
      case 'Writer': {
        const asked = resultOf('ask');
        if (!asked)
          return call('ask', { targetNodeId: 'respond', body: 'Which source is primary?' });
        return writeThenSubmit(`Draft. Primary source: ${String(asked.body)}`);
      }
      case 'Source Responder':
        if (!resultOf('reply')) return call('reply', { body: 'The 2024 statistics report.' });
        return fauxAssistantMessage('Answered.');
      default:
        return fauxAssistantMessage(`unexpected role ${role}`);
    }
  };

  it('[TC-RUN-004-H] [TC-COL-002-H] a live team delegates, asks and answers through Pi tools', async () => {
    const { transport } = liveRuntime(Array.from({ length: 60 }, () => team));
    const { runId, events } = await liveRun(transport, (d) => {
      const collab = collaborationCorral();
      Object.assign(d, collab);
    });
    const final = await waitForProjection(transport, runId, settled);
    await Promise.resolve();
    expect(final.status).toBe('succeeded');
    const helpers = (final.nodeExecutions.helper ?? []).map((id) => final.executions[id]);
    expect(helpers).toHaveLength(2);
    expect(helpers.every((h) => h?.parentExecutionId === final.nodeExecutions.research?.[0])).toBe(
      true,
    );
    const [question] = Object.values(final.questions);
    expect(question?.answer?.body).toBe('The 2024 statistics report.');
    const draft = await transport.getArtifactText(runId, final.output?.artifactVersionIds[0] ?? '');
    expect(draft).toBe('Draft. Primary source: The 2024 statistics report.');
    expect(events.some((e) => e.type === 'tool.blocked')).toBe(false);
  });
});

describe('reviews through Pi (C-027)', () => {
  it('tells a reviewer the exact target and criteria its review must name', async () => {
    const prompts: string[] = [];
    const { transport } = liveRuntime([
      (context) => {
        prompts.push(JSON.stringify(context.messages));
        return fauxAssistantMessage('Nothing.');
      },
    ]);
    const { runId } = await liveRun(transport, (d) => {
      for (const role of d.roles) role.outputContract = 'review';
    });
    await waitForProjection(transport, runId, settled);
    expect(prompts[0]).toContain('targetArtifactVersionId');
    // The run's criteria version (crit_0001 with sequential ids) is spelled out for the model.
    expect(prompts[0]).toContain('crit_0001');
  });

  it('[TC-ART-003-H] tells a reviewer which criterion ids are valid, so its issues pass the schema (#20)', async () => {
    const prompts: string[] = [];
    const { transport } = liveRuntime([
      (context) => {
        prompts.push(JSON.stringify(context.messages));
        return fauxAssistantMessage('Nothing.');
      },
    ]);
    const { runId } = await liveRun(transport, (d) => {
      for (const role of d.roles) role.outputContract = 'review';
    });
    await waitForProjection(transport, runId, settled);
    expect(prompts[0]).toContain('c1 for the first criterion');
  });
});

it('[TC-RSN-003-N] a directive delivered while legacy preparation waits is present in its permitted context', async () => {
  const { createFauxCore } = await import('@earendil-works/pi-ai');
  const { runWorker } = await import('../src/worker.ts');
  const faux = createFauxCore({});
  let seen = '';
  faux.setResponses([
    (context) => {
      seen = JSON.stringify(context.messages);
      return fauxAssistantMessage('done');
    },
  ]);
  const preparing = new Gate(),
    release = new Gate();
  const directive = {
    directiveId: 'late_directive',
    text: 'Include this instruction exactly once.',
  };
  const { host } = recordingHost({
    prepareModelRequest: async () => {
      preparing.open();
      await release.wait();
      return {
        modelCallId: 'call_1',
        contextSnapshotId: 'context_1',
        profile: 'model-a',
        maxOutputTokens: 256,
        directives: [directive],
      };
    },
  });
  const adapter = new PiAgentAdapter({
    spawn: () => {
      const pair = memoryChannelPair();
      runWorker(pair.worker, { streamFn: faux.streamSimple, resolveModel: () => faux.getModel() });
      return pair.host;
    },
    credentials: async () => ACCESS_TOKEN,
  });
  const handle = await adapter.start(startInput(), host);
  await preparing.wait();
  handle.pushDirective?.(directive);
  await tick();
  release.open();
  await handle.waitForSettlement();
  expect(seen.split(directive.text)).toHaveLength(2);
});

it('[TC-INPUT-001-H] the core worker waits for the person and sends the answer into the next model turn', async () => {
  const { transport } = liveRuntime([
    fauxAssistantMessage(
      [
        fauxToolCall('ask_user', {
          key: 'format',
          questions: [{ id: 'format', kind: 'text', prompt: 'Choose format' }],
        }),
      ],
      { stopReason: 'toolUse' },
    ),
    (context) => {
      expect(JSON.stringify(context.messages)).toContain('A table');
      return fauxAssistantMessage([fauxToolCall('write_artifact', { text: 'Final answer.' })], {
        stopReason: 'toolUse',
      });
    },
    ...writeThenSubmit('Complete'),
  ]);
  const { runId, events } = await liveRun(transport, (d) =>
    d.roles[0]!.allowedCollaborationTools.push('ask_user'),
  );
  const waiting = await waitForProjection(transport, runId, (p) => p.status === 'awaiting_user');
  const event = events.find((e) => e.type === 'user_input.requested');
  if (!event || event.type !== 'user_input.requested') throw new Error('missing request');
  expect(
    (
      await transport.sendCommand({
        schemaVersion: '0.1',
        commandId: 'answer_user',
        runId,
        type: 'answer_user',
        expectedControlRevision: waiting.controlRevision,
        payload: {
          requestId: event.payload.requestId,
          executionId: event.payload.executionId,
          attemptNo: event.payload.attemptNo,
          schemaHash: event.payload.schemaHash,
          answers: [{ questionId: 'format', text: 'A table' }],
        },
      })
    ).status,
  ).toBe('applied');
  expect((await waitForProjection(transport, runId, settled)).status).toBe('succeeded');
});
