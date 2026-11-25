import type { ReasoningResolution } from '@corral/contracts';
import { fauxAssistantMessage, normalizeContext } from '@earendil-works/pi-ai';
import { streamSimple as codexStream } from '@earendil-works/pi-ai/api/openai-codex-responses';
import { streamSimple as responsesStream } from '@earendil-works/pi-ai/api/openai-responses';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { describe, expect, it } from 'vitest';
import {
  modelReasoningCapabilities,
  reasoningRequest,
  verifyReasoningWire,
} from '../src/reasoning.ts';

const model = builtinModels().getModel('openai-codex', 'gpt-6-luna')!;
const fixed = (level: 'low' | 'high' | 'max' | 'off' | 'minimal'): ReasoningResolution => ({
  requested: { mode: 'fixed', level },
  resolved: level,
  source: 'fixed',
  preparationId: 'prep',
});
describe('permit reasoning at the provider boundary', () => {
  it('overrides SDK thinking, keeps max and verifies aliases', () => {
    for (const level of ['low', 'high', 'max'] as const) {
      expect(reasoningRequest(model, { reasoning: 'medium' }, fixed(level)).options.reasoning).toBe(
        level,
      );
      expect(verifyReasoningWire(model, { reasoning: { effort: level } }, fixed(level))).toEqual({
        kind: 'effort',
        value: level,
      });
    }
    expect(
      verifyReasoningWire(model, { reasoning: { effort: 'low' } }, fixed('minimal'))?.value,
    ).toBe('low');
    expect(verifyReasoningWire(model, { reasoning: { effort: 'none' } }, fixed('off'))?.value).toBe(
      'none',
    );
  });
  it('explicit provider default is omitted without mutating the catalog', () => {
    const resolution: ReasoningResolution = {
      requested: { mode: 'provider_default' },
      resolved: null,
      source: 'provider-default',
      preparationId: 'prep',
    };
    const request = reasoningRequest(model, { reasoning: 'high' }, resolution);
    expect(request.options).not.toHaveProperty('reasoning');
    expect(request.model.thinkingLevelMap?.off).toBeNull();
    expect(model.thinkingLevelMap?.off).toBe('none');
    expect(verifyReasoningWire(model, {}, resolution)?.kind).toBe('omitted');
    expect(() => verifyReasoningWire(model, { reasoning: { effort: 'high' } }, resolution)).toThrow(
      'differs',
    );
    expect(() =>
      verifyReasoningWire(model, { reasoning: { effort: 'low' } }, fixed('high')),
    ).toThrow('differs');
    expect(reasoningRequest(model, { reasoning: 'high' }, undefined).options.reasoning).toBe(
      'high',
    );
  });

  it('C20: a routed level is checked like any other and a hook cannot change it', () => {
    const routed: ReasoningResolution = {
      requested: { mode: 'auto' },
      resolved: 'low',
      source: 'router',
      preparationId: 'prep',
    };
    const request = reasoningRequest(model, { reasoning: 'high', maxTokens: 4096 }, routed);
    expect(request.options.reasoning).toBe('low');
    expect(request.options.maxTokens).toBe(4096);
    expect(request.model.id).toBe(model.id);
    const payload = { model: model.id, reasoning: { effort: 'low' } };
    expect(verifyReasoningWire(model, payload, routed, 4096, 'oauth')).toEqual({
      kind: 'effort',
      value: 'low',
    });
    expect(() =>
      verifyReasoningWire(model, { ...payload, reasoning: { effort: 'xhigh' } }, routed, 4096),
    ).toThrow('differs');
    expect(() =>
      verifyReasoningWire(model, { ...payload, model: 'gpt-6.1-terra' }, routed, 4096, 'oauth'),
    ).toThrow('model differs');
    // A fallback to the provider default sends no reasoning field at all.
    const fallback: ReasoningResolution = { ...routed, resolved: null, source: 'fallback' };
    expect(() => verifyReasoningWire(model, payload, fallback)).toThrow('differs');
    expect(verifyReasoningWire(model, {}, fallback)?.kind).toBe('omitted');
  });
});

it('the pinned capability excludes Sol off and detects changed serializer metadata', async () => {
  const { modelReasoningCapabilities, assertReasoningCapabilities } = await import(
    '../src/reasoning.ts'
  );
  const sol = builtinModels().getModel('openai-codex', 'gpt-6.1-sol')!;
  expect(modelReasoningCapabilities(sol).levels).not.toContain('off');
  const capability = modelReasoningCapabilities(model);
  expect(capability.mapping?.minimal).toBe('low');
  expect(() => assertReasoningCapabilities(model, capability)).not.toThrow();
  expect(() =>
    assertReasoningCapabilities(
      { ...model, thinkingLevelMap: { ...model.thinkingLevelMap, high: 'medium' } },
      capability,
    ),
  ).toThrow('changed');
  for (const changed of [
    { ...model, maxTokens: model.maxTokens + 1 },
    { ...model, compat: { ...model.compat, supportsMaxOutputTokens: false } },
  ])
    expect(() => assertReasoningCapabilities(changed, capability)).toThrow('changed');
});

