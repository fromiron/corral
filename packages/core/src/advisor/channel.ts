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

/** The longest advisor name an advice heading carries, in UTF-16 units. */
export const ADVISOR_NAME_MAX_LENGTH = 80;

/**
 * The advisor's name as its advice's heading names it: one plain line without the characters a
 * directive heading is written with, so the name cannot close the heading or open another.
 */
export function adviceSender(name: string): string {
  const plain = name
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/[()[\]{}<>:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Whole code points only: a cut never leaves half a surrogate pair.
  let short = '';
  for (const char of plain) {
    if (short.length + char.length > ADVISOR_NAME_MAX_LENGTH) break;
    short += char;
  }
  return short.trim() || 'advisor';
}

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
