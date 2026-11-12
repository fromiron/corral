import { SNAPSHOT_SOURCE_BYTES } from '@corral/contracts';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { describe, expect, it } from 'vitest';
import { callSnapshotInput, snapshotText } from '../src/call-snapshot.ts';
import { assignmentMetadata, directiveText, sdkDirectiveText } from '../src/worker-tools.ts';

// features/effort-routing.md#판정-입력: what the worker reads from its settled request context.

const assistant = (
  text: string,
  calls: { id: string; name: string; arguments: Record<string, unknown> }[] = [],
): AgentMessage =>
  ({
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'hidden chain' },
      ...(text ? [{ type: 'text', text }] : []),
      ...calls.map((call) => ({ type: 'toolCall', ...call })),
    ],
    provider: 'openai',
    api: 'openai-responses',
    model: 'gpt-6-luna',
    usage: {},
    stopReason: calls.length ? 'toolUse' : 'stop',
    timestamp: 1,
  }) as unknown as AgentMessage;
const result = (toolCallId: string, text: string, isError = false): AgentMessage =>
  ({
    role: 'toolResult',
    toolCallId,
    toolName: 'bash',
    content: [{ type: 'text', text }],
    isError,
    timestamp: 1,
  }) as unknown as AgentMessage;
const user = (content: unknown): AgentMessage =>
  ({ role: 'user', content, timestamp: 1 }) as AgentMessage;

describe('the call snapshot a worker sends', () => {
  it('reads the request without Corral metadata, state or directive messages', () => {
    const snapshot = callSnapshotInput({
      messages: [
        { role: 'system', content: 'system rules', timestamp: 1 } as unknown as AgentMessage,
        user(`${assignmentMetadata('{"criteriaVersionId":"crit_1"}')}## brief\n\nFix the parser.`),
        user(directiveText({ directiveId: 'dir_1', text: 'Keep the API.' })),
        { role: 'user', content: '[Corral current state]\n{"questions":[]}', timestamp: 0 },
      ],
    });
    expect(snapshot.request?.text).toBe('## brief\n\nFix the parser.');
    expect(JSON.stringify(snapshot)).not.toContain('criteriaVersionId');
    expect(JSON.stringify(snapshot)).not.toContain('Keep the API.');
    expect(snapshot.previousAssistant).toBeNull();
    expect(snapshot.toolCalls).toEqual([]);
  });

  it('#200: an instruction the SDK worker delivered mid-step is not the task', () => {
    const snapshot = callSnapshotInput({
      messages: [
        user('Fix the parser bug.'),
        assistant('Running the tests first.', [{ id: 't1', name: 'bash', arguments: {} }]),
        result('t1', '1 failing', true),
        user(sdkDirectiveText({ directiveId: 'dir_1', text: 'Keep the public API.' })),
      ],
    });
    expect(snapshot.request?.text).toBe('Fix the parser bug.');
    expect(snapshot.previousAssistant?.text).toBe('Running the tests first.');
    expect(snapshot.toolCalls.map((call) => call.toolCallId)).toEqual(['t1']);
    expect(JSON.stringify(snapshot)).not.toContain('Keep the public API.');
  });

  it('keeps every tool call of the latest step with its own status (P02, P08)', () => {
    const calls = [1, 2, 3, 4, 5].map((n) => ({
      id: `c${n}`,
      name: 'bash',
      arguments: { command: `step ${n}` },
    }));
    const snapshot = callSnapshotInput({
      messages: [
        user('Run the checks.'),
        assistant('Running five checks.', calls),
        result('c1', 'first try failed', true),
        result('c1', 'ok'),
        result('c2', 'boom', true),
        result('c3', 'fine'),
        result('c4', 'fine too'),
      ],
    });
    expect(snapshot.previousAssistant?.text).toBe('Running five checks.');
    expect(snapshot.toolCalls.map((c) => [c.toolCallId, c.status, c.result?.text ?? null])).toEqual(
      [
        ['c1', 'completed', 'ok'],
        ['c2', 'failed', 'boom'],
        ['c3', 'completed', 'fine'],
        ['c4', 'completed', 'fine too'],
        ['c5', 'pending', null],
      ],
    );
    expect(snapshot.toolCalls[0]!.args.text).toBe('{"command":"step 1"}');
    expect(JSON.stringify(snapshot)).not.toContain('hidden chain');
  });

  it('counts images without sending them and keeps earlier replies apart', () => {
    const snapshot = callSnapshotInput({
      messages: [
        user('First question'),
        assistant('First answer'),
        user([
          { type: 'text', text: 'What is in this picture?' },
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        ]),
      ],
    });
    expect(snapshot.request?.text).toBe('What is in this picture?');
    expect(snapshot.requestImages).toBe(1);
    expect(JSON.stringify(snapshot)).not.toContain('AAAA');
    expect(snapshot.previousAssistant).toBeNull();
    expect(snapshot.earlierReplies.map((r) => r.text)).toEqual(['First answer']);
  });

  it('cuts a long source at the contract limit and says how long it was', () => {
    const long = `${'가'.repeat(5000)}${'z'.repeat(5000)}`;
    const cut = snapshotText(long);
    expect(Buffer.byteLength(cut.text)).toBeLessThanOrEqual(SNAPSHOT_SOURCE_BYTES);
    expect(cut.originalBytes).toBe(Buffer.byteLength(long));
    expect(cut.text.startsWith('가')).toBe(true);
    expect(cut.text.endsWith('z')).toBe(true);
    expect(snapshotText('short')).toEqual({ text: 'short' });
  });
});
