import { z } from 'zod';

export const ProfileContextOverrides = z.strictObject({
  contextWindow: z.int().min(1).max(10_000_000).optional(),
  compaction: z
    .strictObject({
      reserveTokens: z.int().min(0).optional(),
      keepRecentTokens: z.int().min(0).optional(),
    })
    .optional(),
});
export type ProfileContextOverrides = z.infer<typeof ProfileContextOverrides>;

export const ContextBaseSource = z.enum(['endpoint', 'catalog', 'fallback']);
export const ContextWarning = z.enum([
  'legacy_inconsistent',
  'reserve_below_output',
  'above_model_limit',
]);
export const ProfileContextPolicy = z.strictObject({
  version: z.literal(1),
  contextWindow: z.int().min(1).max(10_000_000),
  reserveTokens: z.int().min(0),
  keepRecentTokens: z.int().min(0),
  explicit: z.boolean(),
  configRevision: z.string().min(1).max(100),
  baseContextWindow: z.int().min(1).max(10_000_000).nullable(),
  baseSource: ContextBaseSource,
  sources: z.strictObject({
    contextWindow: z.enum(['profile', 'endpoint', 'catalog', 'fallback']),
    reserveTokens: z.enum(['profile', 'pi_default']),
    keepRecentTokens: z.enum(['profile', 'pi_default']),
  }),
  warnings: z.array(ContextWarning).max(3),
});
export type ProfileContextPolicy = z.infer<typeof ProfileContextPolicy>;

export const ProfileContextResolution = z.strictObject({
  policy: ProfileContextPolicy.nullable(),
  errors: z.array(z.string()),
});
export type ProfileContextResolution = z.infer<typeof ProfileContextResolution>;
