import type { MeetingConfig, RunEvent } from '@corral/contracts';
import { meetingAnswerDefinition, type RunProjection, waitForProjection } from '@corral/core';
import { Gate } from '@corral/testkit';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { expect, it } from 'vitest';
import { liveRuntime } from './harness.ts';

const config: MeetingConfig = {
  version: 1,
  participants: ['architect', 'builder'].map((participantId) => ({
    participantId,
    name: participantId,
    prompt: 'Give one independent opinion.',
    modelProfile: 'model-a',
  })),
  secretary: { modelProfile: 'model-a' },
};
const terminal = (p: RunProjection) => ['succeeded', 'failed', 'cancelled'].includes(p.status);
async function start(transport: ReturnType<typeof liveRuntime>['transport'], meeting = true) {
  const { runId, receipt } = await transport.startRun({
    schemaVersion: '0.1',
    commandId: 'meeting_round_architect',
    sessionId: 'session_meeting',
    definition: meetingAnswerDefinition(config, 'architect', 'round', 'Give a short opinion.'),
    mode: 'live',
    ...(meeting
      ? { meeting: { sessionId: 'session_meeting', roundId: 'round', participantId: 'architect' } }
      : {}),
  });
  if (!runId) throw new Error(JSON.stringify(receipt.error));
  return runId;
}

it('[TC-MEET-001-H] commits a clean plain meeting answer through Coordinator tools without another model request', async () => {
  let prompt: string | undefined;
  const { transport, credentialCalls } = liveRuntime([
    (context) => {
      prompt = JSON.stringify(context.messages.filter((message) => message.role === 'system'));
      return fauxAssistantMessage('Keep one service.');
    },
  ]);
  const runId = await start(transport);
  const events: RunEvent[] = [];
  transport.subscribe(runId, 0, { onEvent: (event) => events.push(event) });
  const final = await waitForProjection(transport, runId, terminal);
  expect(final.status).toBe('succeeded');
  expect(await transport.getArtifactText(runId, final.output!.artifactVersionIds[0]!)).toBe(
    'Keep one service.',
  );
  expect(Object.values(final.toolCalls).map((call) => call.name)).toEqual([
    'write_artifact',
    'submit_result',
  ]);
  expect(credentialCalls).toHaveLength(1);
  expect(
    events.filter((event) => event.type === 'tool.requested').map((event) => event.actor),
  ).toEqual([
    { kind: 'runtime', id: 'coordinator' },
    { kind: 'runtime', id: 'coordinator' },
  ]);
  const artifact = final.artifacts[final.output!.artifactVersionIds[0]!];
  expect(artifact?.modelCallId).toBe(Object.keys(final.modelCalls)[0]);
  expect(prompt).toContain('Your display name in this shared conversation');
  expect(prompt).not.toContain('Complete the requested work');
  expect(prompt).not.toContain('When your work is complete, call write_artifact');
});

it.each([
  ['empty', fauxAssistantMessage('')],
  ['whitespace', fauxAssistantMessage('  \n  ')],
  ['truncated', fauxAssistantMessage('Incomplete answer', { stopReason: 'length' })],
  ['provider error', fauxAssistantMessage('Partial answer', { stopReason: 'error' })],
] as const)('[TC-MEET-001-F] does not submit %s meeting output', async (_case, response) => {
  const { transport, credentialCalls } = liveRuntime([response]);
  const final = await waitForProjection(transport, await start(transport), terminal);
  expect(final.status).toBe('failed');
  expect(final.output).toBeNull();
  expect(Object.values(final.toolCalls)).toHaveLength(0);
  expect(credentialCalls).toHaveLength(1);
});

it('[TC-MEET-001-F] does not replace an incomplete tool workflow with the following plain text', async () => {
  const { transport, credentialCalls } = liveRuntime([
    fauxAssistantMessage([fauxToolCall('write_artifact', { text: 'Unsubmitted draft.' })], {
      stopReason: 'toolUse',
    }),
    fauxAssistantMessage('I forgot to submit.'),
  ]);
  const final = await waitForProjection(transport, await start(transport), terminal);
  expect(final.status).toBe('failed');
  expect(final.output).toBeNull();
  expect(Object.values(final.toolCalls).map((call) => call.name)).toEqual(['write_artifact']);
  expect(credentialCalls).toHaveLength(2);
});

it('[TC-MEET-001-N] does not infer meeting authority from an ordinary work definition', async () => {
  const { transport } = liveRuntime([fauxAssistantMessage('This is only a work response.')]);
  const final = await waitForProjection(transport, await start(transport, false), terminal);
  expect(final.status).toBe('failed');
  expect(final.output).toBeNull();
  expect(Object.values(final.toolCalls)).toHaveLength(0);
});

it('[TC-MEET-001-N] a stopped meeting answer cannot submit late plain text', async () => {
  const gate = new Gate();
  const { transport } = liveRuntime([
    async () => {
      await gate.wait();
      return fauxAssistantMessage('Late answer.');
    },
  ]);
  const runId = await start(transport);
  await waitForProjection(transport, runId, (p) => Object.keys(p.modelCalls).length === 1);
  await transport.sendCommand({
    schemaVersion: '0.1',
    commandId: 'stop_meeting',
    runId,
    type: 'cancel',
    payload: { scope: { kind: 'run' }, reason: 'Stop this round.' },
  });
  gate.open();
  const final = await waitForProjection(transport, runId, terminal);
  expect(final.status).toBe('cancelled');
  expect(final.output).toBeNull();
  expect(Object.values(final.toolCalls)).toHaveLength(0);
});

it('[TC-MEET-001-N] cancellation after saving the plain answer prevents its submission', async () => {
  const { transport } = liveRuntime([fauxAssistantMessage('Answer before the stop.')]);
  const runId = await start(transport);
  transport.subscribe(runId, 0, {
    onEvent: (event) => {
      if (event.type === 'artifact.version_created')
        void transport.sendCommand({
          schemaVersion: '0.1',
          commandId: 'stop_before_submit',
          runId,
          type: 'cancel',
          payload: { scope: { kind: 'run' }, reason: 'Stop before submission.' },
        });
    },
  });
  const final = await waitForProjection(transport, runId, terminal);
  expect(final.status).toBe('cancelled');
  expect(final.output).toBeNull();
  expect(Object.values(final.tasks).every((task) => task.status !== 'completed')).toBe(true);
});
