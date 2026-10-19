import type { RunLimits } from '@corral/contracts';
import type { BudgetState } from './budget.ts';

/** Keep two capped calls for final verification inside the existing Run allowance. */
export function candidateAllowance(
  state: BudgetState,
  limits: RunLimits,
  phase: 'start' | 'revise' | 'work' | 'finish',
): number {
  const charged = state.spent + state.reserved + state.unknownOutstanding;
  const heldCalls = phase === 'finish' ? 0 : 2;
  const nextCap = limits.maxOutputTokensPerCall;
  if (
    (phase === 'start' || phase === 'revise') &&
    (state.modelCalls + heldCalls + 1 >= limits.maxModelCalls * 0.8 ||
      charged + (heldCalls + 1) * nextCap >= limits.maxOutputTokens * 0.8)
  )
    return 0;
  if (state.modelCalls >= limits.maxModelCalls - heldCalls) return 0;
  return Math.max(
    0,
    Math.min(
      limits.maxOutputTokensPerCall,
      limits.maxOutputTokens - charged - heldCalls * limits.maxOutputTokensPerCall,
    ),
  );
}
