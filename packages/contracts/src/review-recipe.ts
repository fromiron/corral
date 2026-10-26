import { z } from 'zod';
import { ContentHash, ResourcePath } from './harness.ts';
import { Identifier } from './ids.ts';

/** Immutable inside a saved Corral revision and the Run snapshot. */
export const ReviewRecipeRevision = z.strictObject({
  recipeId: Identifier,
  revision: z.int().min(1),
  criteriaHash: ContentHash,
  candidateNodeId: Identifier,
  preparationNodeId: Identifier.optional(),
  evaluatorRoleId: Identifier,
  checkIds: z
    .array(Identifier)
    .max(64)
    .refine((ids) => new Set(ids).size === ids.length, 'duplicate check'),
  criteriaFiles: z
    .array(z.strictObject({ path: ResourcePath, sha256: ContentHash }))
    .max(20)
    .refine(
      (files) => new Set(files.map((file) => file.path)).size === files.length,
      'duplicate criteria file',
    ),
  maxAttempts: z.int().min(1).max(10),
  maxRepairs: z.int().min(0).max(9),
  maxWallMs: z.int().min(1000).max(3600000),
  maxModelCalls: z.int().min(1).max(100),
  maxOutputTokens: z.int().min(1).max(256000),
});
export type ReviewRecipeRevision = z.infer<typeof ReviewRecipeRevision>;
export const RecipeStopReason = z.enum([
  'attempt_limit',
  'repair_limit',
  'repeated_output',
  'repeated_failure',
  'call_limit',
  'token_limit',
  'deadline',
  'criteria_changed',
  'check_error',
  'check_stale',
  'review_invalid',
  'invalid_submission',
]);
export type RecipeStopReason = z.infer<typeof RecipeStopReason>;
