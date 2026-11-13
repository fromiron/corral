import type { AdviceSeverity } from '@corral/contracts';

// How an admitted piece of advice reaches its target (docs/specs/features/advisor.md, "조언").
// Pure. A target that waits for a person is simply not interruptible; the directive is read after
// the decision by the general directive rule, so it is not a case here.

export interface AdviceTarget {
  /** The target execution has ended. */
  readonly terminal: boolean;
  /** The target can have its running response cut for an interrupting directive. */
  readonly interruptible: boolean;
}

export type AdviceDelivery = 'next_request' | 'interrupt' | 'preserve';

export type AdviceChannel = { delivery: AdviceDelivery } | { suppressed: 'target_terminal' };

export function resolveDelivery(input: {
  readonly severity: AdviceSeverity;
  readonly target: AdviceTarget;
}): AdviceChannel {
  const { severity, target } = input;
  if (target.terminal) {
    return severity === 'nit' ? { suppressed: 'target_terminal' } : { delivery: 'preserve' };
  }
  if (severity === 'blocker' && target.interruptible) return { delivery: 'interrupt' };
  return { delivery: 'next_request' };
}
