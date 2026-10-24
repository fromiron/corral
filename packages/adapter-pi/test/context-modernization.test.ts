import { createHash } from 'node:crypto';
import { canonicalJson } from '@corral/contracts';
import { type Context, fauxAssistantMessage } from '@earendil-works/pi-ai';
import { expect, it } from 'vitest';
import {
  ContextMeter,
  measureContext,
  pruneToolResults,
  selectCompactableRange,
  summarizeRegion,
} from '../src/ported/dsh/context.ts';
import { requestOutputCap } from '../src/reasoning.ts';
import { missingParentQuestions, withProtectedContext } from '../src/request-record.ts';

it('[TC-LLM-004-N] an internal summary suspends the normal output contract without changing the retained prefix', async () => {
  const system = {
    role: 'system' as const,
    content: 'Complete work with write_artifact then submit_result.',
    timestamp: 0,
  };
  const context: Context = {
    messages: [system, { role: 'user', content: 'Keep this task. '.repeat(1000), timestamp: 1 }],
  };
  const compacted = await summarizeRegion(
    context,
    { start: 1, end: 1 },
    async (request) => {
      expect(request.messages[0]).toEqual(system);
      expect(
        request.messages.filter((message) => message.role === 'system').at(-1)?.content,
      ).toContain('internal context-compaction');
      return fauxAssistantMessage('Keep this task.');
    },
    () => 2,
  );
  expect(compacted.context.messages.filter((message) => message.role === 'system')).toEqual([
    system,
  ]);
  expect(JSON.stringify(compacted.context)).not.toContain('internal context-compaction');
});

it.each([40, 400])(
  '[TC-LLM-004-N] calibrates an unchanged prefix to reported usage (%s), then estimates only its growth',
  (tokens) => {
    const meter = new ContextMeter();
    const model = { id: 'fixture', provider: 'fixture', api: 'fixture' };
    const context: Context = {
      messages: [{ role: 'user', content: 'text '.repeat(100), timestamp: 1 }],
    };
    const message = fauxAssistantMessage('answer');
    message.usage.input = tokens;
    meter.observe(context, model, message);
    expect(meter.measure(context, model)).toEqual({ tokens, source: 'usage_anchor' });
    const next: Context = { messages: [...context.messages, message] };
    expect(meter.measure(next, model)).toEqual({
      tokens: tokens + measureContext(next) - measureContext(context),
      source: 'usage_anchor',
    });
    expect(meter.measure(next, { ...model, id: 'other' })).toEqual({
      tokens: measureContext(next),
      source: 'estimated',
    });
    const replaced: Context = { messages: [{ role: 'user', content: 'different', timestamp: 1 }] };
    expect(meter.measure(replaced, model).source).toBe('estimated');
  },
);

it('[TC-LLM-004-N] preserves fresh tool evidence and compacts an oversized first input', () => {
  const result = {
    role: 'toolResult' as const,
    toolCallId: 'read_1',
    toolName: 'read_file',
    content: [{ type: 'text' as const, text: 'x'.repeat(30000) }],
    isError: false,
    timestamp: 1,
  };
  const context: Context = {
    messages: [
      {
        ...fauxAssistantMessage(''),
        content: [{ type: 'toolCall', id: 'read_1', name: 'read_file', arguments: {} }],
      },
      result,
    ],
  };
  expect(pruneToolResults(context).messages[1]).toBe(result);
  context.messages.push(fauxAssistantMessage('seen'));
  expect(pruneToolResults(context).messages[1]).toBe(result);
  Object.assign(result, { details: { contextSource: { toolCallId: 'read_1' } } });
  expect(JSON.stringify(pruneToolResults(context)).length).toBeLessThan(10000);
  expect(JSON.stringify(pruneToolResults(context))).toContain('read_artifact');
  expect(
    selectCompactableRange([{ role: 'user', content: 'x'.repeat(91000), timestamp: 1 }], 8000),
  ).toEqual({ start: 0, end: 0 });
});

it('[TC-LLM-004-N] parent questions already present in current host state are not appended again', () => {
  const question = {
    questionId: 'question_1',
    senderExecutionId: 'child',
    body: '새 질문',
    artifactRefs: ['artifact_1'],
    deadline: '2026-10-24T00:00:00Z',
  };
  const sections = [
    {
      name: 'corral_state',
      text: JSON.stringify({ questions: [question] }),
      version: 1,
      reason: 'coordinator_state',
    },
  ];
  expect(missingParentQuestions([question], sections)).toEqual([]);
  expect(missingParentQuestions([{ ...question, body: '다른 질문' }], sections)).toHaveLength(1);
  expect(missingParentQuestions([question], [])).toEqual([question]);
});

it('[TC-LLM-004-F] keeps only current host state and leaves model output space', () => {
  const state = (text: string) => ({
    version: 1 as const,
    revision: 1,
    hash: createHash('sha256').update(canonicalJson(text)).digest('hex'),
    text,
  });
  const first = withProtectedContext({ messages: [] }, state('old'));
  const next = withProtectedContext(first.context, state('current'));
  expect(next.context.messages).toHaveLength(1);
  expect(JSON.stringify(next.context)).not.toContain('old');
  expect(requestOutputCap({ maxTokens: 4096, contextWindow: 8192 }, 4096, 8000)).toBe(192);
  expect(() => requestOutputCap({ maxTokens: 4096, contextWindow: 8192 }, 4096, 8192)).toThrow(
    /context/,
  );
});
