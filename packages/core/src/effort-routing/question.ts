import {
  EFFORT_LEVELS,
  type EffortLevel,
  type EffortQuestion,
  type ReasoningLevel,
} from '@corral/contracts';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { canonicalJson } from '../canonical-json.ts';

// The one fixed question (features/effort-routing.md#질문과-응답-검증).

export const QUESTION_VERSION = 'effort-question-v1';

const INSTRUCTIONS =
  'Select the reasoning effort for the next model call. Consider the work still required using the provided current state.';
const CRITERIA: Record<EffortLevel, string> = {
  low: 'Apply a known procedure or a specified edit.',
  medium: 'Perform bounded diagnosis or compare a few local alternatives.',
  high: 'Resolve interdependent constraints or multi-step diagnosis.',
  xhigh: 'Design and verify a strategy under deep or conflicting constraints.',
};

/** The levels the model supports, in the fixed weakest-first order. */
export function routingCandidates(levels: readonly ReasoningLevel[]): EffortLevel[] {
  return EFFORT_LEVELS.filter((level) => levels.includes(level));
}

/** The question with the criteria of the candidates only, in their order. */
export function effortQuestion(candidates: readonly EffortLevel[]): EffortQuestion {
  return {
    type: 'choice',
    instructions: INSTRUCTIONS,
    criteria: Object.fromEntries(candidates.map((level) => [level, CRITERIA[level]])),
  };
}

export function sha256Hex(text: string): string {
  return bytesToHex(sha256(utf8ToBytes(text)));
}

export function questionHash(question: EffortQuestion): string {
  return sha256Hex(canonicalJson({ version: QUESTION_VERSION, question }));
}
