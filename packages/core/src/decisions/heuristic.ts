import type {
  DecisionCancellation,
  DecisionProvider,
  EffortLevel,
  EffortQuestion,
} from '@corral/contracts';
import { EFFORT_LEVELS } from '@corral/contracts';

// `local-heuristic@1`: a documented rule baseline over the request's features. It
// makes no accuracy claim; it exists so judgments can be recorded and compared without a model.
//
//   start at medium
//   a short question or a short delegated part → low
//   a revision after a "revise" review, or ≥ 10,000 input characters / ≥ 3 input versions → high
//   ≥ 30,000 input characters → xhigh
//   delivered instructions or a 4th+ request of the same execution → one level up (max high)

const SHORT = 200;

export class LocalHeuristicProvider implements DecisionProvider {
  readonly id = 'local-heuristic';
  readonly version = '1';
  readonly privacy = 'local' as const;
  readonly timeoutMs = 1_000;
  readonly questions = [{ kind: 'reasoning_effort' as const, version: 1 }];

  available(): true {
    return true;
  }

  async decide(question: EffortQuestion, _cancellation: DecisionCancellation) {
    return {
      answer: level(question),
      probabilities: null,
      evidenceLevel: 'rule' as const,
    };
  }
}

function level({ input }: EffortQuestion): EffortLevel {
  const f = input.features;
  const short = Array.from(input.excerpt).length < SHORT;
  if (f.inputChars >= 30_000) return 'xhigh';
  let at = 1;
  if ((f.assignment === 'question' || f.assignment === 'delegated') && short) at = 0;
  if (
    (f.lastReviewVerdict === 'revise' && (f.round ?? 1) >= 2) ||
    f.inputChars >= 10_000 ||
    f.inputArtifacts >= 3
  )
    at = 2;
  if (f.directives > 0 || f.requestNo >= 4) at = Math.min(2, at + 1);
  return EFFORT_LEVELS[at] ?? 'medium';
}
