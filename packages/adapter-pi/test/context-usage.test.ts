import { ModelRequestRecord } from '@corral/contracts';
import { describe, expect, it } from 'vitest';
import { inspectContext, reconcileContextUsage } from '../src/context-usage.ts';
import { requestRecord } from '../src/request-record.ts';

const hash = 'a'.repeat(64);

describe('context usage measurement', () => {
  it('keeps Google configuration system and tool input in the measured request', () => {
    const inspected = inspectContext(
      {
        messages: [
          {
            role: 'system',
            content: 'System instructions',
            toolsAdded: [{ name: 'lookup', parameters: { type: 'object' } }],
          },
        ],
      },
      { mcpToolNames: ['lookup'] },
    );
    const usage = reconcileContextUsage(
      inspected.usage,
      inspected.probes,
      JSON.stringify({
        model: 'example',
        contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
        config: {
          systemInstruction: 'System instructions',
          tools: [
            {
              functionDeclarations: [{ name: 'lookup', parametersJsonSchema: { type: 'object' } }],
            },
          ],
        },
      }),
    );
    expect(usage.completeness).toBe('complete');
    expect(usage.parts.find((part) => part.category === 'system_prompt')?.tokens).toBeGreaterThan(
      0,
    );
    expect(usage.parts.find((part) => part.category === 'mcp_tools')?.tokens).toBeGreaterThan(0);
  });

  it('retained provider reasoning text is counted and opaque reasoning is partial', () => {
    const inspected = inspectContext({ messages: [{ role: 'user', content: 'hello' }] });
    const base = {
      role: 'assistant',
      content: 'answer',
      reasoning_content: 'Earlier provider reasoning',
    };
    const usage = reconcileContextUsage(
      inspected.usage,
      inspected.probes,
      JSON.stringify({
        messages: [{ role: 'user', content: 'hello' }, base],
      }),
    );
    expect(usage.usedTokens).toBe(
      Math.ceil('hello'.length / 4) +
        Math.ceil('answer'.length / 4) +
        Math.ceil(base.reasoning_content.length / 4),
    );
    const opaque = reconcileContextUsage(
      inspected.usage,
      inspected.probes,
      JSON.stringify({
        messages: [
          { ...base, reasoning_details: [{ type: 'reasoning.encrypted', data: 'opaque' }] },
        ],
      }),
    );
    expect(opaque.completeness).toBe('partial');
  });

  it('Google tool-result images and opaque thought signatures remain partial', () => {
    const inspected = inspectContext({ messages: [{ role: 'user', content: 'hello' }] });
    for (const part of [
      {
        functionResponse: {
          name: 'lookup',
          response: { result: 'image' },
          parts: [{ inlineData: { mimeType: 'image/png', data: 'x'.repeat(4000) } }],
        },
      },
      { text: 'answer', thoughtSignature: 'opaque' },
    ]) {
      const usage = reconcileContextUsage(
        inspected.usage,
        inspected.probes,
        JSON.stringify({
          contents: [{ role: 'model', parts: [part] }],
        }),
      );
      expect(usage.completeness).toBe('partial');
      expect(usage.usedTokens).toBeLessThan(100);
    }
  });

  it('measures provider tool definitions structurally after serialization', () => {
    const tool = {
      name: 'lookup',
      description: 'Look up documents.',
      parameters: { type: 'object', properties: { query: { type: 'string' } } },
    };
    const inspected = inspectContext(
      {
        messages: [
          { role: 'system', content: 'System', toolsAdded: [tool] },
          { role: 'user', content: 'hello' },
        ],
      },
      { mcpToolNames: ['lookup'] },
    );
    const payload = {
      instructions: 'System',
      input: [{ role: 'user', content: 'hello' }],
      tools: [{ type: 'function', ...tool }],
    };
    const usage = reconcileContextUsage(inspected.usage, inspected.probes, JSON.stringify(payload));
    expect(usage.completeness).toBe('complete');
    expect(usage.parts.find((part) => part.category === 'mcp_tools')?.tokens).toBeGreaterThan(0);
    expect(usage.parts.some((part) => part.omission)).toBe(false);
  });

  it('final payload additions and short removals cannot retain a falsely complete estimate', () => {
    const inspected = inspectContext({
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hello' },
      ],
    });
    const usage = reconcileContextUsage(
      inspected.usage,
      inspected.probes,
      JSON.stringify({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'hello plus text from a payload hook' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
            ],
          },
        ],
      }),
    );
    expect(usage.completeness).toBe('partial');
    expect(usage.parts.find((part) => part.category === 'system_prompt')?.tokens ?? 0).toBe(0);
    expect(usage.parts.find((part) => part.category === 'messages')?.tokens).toBeGreaterThan(
      Math.ceil('hello'.length / 4),
    );
    expect(usage.parts.some((part) => part.omission === 'unmeasured_image')).toBe(true);
  });

  it('tool calls and structured source text are measured once', () => {
    const memory = 'Remember the approved requirement.';
    const inspected = inspectContext(
      {
        messages: [
          { role: 'system', content: `Base ${memory}` },
          {
            role: 'assistant',
            content: [
              {
                type: 'toolCall',
                id: 'tool_1',
                name: 'lookup',
                arguments: { query: '日本語の資料' },
              },
            ],
          },
        ],
      },
      { memoryTexts: [memory] },
    );
    expect(inspected.usage.completeness).toBe('complete');
    expect(inspected.usage.parts.find((part) => part.category === 'memory_files')?.tokens).toBe(
      Math.ceil(memory.length / 4),
    );
    expect(inspected.usage.parts.find((part) => part.category === 'system_prompt')?.tokens).toBe(
      Math.ceil('Base '.length / 4),
    );
    expect(
      inspected.usage.parts.find((part) => part.category === 'messages')?.tokens,
    ).toBeGreaterThan(0);
  });

  it('empty or unsupported payloads keep aggregate and parts consistent', () => {
    const inspected = inspectContext({
      messages: [
        { role: 'system', content: 'private system' },
        { role: 'user', content: 'hello' },
      ],
    });
    for (const payload of ['', JSON.stringify({ custom_prompt: 'opaque' })]) {
      const usage = reconcileContextUsage(inspected.usage, inspected.probes, payload);
      expect(usage.completeness).not.toBe('complete');
      expect(usage.usedTokens).toBe(usage.parts.reduce((sum, part) => sum + part.tokens, 0));
    }
  });
  it('CTX-02 counts included categories once with the same estimator', () => {
    const skill = 'Skill resources: skills/review/\nReview the diff.';
    const system = 'You are the writer.';
    const inspected = inspectContext({
      messages: [
        {
          role: 'system',
          content: system,
          sections: { corral_identity: system, skill_review: skill },
          toolsAdded: [{ name: 'read', parameters: { type: 'object' } }],
        },
        { role: 'user', content: '계획을 세워 줘', timestamp: 1 },
        { role: 'assistant', content: [{ type: 'text', text: '확인했습니다' }], timestamp: 2 },
      ],
    });
    const { usage } = inspected;
    expect(usage.coverage).toBe('request');
    expect(usage.completeness).toBe('complete');
    expect(usage.method).toBe('pi-1.3.0-chars4');
    expect(usage.usedTokens).toBe(usage.parts.reduce((sum, part) => sum + part.tokens, 0));
    expect(usage.parts.map((part) => part.category).sort()).toEqual(
      ['messages', 'skills', 'system_prompt', 'system_tools'].sort(),
    );
    const messages = usage.parts.find((part) => part.category === 'messages');
    // Korean/Japanese use the same chars/4 heuristic and are not provider tokens.
    expect(messages?.tokens).toBe(
      Math.ceil('계획을 세워 줘'.length / 4) + Math.ceil('확인했습니다'.length / 4),
    );
    expect(usage.parts.find((part) => part.category === 'skills')?.tokens).toBe(
      Math.ceil(skill.length / 4),
    );
    expect(usage.parts.find((part) => part.category === 'memory_files')).toBeUndefined();
  });

  it('CTX-01 CTX-04 legacy messages stay messages-only and images are partial', () => {
    const only = inspectContext({
      messages: [{ role: 'user', content: 'hello', timestamp: 1 }],
    });
    expect(only.usage.coverage).toBe('messages');
    expect(only.usage.completeness).toBe('complete');
    expect(only.usage.parts).toEqual([
      { category: 'messages', tokens: Math.ceil('hello'.length / 4) },
    ]);

    const image = inspectContext({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'see' },
            { type: 'image', data: 'abc', mimeType: 'image/png' },
          ],
          timestamp: 1,
        },
      ],
    });
    expect(image.usage.completeness).toBe('partial');
    expect(image.usage.parts.find((part) => part.category === 'messages')?.omission).toBe(
      'unmeasured_image',
    );
    expect(image.usage.parts.find((part) => part.category === 'messages')?.tokens).toBe(
      Math.ceil('see'.length / 4),
    );

    const legacy = ModelRequestRecord.parse({
      purpose: 'turn',
      directiveIds: [],
      contextHash: hash,
      contextBytes: 4,
      sections: [],
      contextEstimate: { tokens: 3, method: 'pi-1.3.0-messages' },
    });
    expect(legacy.contextUsage).toBeUndefined();
  });

  it('CTX-03 does not add provider or cache tokens into the estimate', () => {
    const { usage } = inspectContext({
      messages: [
        { role: 'system', content: 'system text', timestamp: 0 },
        { role: 'user', content: 'hello', timestamp: 1 },
      ],
    });
    expect(usage.usedTokens).toBe(
      Math.ceil('system text'.length / 4) + Math.ceil('hello'.length / 4),
    );
    expect(JSON.stringify(usage)).not.toContain('cache');
  });

  it('drops parts missing from the provider payload and does not claim a full ratio', () => {
    const { usage, probes } = inspectContext({
      messages: [
        {
          role: 'system',
          content: 'Keep this protected instruction in the request.',
          timestamp: 0,
        },
        { role: 'user', content: 'short', timestamp: 1 },
      ],
    });
    const serialized = JSON.stringify({ messages: [{ role: 'user', content: 'short' }] });
    const reconciled = reconcileContextUsage(usage, probes, serialized);
    expect(reconciled.completeness).toBe('partial');
    expect(reconciled.parts.find((part) => part.category === 'system_prompt')?.omission).toBe(
      'not_in_payload',
    );
    expect(reconciled.usedTokens).toBeLessThan(usage.usedTokens ?? 0);
  });

  it('request records keep the message estimate and add a separate usage snapshot', () => {
    const record = requestRecord(
      {
        messages: [
          { role: 'system', content: 'system text', timestamp: 0 },
          { role: 'user', content: 'hello', timestamp: 1 },
        ],
      },
      'turn',
      'pi-core',
      [],
      [],
    );
    expect(record.contextEstimate?.method).toBe('dsh-density-v2');
    expect(record.contextUsage?.coverage).toBe('request');
    expect(record.contextUsage?.method).toBe('pi-1.3.0-chars4');
    expect(record.contextHash).toHaveLength(64);
  });
});
