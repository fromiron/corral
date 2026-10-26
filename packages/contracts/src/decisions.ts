import { z } from 'zod';
import { Identifier } from './ids.ts';

// DecisionProvider contract, first question kind `reasoning_effort` v1.
// Observe only: an answer is recorded and never changes a request.

/** Abstract effort levels, weakest first. Model-specific levels belong to a later apply CR. */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh'] as const;
export const EffortLevel = z.enum(EFFORT_LEVELS);
export type EffortLevel = z.infer<typeof EffortLevel>;

export const DecisionQuestionKind = z.enum(['reasoning_effort']);
export type DecisionQuestionKind = z.infer<typeof DecisionQuestionKind>;

export const DecisionPrivacy = z.enum(['local', 'external']);
export type DecisionPrivacy = z.infer<typeof DecisionPrivacy>;

export const EvidenceLevel = z.enum(['model_probability', 'rule', 'none']);
export type EvidenceLevel = z.infer<typeof EvidenceLevel>;

const Probability = z.number().min(0).max(1);

/** What a provider must answer. Anything else is `invalid_response`, never repaired. */
export const DecisionAnswer = z
  .strictObject({
    answer: EffortLevel,
    probabilities: z
      .strictObject({
        low: Probability,
        medium: Probability,
        high: Probability,
        xhigh: Probability,
      })
      .nullable(),
    evidenceLevel: EvidenceLevel,
  })
  .refine(
    (a) =>
      a.probabilities === null ||
      Math.abs(Object.values(a.probabilities).reduce((s, p) => s + p, 0) - 1) <= 0.01,
    { message: 'probabilities must add up to 1' },
  );
export type DecisionAnswer = z.infer<typeof DecisionAnswer>;

/** Features of a request that carry no body text (D4: events never hold the excerpt). */
export const EffortFeatures = z.strictObject({
  outputContract: z.string().min(1),
  assignment: z.enum(['scheduled', 'delegated', 'question']),
  round: z.int().min(1).nullable(),
  lastReviewVerdict: z.enum(['pass', 'revise', 'inconclusive']).nullable(),
  inputArtifacts: z.int().min(0),
  inputChars: z.int().min(0),
  directives: z.int().min(0),
  requestNo: z.int().min(1),
  recentTools: z.array(z.string().min(1)).max(10),
});
export type EffortFeatures = z.infer<typeof EffortFeatures>;

export const DecisionMode = z.enum(['off', 'observe']);
export type DecisionMode = z.infer<typeof DecisionMode>;

/** One provider as fixed at run start (`run.started.decisions`). */
export const DecisionProviderSnapshot = z.strictObject({
  id: Identifier,
  version: z.string().min(1),
  privacy: DecisionPrivacy,
  /** False when it is not installed, does not declare the question, or is refused here. */
  available: z.boolean(),
  reason: z.string().min(1).nullable(),
});
export type DecisionProviderSnapshot = z.infer<typeof DecisionProviderSnapshot>;

export const RunDecisionSettings = z.strictObject({
  reasoning_effort: z.strictObject({
    mode: DecisionMode,
    providers: z.array(DecisionProviderSnapshot).max(2),
    maxCalls: z.int().min(0).max(100),
  }),
});
export type RunDecisionSettings = z.infer<typeof RunDecisionSettings>;

export const DecisionFailureReason = z.enum([
  'timeout',
  'invalid_response',
  'provider_error',
  'unavailable',
  'cancelled',
]);
export type DecisionFailureReason = z.infer<typeof DecisionFailureReason>;

/** The request a judgment is about. */
export const DecisionSubject = z.strictObject({
  executionId: Identifier,
  attemptNo: z.int().min(1),
  modelCallId: Identifier,
  contextSnapshotId: Identifier,
});
export type DecisionSubject = z.infer<typeof DecisionSubject>;
