import type {
  EffortLevel,
  EffortProbabilities,
  RouterResponse,
  RoutingFallbackReason,
} from '@corral/contracts';

// Response checks (features/effort-routing.md#질문과-응답-검증): form, identity and capability
// only. Nothing is calibrated, raised or lowered.

export type Verdict =
  | {
      ok: true;
      effort: EffortLevel;
      probabilities: EffortProbabilities | null;
      meaning: 'choice-distribution' | 'not-provided';
    }
  | {
      ok: false;
      reason: Extract<RoutingFallbackReason, 'invalid-response' | 'token-count-mismatch'>;
    };

const invalid = { ok: false, reason: 'invalid-response' } as const;

/** Every candidate present, each a finite 0–1, summing to 1±0.001; normalized. */
function distribution(
  given: Record<string, number>,
  candidates: readonly EffortLevel[],
): number[] | null {
  if (Object.keys(given).some((key) => !candidates.some((level) => level === key))) return null;
  const values = candidates.map((level) => given[level]);
  if (values.some((v) => typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1))
    return null;
  const numbers = values as number[];
  const sum = numbers.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > 0.001) return null;
  return numbers.map((v) => v / sum);
}

export function judge(
  response: RouterResponse,
  candidates: readonly EffortLevel[],
  engine: 'local' | 'api',
  expectedInputUnits: number,
): Verdict {
  const choice = candidates.find((level) => level === response.choice);
  if (!choice) return invalid;
  if (engine === 'local' && response.inputTokens !== expectedInputUnits)
    return { ok: false, reason: 'token-count-mismatch' };
  const given = response.probabilities;
  if (!given) {
    // A decision API may answer with the choice only; that is recorded, never made one-hot.
    return engine === 'api'
      ? { ok: true, effort: choice, probabilities: null, meaning: 'not-provided' }
      : invalid;
  }
  const numbers = distribution(given, candidates);
  if (!numbers) return invalid;
  if (engine === 'local') {
    const top = Math.max(...numbers);
    if (numbers.filter((v) => v === top).length !== 1) return invalid;
    if (numbers[candidates.indexOf(choice)] !== top) return invalid;
  }
  return {
    ok: true,
    effort: choice,
    probabilities: Object.fromEntries(candidates.map((level, i) => [level, numbers[i]!])),
    meaning: 'choice-distribution',
  };
}
