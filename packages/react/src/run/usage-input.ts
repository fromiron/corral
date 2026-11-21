import type { RunProjection } from '@corral/core';

// A run's reported input, read the same way by the Overview's usage detail and by Run info ›
// Usage (chat-widgets-contract.md, features/execution-monitor.md): finished calls only, the cached
// share over the calls that reported both figures, and a figure a call did not report counted
// apart, never as zero.

export interface UsageInput {
  tokens: number;
  /** Reported cached input; null when no finished call reported it. */
  cached: number | null;
  /** Cached share of the input of calls that reported both figures. */
  cacheShare: number | null;
  /** Finished calls without a cached-input report; never counted as zero. */
  cacheUnreported: number;
}

export interface ReportedInput {
  /** Reported input of finished calls; null when none reported it. */
  input: UsageInput | null;
  /** Finished calls without input usage; excluded from the known input total. */
  inputUnreported: number;
}

export function reportedInput(projection: Pick<RunProjection, 'modelCalls'>): ReportedInput {
  const finished = Object.values(projection.modelCalls).filter((call) => call.finished);
  let tokens = 0;
  let reported = 0;
  let cached = 0;
  let cachedOf = 0;
  let cacheReported = 0;
  for (const call of finished) {
    const input = call.usage?.inputTokens;
    const cache = call.usage?.cachedInputTokens;
    if (input == null) continue;
    tokens += input;
    reported += 1;
    if (cache == null) continue;
    cached += cache;
    cachedOf += input;
    cacheReported += 1;
  }
  return {
    input: reported
      ? {
          tokens,
          cached: cacheReported ? cached : null,
          cacheShare: cacheReported && cachedOf ? cached / cachedOf : null,
          cacheUnreported: finished.filter((call) => call.usage?.cachedInputTokens == null).length,
        }
      : null,
    inputUnreported: finished.length - reported,
  };
}
