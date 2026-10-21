import type { ReasoningResolution } from '@corral/contracts';
import {
  getSupportedThinkingLevels,
  hasApi,
  type Model,
  normalizeContext,
} from '@earendil-works/pi-ai';
import { streamSimple as anthropic } from '@earendil-works/pi-ai/api/anthropic-messages';
import { streamSimple as google } from '@earendil-works/pi-ai/api/google-generative-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { expect, it } from 'vitest';
import {
  modelReasoningCapabilities,
  reasoningRequest,
  verifyReasoningWire,
} from '../src/reasoning.ts';
import { providerRequestFence } from '../src/request-fence.ts';

type AnthropicPayload = Record<string, unknown> & {
  messages?: { output_config?: { effort: string } }[];
  output_config?: { effort: string };
};

it.each(['claude-sonnet-4-6', 'claude-opus-5-5'])(
  '[TC-ULTRA-003-H] [TC-ULTRA-003-N] Anthropic %s maximum survives real API-key and OAuth serializers and exactly one HTTP dispatch',
  async (id) => {
    const model = builtinModels().getModel('anthropic', id)!;
    if (!hasApi(model, 'anthropic-messages')) throw new Error('wrong fixture API');
    const level = getSupportedThinkingLevels(model).at(-1)!;
    for (const auth of ['api_key', 'oauth'] as const) {
      const resolution: ReasoningResolution = {
        requested: { mode: 'fixed', level },
        resolved: level,
        source: 'fixed',
        preparationId: 'fixture',
      };
      const request = reasoningRequest(model, { maxTokens: 4096 }, resolution);
      let payload: AnthropicPayload = {};
      const sent: { url: string; body: unknown; betas: string | null }[] = [];
      const fetcher: typeof fetch = async (input, init) => {
        const http = new Request(input, init);
        sent.push({
          url: http.url,
          body: await http.json(),
          betas: http.headers.get('anthropic-beta'),
        });
        return new Response(
          JSON.stringify({
            type: 'error',
            error: { type: 'rate_limit_error', message: 'fixture' },
          }),
          { status: 429, headers: { 'content-type': 'application/json' } },
        );
      };
      const fence = providerRequestFence(model, fetcher);
      const result = await anthropic(
        request.model as Model<'anthropic-messages'>,
        normalizeContext({ messages: [{ role: 'user', content: 'Fixture', timestamp: 0 }] }),
        {
          ...request.options,
          apiKey: auth === 'oauth' ? 'sk-ant-oat-fixture' : 'sk-ant-fixture',
          maxRetries: 0,
          fetch: fence?.fetch ?? fetcher,
          onPayload: (raw) => {
            payload = raw as AnthropicPayload;
            if (fence) {
              verifyReasoningWire(model, raw, resolution, 4096, auth);
              fence.approve(raw);
            }
          },
        },
      ).result();
      expect(modelReasoningCapabilities(model).levels).toContain(level);
      expect(fence).toBeDefined();
      expect(sent, result.errorMessage).toHaveLength(1);
      expect(sent[0]?.body).toMatchObject({
        model: model.id,
        max_tokens: 4096,
        thinking: { type: 'adaptive' },
      });
      expect(verifyReasoningWire(model, payload, resolution, 4096, auth)).toEqual({
        kind: 'effort',
        value: 'max',
      });
      const tamperedHeaders = providerRequestFence(model, fetcher)!;
      tamperedHeaders.approve(payload);
      await expect(
        tamperedHeaders.fetch(sent[0]!.url, {
          method: 'POST',
          body: JSON.stringify(sent[0]!.body),
          headers: { 'anthropic-beta': 'unapproved-fixture' },
        }),
      ).rejects.toThrow('metadata');
      expect(sent).toHaveLength(1);
      const changed = structuredClone(payload);
      if (model.compat?.supportsMidConvoEffort)
        changed.messages!.at(-1)!.output_config!.effort = 'low';
      else changed.output_config!.effort = 'low';
      expect(() => verifyReasoningWire(model, changed, resolution, 4096, auth)).toThrow('differs');
      expect(() =>
        verifyReasoningWire(model, { ...payload, max_tokens: 4097 }, resolution, 4096, auth),
      ).toThrow('output');
      await expect(
        fence!.fetch(sent[0]!.url, { method: 'POST', body: JSON.stringify(sent[0]!.body) }),
      ).rejects.toThrow('permit');
    }
  },
);

it('[TC-ULTRA-003-N] Gemini remains unavailable to Ultra while Pi 1.3.0 refuses a per-request HTTP fence', async () => {
  const model = builtinModels().getModel('google', 'gemini-3.8-flash')!;
  if (!hasApi(model, 'google-generative-ai')) throw new Error('wrong fixture API');
  let requests = 0;
  const result = await google(
    model,
    normalizeContext({ messages: [{ role: 'user', content: 'Fixture', timestamp: 0 }] }),
    {
      apiKey: 'fixture',
      fetch: async () => {
        requests++;
        throw new Error('network forbidden');
      },
    },
  ).result();
  expect(result.errorMessage).toContain('Custom fetch is not supported');
  expect(requests).toBe(0);
  expect(modelReasoningCapabilities(model)).toEqual({ levels: [], providerDefault: false });
});

it.each(['claude-sonnet-4-6', 'claude-opus-5-5'])(
  '[TC-ULTRA-003-N] Anthropic %s keeps provider-default and every advertised manual effort compatible',
  async (id) => {
    const model = builtinModels().getModel('anthropic', id)!;
    if (!hasApi(model, 'anthropic-messages')) throw new Error('wrong fixture API');
    for (const level of [null, ...getSupportedThinkingLevels(model)]) {
      const resolution: ReasoningResolution = {
        requested: level === null ? { mode: 'provider_default' } : { mode: 'fixed', level },
        resolved: level,
        source: level === null ? 'provider_default' : 'fixed',
        preparationId: 'fixture',
      };
      const request = reasoningRequest(model, { maxTokens: 4096 }, resolution);
      let payload: unknown;
      const result = await anthropic(
        request.model as Model<'anthropic-messages'>,
        normalizeContext({ messages: [{ role: 'user', content: 'Fixture', timestamp: 0 }] }),
        {
          ...request.options,
          apiKey: 'sk-ant-fixture',
          onPayload: (raw) => {
            payload = raw;
            throw new Error('captured before dispatch');
          },
        },
      ).result();
      expect(result.errorMessage).toContain('captured before dispatch');
      expect(
        () => verifyReasoningWire(model, payload, resolution, 4096),
        JSON.stringify({ id, level, payload }),
      ).not.toThrow();
    }
  },
);
