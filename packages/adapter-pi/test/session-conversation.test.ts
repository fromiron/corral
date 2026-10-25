import type { RunProjection } from '@corral/core';
import { waitForProjection } from '@corral/core';
import { linearCorral } from '@corral/testkit';
import {
  type Context,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import { expect, it } from 'vitest';
import { liveRuntime } from './harness.ts';

// CR-054: session turns reach the model as user/assistant messages between the stable system
// prefix and the current assignment, so each follow-up's request extends the previous one.

const LONG_ANSWER = `Fibonacci: ${'each number is the sum of the two before it. '.repeat(20)}`;

const textOf = (message: Context['messages'][number]) =>
  typeof message.content === 'string'
    ? message.content
    : message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('');

it('[TC-LLM-007-H] turns precede the assignment and later follow-ups reuse them as a cached prefix', async () => {
  const firstRequests: Context['messages'][] = [];
  const respond: FauxResponseStep = (context) => {
    const assignment = context.messages.find(
      (message) =>
        message.role === 'user' && textOf(message).includes('[Corral assignment metadata]'),
    );
    const brief = /## brief\n\n([\s\S]*?)(?:\n\n## |$)/.exec(textOf(assignment!))?.[1] ?? '';
    const resultOf = (name: string) => {
      const message = context.messages.find(
        (item) => item.role === 'toolResult' && item.toolName === name,
      );
      return message ? (JSON.parse(textOf(message) || '{}') as Record<string, unknown>) : null;
    };
    const call = (name: string, args: Record<string, unknown>) =>
      fauxAssistantMessage([fauxToolCall(name, args as Parameters<typeof fauxToolCall>[1])], {
        stopReason: 'toolUse',
      });
    const written = resultOf('write_artifact');
    if (!written) {
      firstRequests.push(structuredClone(context.messages));
      return call('write_artifact', {
        text: brief === '피보나치 수열 설명해봐' ? LONG_ANSWER : `Reply to ${brief}`,
      });
    }
    if (!resultOf('submit_result'))
      return call('submit_result', { artifactVersionIds: [written.artifactVersionId] });
    return fauxAssistantMessage('Done.');
  };
  const { transport } = liveRuntime(Array.from({ length: 30 }, () => respond));
  const run = async (commandId: string, brief: string, throughRunId?: string) => {
    const definition = linearCorral(['writer']);
    definition.input = { ...definition.input, brief };
    const { runId, receipt } = await transport.startRun({
      schemaVersion: '0.1',
      commandId,
      definition,
      mode: 'live',
      sessionId: 'session_chat',
      ...(throughRunId ? { conversation: { throughRunId } } : {}),
    } as Parameters<typeof transport.startRun>[0]);
    if (!runId) throw new Error(JSON.stringify(receipt.error));
    const final = await waitForProjection(transport, runId, (state) =>
      ['succeeded', 'failed', 'cancelled'].includes(state.status),
    );
    expect(final.status).toBe('succeeded');
    return { runId, final };
  };
  const firstCached = (final: RunProjection) =>
    Object.values(final.modelCalls)[0]?.usage?.cachedInputTokens ?? 0;

  const first = await run('cmd_first', '피보나치 수열 설명해봐');
  const second = await run('cmd_second', '하이', first.runId);
  const third = await run('cmd_third', '고마워', second.runId);

  const request = firstRequests[1]!;
  expect(request.map((message) => message.role)).toEqual([
    'system',
    'user',
    'assistant',
    'user',
    'user',
  ]);
  expect(textOf(request[1]!)).toBe('피보나치 수열 설명해봐');
  expect(textOf(request[2]!)).toBe(LONG_ANSWER);
  const assignment = textOf(request[3]!);
  expect(assignment).toContain('## brief\n\n하이');
  expect(assignment).toContain('earlier messages are prior requests and answers');
  expect(assignment).not.toContain('Start from this earlier version');
  expect(assignment).not.toContain(LONG_ANSWER);
  expect(textOf(request[4]!).startsWith('[Corral current state]\n')).toBe(true);

  // The third request starts with the second's turns, so the long first answer is cached.
  expect(textOf(firstRequests[2]![2]!)).toBe(LONG_ANSWER);
  expect(textOf(firstRequests[2]![3]!)).toBe('하이');
  expect(firstCached(third.final) - firstCached(second.final)).toBeGreaterThanOrEqual(
    Math.floor(LONG_ANSWER.length / 4),
  );
});
