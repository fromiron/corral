import { z } from 'zod';
import { Identifier } from './ids.ts';
import { ReasoningPolicy } from './reasoning.ts';
import { TEAM_PATTERNS } from './team-plan.ts';

// CR-024: a session without a chosen team runs in auto mode. A start model picks one of the
// built-in templates, which have the CR-006 patterns' shapes; tools and limits come from the
// template, never from the model's answer.

export const QualityPreset = z.enum(['default', 'ultra']);
export type QualityPreset = z.infer<typeof QualityPreset>;

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
  qualityPreset: QualityPreset.optional(),
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
