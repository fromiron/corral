import { ReasoningInput } from '@corral/contracts';
import type { Context } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import { requestReasoningInput } from '../src/reasoning-input.ts';
import { assignmentMetadata, withoutAssignmentMetadata } from '../src/worker-tools.ts';

describe('private judge request input', () => {
  it('uses authoritative tool status rather than error-looking or innocuous result text', () => {
    const context = {
      messages: [
        { role: 'user', content: 'Inspect the files', timestamp: 1 },
        {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'failed', name: 'read', arguments: { path: 'one' } },
            { type: 'toolCall', id: 'completed', name: 'read', arguments: { path: 'two' } },
            { type: 'toolCall', id: 'pending', name: 'read', arguments: { path: 'three' } },
          ],
          timestamp: 2,
        },
        {
          role: 'toolResult',
          toolCallId: 'failed',
          toolName: 'read',
          isError: true,
          content: [{ type: 'text', text: 'No additional information.' }],
          timestamp: 3,
        },
        {
          role: 'toolResult',
          toolCallId: 'completed',
          toolName: 'read',
          isError: false,
          content: [
            { type: 'text', text: 'Error: failed operation. This is example file content.' },
          ],
          timestamp: 4,
        },
        {
          role: 'toolResult',
          toolCallId: 'unrelated',
          toolName: 'read',
          isError: true,
          content: [{ type: 'text', text: 'An unrelated call failed.' }],
          timestamp: 5,
        },
      ],
    } as Context;
    const before = structuredClone(context);
    const input = requestReasoningInput(context, 'turn', '', []);
    expect(input.calls).toMatchObject([
      { status: 'failed', result: 'No additional information.' },
      { status: 'completed', result: 'Error: failed operation. This is example file content.' },
      { status: 'pending', result: '' },
    ]);
    expect(context).toEqual(before);
    expect(ReasoningInput.safeParse(input).success).toBe(true);
  });

  it.each([true, false])(
    'uses the latest matching result after the current assistant (isError=%s)',
    (latestError) => {
      const result = (isError: boolean, content: string, timestamp: number) => ({
        role: 'toolResult',
        toolCallId: 'c1',
        toolName: 'read',
        isError,
        content: [{ type: 'text', text: content }],
        timestamp,
      });
      const context = {
        messages: [
          { role: 'user', content: 'Inspect again', timestamp: 1 },
          result(!latestError, 'Earlier assistant result must stay out', 2),
          {
            role: 'assistant',
            content: [{ type: 'toolCall', id: 'c1', name: 'read', arguments: {} }],
            timestamp: 3,
          },
          result(!latestError, 'First matching result', 4),
          result(latestError, 'Latest matching result', 5),
          { ...result(!latestError, 'Unrelated latest result', 6), toolCallId: 'other' },
        ],
      } as Context;
      const before = structuredClone(context);
      expect(requestReasoningInput(context, 'turn', '', []).calls).toEqual([
        {
          name: 'read',
          args: '{}',
          result: 'First matching result\nLatest matching result',
          status: latestError ? 'failed' : 'completed',
        },
      ]);
      expect(context).toEqual(before);
    },
  );

  it('keeps a call pending when its ID matches only a result before the current assistant', () => {
    const context = {
      messages: [
        { role: 'user', content: 'Inspect again', timestamp: 1 },
        {
          role: 'toolResult',
          toolCallId: 'c1',
          toolName: 'read',
          isError: true,
          content: [{ type: 'text', text: 'Previous failure' }],
          timestamp: 2,
        },
        {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'c1', name: 'read', arguments: {} }],
          timestamp: 3,
        },
      ],
    } as Context;
    expect(requestReasoningInput(context, 'turn', '', []).calls).toEqual([
      { name: 'read', args: '{}', result: '', status: 'pending' },
    ]);
  });

  it('accepts optional bounded status while keeping legacy private input readable', () => {
    const input = {
      kind: 'step',
      request: 'Inspect',
      prevRequest: '',
      prev: '',
      step: 1,
      plan: '',
      directiveIds: [],
      calls: [{ name: 'read', args: '{}', result: 'text' }],
    };
    expect(ReasoningInput.safeParse(input).success).toBe(true);
    for (const status of ['completed', 'failed', 'pending'])
      expect(
        ReasoningInput.safeParse({ ...input, calls: [{ ...input.calls[0], status }] }).success,
      ).toBe(true);
    expect(
      ReasoningInput.safeParse({ ...input, calls: [{ ...input.calls[0], status: 'guessed' }] })
        .success,
    ).toBe(false);
  });

  it('uses tool results and ordinary text, never hidden thinking', () => {
    const context = {
      messages: [
        { role: 'user', content: 'Fix the parser', timestamp: 1 },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'SECRET THOUGHT' },
            { type: 'text', text: 'Inspect the parser' },
            { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'parser.ts' } },
          ],
          timestamp: 2,
        },
        {
          role: 'toolResult',
          toolCallId: 'c1',
          toolName: 'read',
          content: [{ type: 'text', text: 'x'.repeat(4000) + 'SyntaxError' }],
          timestamp: 3,
        },
      ],
    } as Context;
    const input = requestReasoningInput(context, 'turn', '', []);
    expect(input).toMatchObject({
      kind: 'step',
      request: 'Fix the parser',
      step: 1,
      plan: 'Inspect the parser',
      calls: [{ name: 'read', args: '{"path":"parser.ts"}' }],
    });
    expect(input.calls[0]?.result).toHaveLength(3003);
    expect(input.calls[0]?.result).toContain('SyntaxError');
    expect(JSON.stringify(input)).not.toContain('SECRET');
    expect(requestReasoningInput(context, 'compaction', '', []).kind).toBe('compaction');
  });
});

