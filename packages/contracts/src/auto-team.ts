import { z } from 'zod';
import { Identifier } from './ids.ts';
import { ReasoningPolicy } from './reasoning.ts';
import { TEAM_PATTERNS } from './team-plan.ts';

// CR-024: a session without a chosen team runs in auto mode. A start model picks one of the
// built-in templates, which have the CR-006 patterns' shapes; tools and limits come from the
// template, never from the model's answer.

export const AUTO_TEMPLATES = TEAM_PATTERNS;
export const AutoTemplate = z.enum(AUTO_TEMPLATES);
export type AutoTemplate = z.infer<typeof AutoTemplate>;
/** Changes whenever a template's roles, tools or wiring change. */
export const AUTO_TEMPLATE_VERSION = 1;

/** The model and reasoning an auto session uses for the choice and for every role. */
export const AutoModelChoice = z.strictObject({
  modelProfile: Identifier,
  reasoning: ReasoningPolicy.optional(),
});
export type AutoModelChoice = z.infer<typeof AutoModelChoice>;

export const AUTO_REASON_MAX = 200;

/** What the start model chose, as recorded with the run; never the model's answer itself. */
export const AutoRoute = z.strictObject({
  template: AutoTemplate,
  templateVersion: z.int().min(1),
  /** model: the start model chose; local: the local rule (no model call); fallback: single. */
  source: z.enum(['model', 'local', 'fallback']),
  fallback: z.enum(['invalid_answer', 'timeout', 'model_error']).optional(),
  reason: z.string().max(AUTO_REASON_MAX),
  modelProfile: Identifier,
  reasoning: ReasoningPolicy.optional(),
  /** Hash of the request text the choice was made for. */
  inputHash: z.string().regex(/^[0-9a-f]{64}$/),
  /** The choice request's usage; null when no model was called or it reported none. */
  usage: z.strictObject({ inputTokens: z.int().min(0), outputTokens: z.int().min(0) }).nullable(),
});
export type AutoRoute = z.infer<typeof AutoRoute>;