it('the actual Pi serializer agrees on off, provider default and non-reasoning models', async () => {
  const token = `test.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'test-account' } })).toString('base64')}.test`;
  const defaultPolicy: ReasoningResolution = {
    requested: { mode: 'provider_default' },
    resolved: null,
    source: 'provider-default',
    preparationId: 'prep',
  };
  for (const api of ['openai-codex-responses', 'openai-responses'] as const) {
    for (const reasoning of [true, false]) {
      const candidate = { ...model, api, reasoning, thinkingLevelMap: undefined };
      expect(modelReasoningCapabilities(candidate).levels.includes('off')).toBe(reasoning);
      for (const resolution of reasoning ? [fixed('off'), defaultPolicy] : [defaultPolicy]) {
        const request = reasoningRequest(candidate, {}, resolution);
        let captured: unknown;
        const options = {
          ...request.options,
          apiKey: token,
          onPayload: (payload: unknown) => {
            captured = payload;
            throw new Error('serializer-only: do not send');
          },
        };
        const context = normalizeContext({
          messages: [{ role: 'user', content: 'test', timestamp: 0 }],
        });
        const stream =
          api === 'openai-codex-responses'
            ? codexStream({ ...request.model, api }, context, options)
            : responsesStream({ ...request.model, api }, context, options);
        const result = await stream.result();
        expect(result.errorMessage).toContain('serializer-only');
        expect(verifyReasoningWire(candidate, captured, resolution)).toEqual(
          resolution.resolved === null
            ? { kind: 'omitted', value: null }
            : { kind: 'effort', value: 'none' },
        );
      }
    }
  }
});

it('a ChatGPT-account GPT-6.2 request carries its level in the configuration update, and a changed one is refused', async () => {
  const token = `test.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'test-account' } })).toString('base64')}.test`;
  for (const id of ['gpt-6.2-sol', 'gpt-6.2-astra']) {
    const sol = builtinModels().getModel('openai-codex', id)!;
    expect(modelReasoningCapabilities(sol).levels).not.toContain('off');
    const resolution = fixed('high');
    const request = reasoningRequest(sol, { maxTokens: 4096 }, resolution);
    let payload: Record<string, unknown> | undefined;
    const result = await codexStream(
      { ...request.model, api: 'openai-codex-responses' },
      normalizeContext({ messages: [{ role: 'user', content: 'test', timestamp: 0 }] }),
      {
        ...request.options,
        apiKey: token,
        onPayload: (value: unknown) => {
          payload = value as Record<string, unknown>;
          throw new Error('serializer-only: do not send');
        },
      },
    ).result();
    expect(result.errorMessage).toContain('serializer-only');
    expect(verifyReasoningWire(sol, payload, resolution, 4096, 'oauth')).toEqual({
      kind: 'effort',
      value: 'high',
    });
    const changed = structuredClone(payload!);
    (changed.input as { type: string; reasoning?: { effort: string } }[]).findLast(
      (item) => item.type === 'configuration_update',
    )!.reasoning!.effort = 'low';
    expect(() => verifyReasoningWire(sol, changed, resolution, 4096, 'oauth')).toThrow('differs');
    const raised = structuredClone(payload!);
    raised.reasoning = { effort: 'max' };
    expect(() => verifyReasoningWire(sol, raised, resolution, 4096, 'oauth')).toThrow('differs');
    const uncapped = structuredClone(payload!);
    uncapped.max_output_tokens = 4097;
    expect(() => verifyReasoningWire(sol, uncapped, resolution, 4096, 'oauth')).toThrow('output');
  }
});

it('after a turn at one level, a ChatGPT-account request at another level or at the provider default still agrees with its permit', async () => {
  const token = `test.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'test-account' } })).toString('base64')}.test`;
  const sol = builtinModels().getModel('openai-codex', 'gpt-6.2-sol')!;
  const context = normalizeContext({
    messages: [
      { role: 'user', content: 'first', timestamp: 0 },
      {
        ...fauxAssistantMessage('answered'),
        api: sol.api,
        provider: sol.provider,
        model: sol.id,
        providerThinkingLevel: 'high',
      },
      { role: 'user', content: 'second', timestamp: 1 },
    ],
  });
  const fallback: ReasoningResolution = {
    requested: { mode: 'auto' },
    resolved: null,
    source: 'fallback',
    preparationId: 'prep',
  };
  for (const [resolution, wire] of [
    [fixed('low'), { kind: 'effort', value: 'low' }],
    [fallback, { kind: 'omitted', value: null }],
  ] as const) {
    const request = reasoningRequest(sol, {}, resolution);
    let payload: { input?: { type?: string; reasoning?: { effort?: string } }[] } | undefined;
    const result = await codexStream({ ...request.model, api: 'openai-codex-responses' }, context, {
      ...request.options,
      apiKey: token,
      onPayload: (value: unknown) => {
        payload = value as typeof payload;
        throw new Error('serializer-only: do not send');
      },
    }).result();
    expect(result.errorMessage).toContain('serializer-only');
    const updates = payload!.input!.filter((item) => item.type === 'configuration_update');
    // The earlier turn's level is replayed only while this request sends one of its own.
    expect(updates.map((item) => item.reasoning?.effort)).toEqual(
      resolution.resolved === null ? [] : ['high', 'low'],
    );
    expect(verifyReasoningWire(sol, payload, resolution)).toEqual(wire);
  }
});
