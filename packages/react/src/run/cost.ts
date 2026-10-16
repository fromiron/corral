import type { RunProjection } from '@corral/core';

// Roadmap 15: what a run cost at list prices. Only API-key calls are priced: a subscription
// sign-in has no per-request price, simulated agents cost nothing, and a call without token
// counts or without a known price is counted as unknown, never as zero.

/** USD per million tokens, as pi-ai's catalog lists them. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export type ModelPrices = (provider: string, modelId: string) => ModelPrice | null;

export interface RunCostEstimate {
  usd: number;
  pricedCalls: number;
  unknownCalls: number;
  subscriptionCalls: number;
  simulated: boolean;
}

const MILLION = 1_000_000;

export function estimateRunCost(projection: RunProjection, prices: ModelPrices): RunCostEstimate {
  const estimate: RunCostEstimate = {
    usd: 0,
    pricedCalls: 0,
    unknownCalls: 0,
    subscriptionCalls: 0,
    simulated: false,
  };
  for (const call of Object.values(projection.modelCalls)) {
    const model = projection.modelProfiles?.[call.profile];
    if (!model || model.auth === 'mock' || !model.provider || !model.modelId) {
      estimate.simulated = true;
      continue;
    }
    if (model.auth === 'oauth') {
      estimate.subscriptionCalls += 1;
      continue;
    }
    const price = prices(model.provider, model.modelId);
    const usd = price ? callCost(call.rawUsage, call.usage, price) : null;
    if (usd === null) estimate.unknownCalls += 1;
    else {
      estimate.usd += usd;
      estimate.pricedCalls += 1;
    }
  }
  return estimate;
}

function callCost(
  raw: Record<string, unknown> | null,
  usage: RunProjection['modelCalls'][string]['usage'],
  price: ModelPrice,
): number | null {
  const n = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;
  // pi-ai's own counts first: its input excludes cache reads and writes.
  const input = n(raw?.input);
  const output = n(raw?.output);
  if (input !== null && output !== null) {
    return (
      (input * price.input +
        output * price.output +
        (n(raw?.cacheRead) ?? 0) * price.cacheRead +
        (n(raw?.cacheWrite) ?? 0) * price.cacheWrite) /
      MILLION
    );
  }
  if (usage?.inputTokens == null || usage.outputTokens == null) return null;
  // Normalized counts: cached input is a subset of input.
  const cached = usage.cachedInputTokens ?? 0;
  return (
    ((usage.inputTokens - cached) * price.input +
      cached * price.cacheRead +
      usage.outputTokens * price.output) /
    MILLION
  );
}
