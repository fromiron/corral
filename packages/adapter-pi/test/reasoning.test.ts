import type { ReasoningResolution } from '@corral/contracts';
import { normalizeContext } from '@earendil-works/pi-ai';
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
  it('[TC-RSN-003-H] overrides SDK thinking, keeps max and verifies aliases', () => {
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
  it('[TC-RSN-003-N] explicit provider default is omitted without mutating the catalog', () => {
    const resolution: ReasoningResolution = {
      requested: { mode: 'provider_default' },
      resolved: null,
      source: 'provider_default',
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
});

it('[TC-RSN-001-N] the pinned capability excludes Sol off and detects changed serializer metadata', async () => {
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

it('[TC-RSN-003-N] the actual Pi serializer agrees on off, provider default and non-reasoning models', async () => {
  const token = `test.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'test-account' } })).toString('base64')}.test`;
  const defaultPolicy: ReasoningResolution = {
    requested: { mode: 'provider_default' },
    resolved: null,
    source: 'provider_default',
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
