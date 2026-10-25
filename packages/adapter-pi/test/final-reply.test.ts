import type { CorralDefinition } from '@corral/contracts';
import { type RunProjection, waitForProjection } from '@corral/core';
import { linearCorral } from '@corral/testkit';
import { type Context, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { expect, it } from 'vitest';
import { liveRuntime } from './harness.ts';

// CR-055: a role that answers with its final reply needs one request for a short answer.

const terminal = (p: RunProjection) => ['succeeded', 'failed', 'cancelled'].includes(p.status);

function definition(answer = true): CorralDefinition {
  const corral = linearCorral(['assistant']);
  corral.input = { ...corral.input, brief: '하이' };
  corral.roles = corral.roles.map((role) => ({
    ...role,
    ...(answer ? { answer: 'final_reply' as const } : {}),
    outputContract: 'text' as const,
    allowedWorkTools: answer ? [] : ['write_artifact'],
    allowedCollaborationTools: answer ? ['update_plan'] : ['submit_result'],
  }));
  return corral;
}

async function start(transport: ReturnType<typeof liveRuntime>['transport'], answer = true) {
  const { runId, receipt } = await transport.startRun({
    schemaVersion: '0.1',
    commandId: 'final_reply_start',
    definition: definition(answer),
    mode: 'live',
  });
  if (!runId) throw new Error(JSON.stringify(receipt.error));
  return runId;
}

it('[TC-LLM-008-H] a final-reply role answers a short message with one request', async () => {
  const contexts: Context[] = [];
  const { transport, credentialCalls } = liveRuntime([
    (context) => {
      contexts.push(context);
      return fauxAssistantMessage('안녕하세요!');
    },
  ]);
  const runId = await start(transport);
  const final = await waitForProjection(transport, runId, terminal);
  expect(final.status).toBe('succeeded');
  expect(credentialCalls).toHaveLength(1);
  const [versionId] = final.output?.artifactVersionIds ?? [];
  expect(await transport.getArtifactText(runId, versionId!)).toBe('안녕하세요!');
  expect(final.artifacts[versionId!]?.modelCallId).toBe(Object.keys(final.modelCalls)[0]);
  const offered = (contexts[0]?.tools ?? []).map((tool) => tool.name);
  expect(offered).not.toContain('write_artifact');
  expect(offered).not.toContain('submit_result');
  const system = JSON.stringify(contexts[0]?.messages.filter((m) => m.role === 'system'));
  expect(system).not.toContain('call write_artifact');
  expect(system).toContain('Reply to the person directly');
});

it('[TC-LLM-008-H] after a tool call, the following plain reply is the result', async () => {
  const { transport, credentialCalls } = liveRuntime([
    fauxAssistantMessage([fauxToolCall('update_plan', {})], { stopReason: 'toolUse' }),
    fauxAssistantMessage('Done after checking.'),
  ]);
  const runId = await start(transport);
  const final = await waitForProjection(transport, runId, terminal);
  expect(final.status).toBe('succeeded');
  expect(credentialCalls).toHaveLength(2);
  const [versionId] = final.output?.artifactVersionIds ?? [];
  expect(await transport.getArtifactText(runId, versionId!)).toBe('Done after checking.');
  expect(final.artifacts[versionId!]?.modelCallId).toBe(Object.keys(final.modelCalls)[1]);
});

it('[TC-LLM-008-N] an ordinary role still needs write_artifact and submit_result', async () => {
  const { transport } = liveRuntime([fauxAssistantMessage('Plain text only.')]);
  const final = await waitForProjection(transport, await start(transport, false), terminal);
  expect(final.status).toBe('failed');
  expect(final.output).toBeNull();
});

it.each([
  ['empty', fauxAssistantMessage('')],
  ['truncated', fauxAssistantMessage('Incomplete', { stopReason: 'length' })],
  ['provider error', fauxAssistantMessage('Partial', { stopReason: 'error' })],
] as const)('[TC-LLM-008-F] a %s final reply submits nothing', async (_case, response) => {
  const { transport } = liveRuntime([response]);
  const final = await waitForProjection(transport, await start(transport), terminal);
  expect(final.status).toBe('failed');
  expect(final.output).toBeNull();
  expect(Object.values(final.toolCalls)).toHaveLength(0);
});
