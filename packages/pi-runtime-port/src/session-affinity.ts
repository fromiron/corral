// Adapted from PI-Desktop 1a812ed, session-affinity.ts (LGPL-3.0-only).
import type { SimpleStreamOptions } from '@earendil-works/pi-ai';
import { clampOpenAIPromptCacheKey } from '@earendil-works/pi-ai/api/openai-prompt-cache';

/** Corral enables custom wire fields only through the endpoint's explicit capability. */
export function withSessionAffinityOptions(
  options: SimpleStreamOptions,
  api: string,
  capability?: 'headers' | 'headers-and-body',
): SimpleStreamOptions {
  const sessionId = options.sessionId?.trim();
  if (!capability || !sessionId || options.cacheRetention === 'none') return options;
  const headers = { ...options.headers };
  for (const key of Object.keys(headers))
    if (key.toLowerCase() === 'x-session-affinity') delete headers[key];
  return {
    ...options,
    headers: { ...headers, 'x-session-affinity': sessionId },
    ...(capability === 'headers-and-body' && api === 'openai-completions'
      ? {
          onPayload: async (
            payload: unknown,
            model: Parameters<NonNullable<SimpleStreamOptions['onPayload']>>[1],
          ) => {
            const body = payload as Record<string, unknown>;
            const keyed =
              body &&
              typeof body === 'object' &&
              !Array.isArray(body) &&
              body.prompt_cache_key == null
                ? { ...body, prompt_cache_key: clampOpenAIPromptCacheKey(sessionId) }
                : payload;
            return (await options.onPayload?.(keyed, model)) ?? keyed;
          },
        }
      : {}),
  };
}
