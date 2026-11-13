import type { AdviceSeverity } from '@corral/contracts';

// The advisor's gatekeeper (docs/specs/features/advisor.md, "문지기"). Pure: the caller keeps the
// state of one advisor execution and replaces it with the state `admit` returns. Only admitted
// advice changes the state.

/** How many most recently admitted advice keys one advisor execution remembers. */
export const ADVICE_HISTORY_LIMIT = 512;

/** More than this many admitted non-blocker advice in one review are `over_budget`. */
export const ADVICE_REVIEW_BUDGET = 3;

/** Filler phrases, already normalised (see `normalizeAdviceNote`). A note equal to one is noise. */
export const ADVICE_FILLER_PHRASES: readonly string[] = [
  'stop',
  'done',
  'ok',
  'okay',
  'lgtm',
  'looks good',
  'continue',
  'keep going',
  'no issue',
  'no issues',
  'no issue continue',
  'no problem',
  'all good',
  '계속',
  '계속하세요',
  '계속 진행',
  '문제 없음',
  '문제없음',
  '문제 없음 계속',
  '좋아요',
  '좋습니다',
  '확인',
  '이상 없음',
];

export type AdviceGuardOutcome = 'admitted' | 'noise' | 'duplicate' | 'over_budget';

export interface AdviceHistoryEntry {
  readonly key: string;
  /** The highest severity admitted for this key. */
  readonly severity: AdviceSeverity;
}

export interface AdviceGuardState {
  /** Oldest first, at most `ADVICE_HISTORY_LIMIT` entries, one per key. */
  readonly history: readonly AdviceHistoryEntry[];
  /** Admitted non-blocker advice in the current review. */
  readonly reviewCount: number;
}

const FILLER = new Set(ADVICE_FILLER_PHRASES);
const SEVERITY_ORDER: Record<AdviceSeverity, number> = { nit: 0, concern: 1, blocker: 2 };

/** NFKC, lower case, anything but a letter or a digit becomes a space, spaces collapse and trim. */
export function normalizeAdviceNote(note: string): string {
  return note
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function emptyGuard(): AdviceGuardState {
  return { history: [], reviewCount: 0 };
}

/** A new review begins: the per-review count goes back to 0 and the history stays. */
export function beginReview(state: AdviceGuardState): AdviceGuardState {
  return { history: state.history, reviewCount: 0 };
}

export function admit(
  state: AdviceGuardState,
  advice: { readonly severity: AdviceSeverity; readonly note: string },
): { outcome: AdviceGuardOutcome; state: AdviceGuardState } {
  const key = normalizeAdviceNote(advice.note);
  if (key === '' || FILLER.has(key)) return { outcome: 'noise', state };

  const seen = state.history.find((entry) => entry.key === key);
  if (seen && SEVERITY_ORDER[advice.severity] <= SEVERITY_ORDER[seen.severity]) {
    return { outcome: 'duplicate', state };
  }

  const counted = advice.severity !== 'blocker';
  if (counted && state.reviewCount >= ADVICE_REVIEW_BUDGET)
    return { outcome: 'over_budget', state };

  const kept = state.history.filter((entry) => entry.key !== key);
  const history = [...kept, { key, severity: advice.severity }].slice(-ADVICE_HISTORY_LIMIT);
  return {
    outcome: 'admitted',
    state: { history, reviewCount: state.reviewCount + (counted ? 1 : 0) },
  };
}
