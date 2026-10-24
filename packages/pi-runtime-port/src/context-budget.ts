// Adapted from PI-Desktop 1a812ed, context-budget.ts (LGPL-3.0-only).
// This entrypoint is environment-neutral so core and browser previews share the same formula.
export interface ContextBudgetModel {
  contextWindow?: number;
  maxTokens?: number;
}
export interface ContextBudgetLimits {
  hardLimit: number;
  requestHeadroom: number;
  keepRecentTokens: number;
}
export function automaticCompactionThresholdFor(budget: Pick<ContextBudgetLimits, 'hardLimit'>) {
  return Math.max(1, Math.floor(budget.hardLimit * 0.9));
}
export function contextBudgetLimitsFor(model: ContextBudgetModel): ContextBudgetLimits {
  const contextWindow = Math.max(1, Math.round(model.contextWindow || 32_000));
  const modelOutputBudget = Math.min(
    Math.max(1, Math.round(model.maxTokens || 4096)),
    Math.max(1, Math.floor(contextWindow * 0.25)),
  );
  const reserveFloor = Math.min(16_384, Math.max(1, Math.floor(contextWindow * 0.5)));
  const requestHeadroom = Math.min(
    contextWindow - 1,
    Math.max(reserveFloor, modelOutputBudget, Math.ceil(contextWindow * 0.05)),
  );
  const hardLimit = Math.max(1, contextWindow - requestHeadroom);
  const keepRecentTokens = Math.min(
    Math.max(8_000, Math.min(64_000, Math.floor(hardLimit * 0.2))),
    Math.max(0, Math.min(hardLimit - 1, Math.floor(hardLimit * 0.5))),
  );
  return { hardLimit, requestHeadroom, keepRecentTokens };
}
