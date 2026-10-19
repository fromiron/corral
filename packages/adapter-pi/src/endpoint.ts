import { type ApiKeyAuth, createProvider, type Model, type Provider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { z } from 'zod';

// CR-005: an OpenAI-compatible endpoint (Ollama, LM Studio, OpenRouter) as a pi-ai provider,
// called through pi-ai's openai-completions client. The host and the model worker build the
// same provider from the same non-secret definition; keys never travel in it.

export const EndpointModel = z.strictObject({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(200).optional(),
  contextWindow: z.int().min(1),
  maxOutput: z.int().min(1),
  reasoning: z.boolean(),
  imageInput: z.boolean().optional(),
});

export const EndpointSpec = z.strictObject({
  name: z.string().min(1).max(80),
  baseUrl: z.string().url().max(500),
  /** A local server without keys; only a fixed placeholder is sent as the key. */
  keyless: z.boolean(),
  models: z.array(EndpointModel).min(1).max(50),
});
export type EndpointSpec = z.infer<typeof EndpointSpec>;

/** Defaults when the configuration leaves a model's limits out. */
export const ENDPOINT_DEFAULTS = { contextWindow: 32_000, maxOutput: 4_096 } as const;

function isHiveDeepSeek(baseUrl: string, modelId: string) {
  return (
    modelId === 'deepseek-ai/deepseek-v4.1-flash-1017' &&
    ['https://api-cdn.thehive.ai/api/v3', 'https://api-va1.thehive.ai/api/v3'].includes(
      baseUrl.replace(/\/+$/, ''),
    )
  );
}

/** Published defaults for known endpoint/model pairs; explicit configuration takes priority. */
export function endpointModelDefaults(baseUrl: string, modelId: string) {
  return isHiveDeepSeek(baseUrl, modelId)
    ? { ...ENDPOINT_DEFAULTS, contextWindow: 1_000_000, reasoning: true, imageInput: true }
    : { ...ENDPOINT_DEFAULTS, reasoning: false, imageInput: undefined };
}

/**
 * Sent to a keyless endpoint: OpenAI clients need some key, and local servers such as Ollama
 * ignore it. It is a fixed placeholder, never a stored key.
 */
export const KEYLESS_PLACEHOLDER = 'no-key';

/** The key a request carries (from the host's permit); a keyless endpoint gets the placeholder. */
export function requestKeyAuth(name: string, keyless: boolean): ApiKeyAuth {
  return {
    name,
    resolve: async ({ credential }) => {
      if (keyless) return { auth: { apiKey: KEYLESS_PLACEHOLDER }, source: 'keyless endpoint' };
      return credential?.key ? { auth: { apiKey: credential.key }, source: 'request' } : undefined;
    },
  };
}

export function endpointProvider(
  providerId: string,
  spec: EndpointSpec,
  auth: ApiKeyAuth = requestKeyAuth(`${spec.name} API key`, spec.keyless),
): Provider {
  const models: Model<'openai-completions'>[] = spec.models.map((m) => ({
    id: m.id,
    name: m.name ?? m.id,
    api: 'openai-completions',
    provider: providerId,
    baseUrl: spec.baseUrl,
    reasoning: m.reasoning,
    input: m.imageInput ? ['text', 'image'] : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: m.contextWindow,
    maxTokens: m.maxOutput,
    // Hive exposes OpenAI effort, not the native DeepSeek thinking/max_tokens protocol.
    ...(isHiveDeepSeek(spec.baseUrl, m.id)
      ? {
          headers: { Accept: 'text/event-stream' },
          thinkingLevelMap: {
            off: 'none',
            minimal: null,
            low: 'low',
            medium: null,
            high: 'high',
            xhigh: null,
            max: 'max',
          },
          compat: {
            thinkingFormat: 'openai' as const,
            supportsReasoningEffort: true,
            supportsDeveloperRole: false,
            supportsStore: false,
            supportsUsageInStreaming: false,
            maxTokensField: 'max_completion_tokens' as const,
          },
        }
      : {}),
  }));
  return createProvider({
    id: providerId,
    name: spec.name,
    baseUrl: spec.baseUrl,
    auth: { apiKey: auth },
    models,
    api: openAICompletionsApi(),
  });
}
