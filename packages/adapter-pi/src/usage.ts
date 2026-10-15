import type { StopReason, Usage } from '@earendil-works/pi-ai';

// Usage from pi-ai, as Corral records it (C-020, OBS-004). pi-ai already maps each provider's
// fields; its `input` excludes cache reads and writes, so Corral's input is their sum and the
// cached part is a subset of it, never counted twice. Reasoning is a subset of output.
// A request that reported nothing is unknown, not zero. Pi's `cost` is computed from list
// prices, not reported by the provider, and is dropped: subscription use has no known price.

export interface UsageObservation {
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    cachedInputTokens: number | null;
    reasoningTokens: number | null;
  };
  rawUsage: Record<string, unknown> | null;
}

export function normalizeUsage(message: {
  usage: Usage;
  stopReason: StopReason;
}): UsageObservation {
  const { cost: _computedPrice, ...raw } = message.usage;
  const u = message.usage;
  const reported = u.totalTokens > 0 || u.input + u.output + u.cacheRead + u.cacheWrite > 0;
  if (!reported) {
    return {
      usage: {
        inputTokens: null,
        outputTokens: null,
        cachedInputTokens: null,
        reasoningTokens: null,
      },
      rawUsage: raw,
    };
  }
  return {
    usage: {
      inputTokens: u.input + u.cacheRead + u.cacheWrite,
      outputTokens: u.output,
      cachedInputTokens: u.cacheRead,
      reasoningTokens: u.reasoning ?? null,
    },
    rawUsage: raw,
  };
}
