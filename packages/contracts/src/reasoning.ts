import { z } from 'zod';
import { Identifier } from './ids.ts';

export const ReasoningLevel = z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
export type ReasoningLevel = z.infer<typeof ReasoningLevel>;
export const ReasoningPolicy = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('fixed'), level: ReasoningLevel }),
  z.strictObject({ mode: z.literal('auto') }),
  z.strictObject({ mode: z.literal('provider_default') }),
]);
export type ReasoningPolicy = z.infer<typeof ReasoningPolicy>;
export const ReasoningCapabilities = z.strictObject({
  levels: z.array(ReasoningLevel).max(7),
  providerDefault: z.boolean(),
  api: z.string().max(100).optional(),
  mapping: z.partialRecord(ReasoningLevel, z.string().max(64)).optional(),
  identity: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export type ReasoningCapabilities = z.infer<typeof ReasoningCapabilities>;
export const RoleRunOverride = z
  .strictObject({
    modelProfile: Identifier.optional(),
    reasoning: ReasoningPolicy.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'empty role override');
export const RoleRunOverrides = z.record(Identifier, RoleRunOverride);
export type RoleRunOverrides = z.infer<typeof RoleRunOverrides>;

/**
 * How one request's reasoning was settled (features/effort-routing.md). `off` is an automatic
 * request sent with the provider default because the effort mode is off; `internal-policy` is an
 * automatic compaction request, which keeps medium.
 */
export const ReasoningResolution = z.strictObject({
  requested: ReasoningPolicy,
  resolved: ReasoningLevel.nullable(),
  source: z.enum(['fixed', 'provider_default', 'off', 'internal-policy']),
  preparationId: Identifier,
});
export type ReasoningResolution = z.infer<typeof ReasoningResolution>;
export const ReasoningWire = z.strictObject({
  kind: z.enum(['effort', 'omitted']),
  value: z.string().max(64).nullable(),
});
export type ReasoningWire = z.infer<typeof ReasoningWire>;

/** Decision-only APIs (features/decision-apis.md). */
export const DecisionApiId = z.enum(['jev', 'openai-decisions']);
export type DecisionApiId = z.infer<typeof DecisionApiId>;
