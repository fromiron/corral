import { z } from 'zod';
import { HarnessBindingRef } from './harness.ts';
import { Identifier } from './ids.ts';
import { ReasoningLevel, ReasoningPolicy } from './reasoning.ts';
import { TEAM_PATTERNS } from './team-plan.ts';

// CR-024: a session without a chosen team runs in auto mode. A start model picks one of the
// built-in templates, which have the CR-006 patterns' shapes; tools and limits come from the
// template, never from the model's answer.

export const QualityPreset = z.enum(['default', 'ultra']);
export type QualityPreset = z.infer<typeof QualityPreset>;

const UltraPool = z.array(Identifier).min(2).max(5);
const CandidateModels = z.strictObject({ modelProfiles: z.array(Identifier).min(2).max(5) });
const UltraSelectionV1 = z.strictObject({
  version: z.literal(1),
  modelProfiles: UltraPool,
  verifierProfile: Identifier,
  comparison: CandidateModels.optional(),
});
/**
 * CR-048: a candidate tournament with no Corral usage limits. Candidates default to one per
 * pool model, the verifier judges, the winner is refined and applied unless `autoApply` is false.
 */
const UltraSelectionV2 = z.strictObject({
  version: z.literal(2),
  modelProfiles: UltraPool,
  verifierProfile: Identifier,
  candidates: z.array(Identifier).min(2).max(5).optional(),
  refinementRounds: z.int().min(0).max(3).optional(),
  autoApply: z.boolean().optional(),
});
const candidatesInPool = (selection: {
  modelProfiles: string[];
  comparison?: { modelProfiles: string[] };
  candidates?: string[];
}) =>
  [...(selection.comparison?.modelProfiles ?? []), ...(selection.candidates ?? [])].every(
    (profile) => selection.modelProfiles.includes(profile),
  );
export const UltraSelection = z
  .discriminatedUnion('version', [UltraSelectionV1, UltraSelectionV2])
  .refine(candidatesInPool, 'Candidate models must belong to the selected Ultra pool');
export type UltraSelection = z.infer<typeof UltraSelection>;

/**
 * Why a version 2 request runs as collaboration instead of a tournament (CR-048 §1). Missing
 * registered checks or a non-strict harness are refused before start, as C-114/C-118 do.
 */
export const UltraFallbackReason = z.enum(['no_working_copy', 'no_isolation']);
export type UltraFallbackReason = z.infer<typeof UltraFallbackReason>;

/** Requested pool plus the highest verified control for each model, fixed before execution. */
export const UltraTeamSnapshot = z.discriminatedUnion('version', [
  UltraSelectionV1.safeExtend({ reasoning: z.record(Identifier, ReasoningLevel) }),
  z.strictObject({
    version: z.literal(2),
    modelProfiles: UltraPool,
    verifierProfile: Identifier,
    reasoning: z.record(Identifier, ReasoningLevel),
    candidates: z.array(Identifier).min(2).max(5),
    refinementRounds: z.int().min(0).max(3),
    autoApply: z.boolean(),
    mode: z.enum(['competition', 'collaboration']),
    /** Present only in competition: the existing candidate paths key off it. */
    comparison: CandidateModels.optional(),
    fallbackReason: UltraFallbackReason.optional(),
  }),
]);
export type UltraTeamSnapshot = z.infer<typeof UltraTeamSnapshot>;

export const AUTO_TEMPLATES = TEAM_PATTERNS;
export const AutoTemplate = z.enum(AUTO_TEMPLATES);
export type AutoTemplate = z.infer<typeof AutoTemplate>;
/** Changes whenever a template's roles, tools or wiring change. */
export const AUTO_TEMPLATE_VERSION = 3;

/** Levels the start model may pick from when it chooses the reasoning (CR-024 §7). */
export const AUTO_ROUTE_LEVELS = ['low', 'medium', 'high'] as const;
export const AutoRouteLevel = z.enum(AUTO_ROUTE_LEVELS);
export type AutoRouteLevel = z.infer<typeof AutoRouteLevel>;

/**
 * An auto session's reasoning: a CR-021 policy for every role, or `route`, where the start
 * model picks a level with the template. Roles always receive a CR-021 policy.
 */
export const AutoReasoning = z.union([
  ReasoningPolicy,
  z.strictObject({ mode: z.literal('route') }),
]);
export type AutoReasoning = z.infer<typeof AutoReasoning>;

/** The model and reasoning an auto session uses for the choice and for every role. */
export const AutoModelChoice = z.strictObject({
  modelProfile: Identifier,
  reasoning: AutoReasoning.optional(),
});
export type AutoModelChoice = z.infer<typeof AutoModelChoice>;

export const AUTO_REASON_MAX = 200;

/** What the start model chose, as recorded with the run; never the model's answer itself. */
export const AutoRoute = z.strictObject({
  /** Explicitly selected work style; omitted for legacy Auto definitions. */
  harness: HarnessBindingRef.optional(),
  qualityPreset: QualityPreset.optional(),
  ultra: UltraTeamSnapshot.optional(),
  template: AutoTemplate,
  templateVersion: z.int().min(1),
  /** model: the start model chose; local: the local rule (no model call); fallback: single. */
  source: z.enum(['model', 'local', 'fallback']),
  fallback: z.enum(['invalid_answer', 'timeout', 'model_error', 'output_limit']).optional(),
  reason: z.string().max(AUTO_REASON_MAX),
  modelProfile: Identifier,
  /** The reasoning the session asked for. */
  reasoning: AutoReasoning.optional(),
  /** With `route`: the level every role ran with, and who picked it. */
  reasoningChoice: z
    .strictObject({ level: AutoRouteLevel, source: z.enum(['model', 'local', 'fallback']) })
    .optional(),
  /** Hash of the request text the choice was made for. */
  inputHash: z.string().regex(/^[0-9a-f]{64}$/),
  /** Original auto command identity, independent of the generated template or worktree. */
  requestHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  /** The choice request's usage; null when no model was called or it reported none. */
  usage: z.strictObject({ inputTokens: z.int().min(0), outputTokens: z.int().min(0) }).nullable(),
});
export type AutoRoute = z.infer<typeof AutoRoute>;
