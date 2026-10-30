import { ReasoningInput } from '@corral/contracts';
import type { Context } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import { requestReasoningInput } from '../src/reasoning-input.ts';
import { assignmentMetadata, withoutAssignmentMetadata } from '../src/worker-tools.ts';

describe('private judge request input', () => {
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
