import type { ReasoningResolution } from '@corral/contracts';
import {
  getSupportedThinkingLevels,
  hasApi,
  type Model,
  normalizeContext,
} from '@earendil-works/pi-ai';
import { streamSimple as google } from '@earendil-works/pi-ai/api/google-generative-ai';
import { streamSimple as completions } from '@earendil-works/pi-ai/api/openai-completions';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { describe, expect, it } from 'vitest';
import { type EndpointSpec, endpointProvider } from '../src/endpoint.ts';
import {
  assertReasoningCapabilities,
  modelReasoningCapabilities,
  reasoningRequest,
  verifyReasoningWire,
} from '../src/reasoning.ts';

const resolution = (level: ReasoningResolution['resolved']): ReasoningResolution => ({
  requested: level === null ? { mode: 'provider_default' } : { mode: 'fixed', level },
  resolved: level,
  source: level === null ? 'provider-default' : 'fixed',
  preparationId: 'fixture',
});

/** Pi's serialized body for one request, captured before anything is sent. */
async function payloadOf(
  stream: typeof completions | typeof google,
  model: Model<string>,
  options: Record<string, unknown>,
) {
  let captured: Record<string, unknown> | undefined;
  let network = 0;
  const result = await (stream as typeof completions)(
    model as Model<'openai-completions'>,
    normalizeContext({ messages: [{ role: 'user', content: 'Fixture', timestamp: 0 }] }),
    {
      ...options,
      apiKey: 'fixture-key',
      // Pi's Google client refuses a custom fetch; its payload hook still runs before any send.
      ...(stream === google
        ? {}
        : {
            fetch: async () => {
              network++;
              throw new Error('network forbidden');
            },
          }),
      onPayload: (payload) => {
        captured = payload as Record<string, unknown>;
        throw new Error('captured before send');
      },
    },
  ).result();
  expect(result.errorMessage).toContain('captured before send');
  expect(network).toBe(0);
  return captured!;
}

describe('Pi reasoning levels for built-in providers Corral has not tested', () => {
  it('a Google model offers the levels Pi gives it, and a chosen level reaches Pi as its reasoning option', async () => {
    const model = builtinModels().getModel('google', 'gemini-3.8-flash')!;
    if (!hasApi(model, 'google-generative-ai')) throw new Error('wrong fixture API');
    const capabilities = modelReasoningCapabilities(model);
    expect(capabilities.levels).toEqual(getSupportedThinkingLevels(model));
    expect(capabilities.levels.length).toBeGreaterThan(0);
    expect(capabilities).toMatchObject({ providerDefault: true, api: 'google-generative-ai' });
    // The recorded mapping is Pi's thinkingLevelMap value, else the level name.
    for (const level of capabilities.levels)
      expect(capabilities.mapping?.[level]).toBe(model.thinkingLevelMap?.[level] ?? level);
    expect(capabilities.identity).toMatch(/^[a-f0-9]{64}$/);
    expect(() => assertReasoningCapabilities(model, capabilities)).not.toThrow();

    const chosen = reasoningRequest(model, { maxTokens: 4096 }, resolution('high'));
    expect(chosen.options.reasoning).toBe('high');
    expect(chosen.model).toBe(model);
    const payload = await payloadOf(google, chosen.model, chosen.options);
    expect(payload).toMatchObject({
      model: model.id,
      config: { thinkingConfig: { includeThoughts: true } },
    });
    // Corral does not compare a serializer it has not tested; it records the mapped level.
    expect(verifyReasoningWire(model, payload, resolution('high'), 4096)).toEqual({
      kind: 'effort',
      value: model.thinkingLevelMap?.high ?? 'high',
    });

    // The provider default passes no reasoning option and leaves the catalog model as it is.
    const unset = reasoningRequest(model, { maxTokens: 4096, reasoning: 'low' }, resolution(null));
    expect(unset.options).not.toHaveProperty('reasoning');
    expect(unset.model.thinkingLevelMap).toEqual(model.thinkingLevelMap);
    expect(verifyReasoningWire(model, {}, resolution(null), 4096)).toEqual({
      kind: 'omitted',
      value: null,
    });
  });

  it('a model without reasoning still offers nothing, whatever its API', () => {
    const model = builtinModels()
      .getModels('google')
      .find((candidate) => !candidate.reasoning);
    if (model)
      expect(modelReasoningCapabilities(model)).toEqual({ levels: [], providerDefault: false });
    // An API Pi does not ship (a test double) is not given levels either.
    expect(
      modelReasoningCapabilities({
        ...builtinModels().getModel('google', 'gemini-3.8-flash')!,
        api: 'faux-fixture',
      }),
    ).toEqual({ levels: [], providerDefault: false });
  });
});