it('truncates supplementary Unicode by code points within the private IPC bounds', () => {
  const emoji = '😀';
  const context = {
    messages: [
      { role: 'user', content: emoji.repeat(12001), timestamp: 1 },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: emoji.repeat(301) },
          { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: emoji.repeat(161) } },
        ],
        timestamp: 2,
      },
      {
        role: 'toolResult',
        toolCallId: 'c1',
        toolName: 'read',
        content: [{ type: 'text', text: emoji.repeat(3001) }],
        timestamp: 3,
      },
    ],
  } as Context;
  const input = requestReasoningInput(context, 'turn', '', []);
  expect(() => ReasoningInput.parse(input)).not.toThrow();
  expect(Array.from(input.request)).toHaveLength(12000);
  expect(Array.from(input.plan)).toHaveLength(300);
  expect(Array.from(input.calls[0]!.result)).toHaveLength(3003);
  expect(input.calls[0]!.result).toBe(`${emoji.repeat(2000)}\n…\n${emoji.repeat(1000)}`);
  expect(input.request).not.toMatch(/[\uD800-\uDFFF]/u);
  expect(input.calls[0]!.args).not.toMatch(/[\uD800-\uDFFF]/u);
});

it('gives the judge the task, not the assignment metadata in front of it', () => {
  const metadata = JSON.stringify({
    criteriaVersionId: 'av_criteria',
    taskBrief: { inputHash: 'a'.repeat(64), limits: { maxSpawns: 12 }, sourceRefs: [] },
    padding: 'x'.repeat(2000),
  });
  const prompt = `${assignmentMetadata(metadata)}## brief\n\nFix the typo in README`;
  const context = {
    messages: [
      { role: 'user', content: prompt, timestamp: 1 },
      { role: 'assistant', content: [{ type: 'text', text: 'Done' }], timestamp: 2 },
      { role: 'user', content: prompt.replace('typo', 'second typo'), timestamp: 3 },
    ],
  } as Context;
  const input = requestReasoningInput(context, 'turn', '', []);
  expect(input.request).toBe('## brief\n\nFix the second typo in README');
  expect(input.prevRequest).toBe('## brief\n\nFix the typo in README');
  expect(withoutAssignmentMetadata('no metadata here')).toBe('no metadata here');
});

it('judges the request, not the Corral state message appended after it', () => {
  const state = (n: number) => ({
    role: 'user',
    content: `[Corral current state]\n${JSON.stringify({ executionId: `exec_${n}`, limits: { maxSpawns: 12 } })}`,
    timestamp: 0,
  });
  const brief = { role: 'user', content: '## brief\n\nFix the typo in README', timestamp: 1 };
  const first = requestReasoningInput({ messages: [brief, state(1)] } as Context, 'turn', '', []);
  expect(first).toMatchObject({ kind: 'turn', request: brief.content, prevRequest: '' });

  const step = requestReasoningInput(
    {
      messages: [
        brief,
        {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'c1', name: 'write_artifact', arguments: {} }],
          timestamp: 2,
        },
        {
          role: 'toolResult',
          toolCallId: 'c1',
          toolName: 'write_artifact',
          content: [{ type: 'text', text: 'saved' }],
          timestamp: 3,
        },
        state(2),
      ],
    } as Context,
    'turn',
    '',
    [],
  );
  expect(step).toMatchObject({ kind: 'step', request: brief.content, prevRequest: '' });
  expect(step.calls.map((call) => call.name)).toEqual(['write_artifact']);
  expect(JSON.stringify([first, step])).not.toContain('Corral current state');
});
