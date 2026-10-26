import type { ReasoningResolution } from '@corral/contracts';
import { ModelProviderConfig } from '@corral/core';
import { createModels, hasApi, normalizeContext } from '@earendil-works/pi-ai';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import { expect, it } from 'vitest';
import {
  modelReasoningCapabilities,
  reasoningRequest,
  verifyReasoningWire,
} from '../../../packages/adapter-pi/src/reasoning.ts';
import { providerRequestFence } from '../../../packages/adapter-pi/src/request-fence.ts';
import { endpointsFrom, registerEndpoints } from '../src/models/endpoints.ts';

it('[TC-RSN-001-H] [TC-RSN-001-N] Hive endpoint defaults produce the documented Pi wire and preserve explicit limits', async () => {
  const definition = ModelProviderConfig.parse({
    id: 'hive',
    name: 'Hive',
    baseUrl: 'https://api-cdn.thehive.ai/api/v3/',
    access: 'api_key',
    models: [{ id: 'deepseek-ai/deepseek-v4.1-flash-1017' }],
  });
  const models = createModels();
  registerEndpoints(models, endpointsFrom([definition]));
  const model = models.getModel('hive', definition.models[0]!.id)!;
  if (!hasApi(model, 'openai-completions')) throw new Error('wrong endpoint transport');
  expect(modelReasoningCapabilities(model).levels).toEqual(['off', 'low', 'high', 'max']);
  expect(model).toMatchObject({
    contextWindow: 1_000_000,
    maxTokens: 4096,
    input: ['text', 'image'],
  });
  for (const level of ['off', 'low', 'high', 'max', null] as const) {
    const resolution: ReasoningResolution = {
      requested: level === null ? { mode: 'provider_default' } : { mode: 'fixed', level },
      resolved: level,
      source: level === null ? 'provider_default' : 'fixed',
      preparationId: 'fixture',
    };
    const request = reasoningRequest(model, { maxTokens: 4096 }, resolution);
    if (!hasApi(request.model, 'openai-completions')) throw new Error('wrong request transport');
    let sent = 0;
    const fence = providerRequestFence(model, async (input, init) => {
      sent++;
      expect(String(input)).toBe('https://api-cdn.thehive.ai/api/v3/chat/completions');
      expect(new Headers(init?.headers).get('accept')).toBe('text/event-stream');
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ model: model.id, max_completion_tokens: 4096, stream: true });
      expect(body.reasoning_effort).toBe(level === 'off' ? 'none' : (level ?? undefined));
      for (const omitted of ['thinking', 'max_tokens', 'store', 'stream_options'])
        expect(body).not.toHaveProperty(omitted);
      expect(body.messages[0].role).toBe('system');
      return new Response(
        [
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Fixture' }, finish_reason: 'stop' }] })}`,
          `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })}`,
          'data: [DONE]',
          '',
        ].join('\n\n'),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    })!;
    const result = await streamSimple(
      request.model,
      normalizeContext({
        systemPrompt: 'Fixture system instruction',
        messages: [{ role: 'user', content: 'Fixture only', timestamp: 0 }],
      }),
      {
        ...request.options,
        apiKey: 'fixture-key',
        fetch: fence.fetch,
        maxRetries: 0,
        onPayload: (payload) => {
          verifyReasoningWire(model, payload, resolution, 4096);
          if (level === 'max') {
            expect(() =>
              verifyReasoningWire(
                model,
                { ...(payload as object), reasoning_effort: 'medium' },
                resolution,
                4096,
              ),
            ).toThrow('differs');
            expect(() =>
              verifyReasoningWire(
                model,
                { ...(payload as object), max_completion_tokens: 4097 },
                resolution,
                4096,
              ),
            ).toThrow('output');
          }
          fence.approve(payload);
        },
      },
    ).result();
    expect(result.errorMessage ?? '').toBe('');
    expect(result.usage.output).toBe(2);
    expect(sent).toBe(1);
  }
  const explicit = endpointsFrom([
    {
      ...definition,
      models: [
        {
          ...definition.models[0]!,
          contextWindow: 16000,
          maxOutput: 512,
          reasoning: false,
          imageInput: false,
        },
      ],
    },
  ]).get('hive')!.spec.models[0];
  expect(explicit).toMatchObject({
    contextWindow: 16000,
    maxOutput: 512,
    reasoning: false,
    imageInput: false,
  });
  const other = endpointsFrom([{ ...definition, baseUrl: 'https://example.com/api/v3' }]).get(
    'hive',
  )!.spec.models[0];
  expect(other).toMatchObject({ contextWindow: 32000, reasoning: false });
  const va1 = endpointsFrom([{ ...definition, baseUrl: 'https://api-va1.thehive.ai/api/v3' }]).get(
    'hive',
  )!.spec.models[0];
  expect(va1).toMatchObject({ contextWindow: 1_000_000, reasoning: true });
});