describe('reasoning for added OpenAI-compatible endpoints', () => {
  const spec = (baseUrl: string, reasoning: boolean): EndpointSpec => ({
    name: 'Router',
    baseUrl,
    keyless: false,
    models: [{ id: 'vendor/thinker', contextWindow: 64000, maxOutput: 8000, reasoning }],
  });

  for (const baseUrl of ['https://router.example.test/v1', 'https://llm.chutes.ai/v1'])
    it(`offers low, medium and high, sends reasoning_effort, and omits it for the provider default (${new URL(baseUrl).host})`, async () => {
      const model = endpointProvider('router', spec(baseUrl, true)).getModels()[0]!;
      const capabilities = modelReasoningCapabilities(model);
      expect(capabilities.levels).toEqual(['low', 'medium', 'high']);
      expect(capabilities.providerDefault).toBe(true);
      for (const level of ['low', 'medium', 'high', null] as const) {
        const chosen = reasoningRequest(model, { maxTokens: 4096 }, resolution(level));
        const body = await payloadOf(completions, chosen.model, chosen.options);
        if (level === null) expect(body).not.toHaveProperty('reasoning_effort');
        else expect(body.reasoning_effort).toBe(level);
        for (const omitted of ['thinking', 'reasoning', 'enable_thinking'])
          expect(body).not.toHaveProperty(omitted);
        expect(verifyReasoningWire(model, body, resolution(level), 4096)).toEqual(
          level === null ? { kind: 'omitted', value: null } : { kind: 'effort', value: level },
        );
        const changed = { ...body, reasoning_effort: level === 'high' ? 'low' : 'high' };
        expect(() => verifyReasoningWire(model, changed, resolution(level), 4096)).toThrow(
          'differs',
        );
        const capped = Object.fromEntries(
          Object.entries(body).map(([key, value]) =>
            key === 'max_tokens' || key === 'max_completion_tokens' ? [key, 4097] : [key, value],
          ),
        );
        expect(() => verifyReasoningWire(model, capped, resolution(level), 4096)).toThrow('output');
      }
    });

  it('reasoning: false in the definition offers no levels and sends no reasoning field', async () => {
    const model = endpointProvider(
      'router',
      spec('https://router.example.test/v1', false),
    ).getModels()[0]!;
    expect(modelReasoningCapabilities(model)).toEqual({ levels: [], providerDefault: false });
    const body = await payloadOf(completions, model, { maxTokens: 4096 });
    expect(body).not.toHaveProperty('reasoning_effort');
  });

  it('one model is built the same whatever other models the endpoint lists', () => {
    const one = endpointProvider('router', spec('https://router.example.test/v1', true));
    const many = endpointProvider('router', {
      ...spec('https://router.example.test/v1', true),
      models: [
        { id: 'other', contextWindow: 1000, maxOutput: 100, reasoning: false },
        ...spec('https://router.example.test/v1', true).models,
      ],
    });
    const solo = one.getModels()[0]!;
    const listed = many.getModels().find((model) => model.id === solo.id)!;
    expect(modelReasoningCapabilities(listed).identity).toBe(
      modelReasoningCapabilities(solo).identity,
    );
  });
});
