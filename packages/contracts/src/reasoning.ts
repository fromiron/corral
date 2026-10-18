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
export const RoleRunOverrides = z
  .record(Identifier, RoleRunOverride)
  .refine((value) => Object.keys(value).length <= 32);
export type RoleRunOverrides = z.infer<typeof RoleRunOverrides>;

/** Private IPC only. Never store the input in public events. */
export const ReasoningInput = z.strictObject({
  kind: z.enum(['turn', 'step', 'compaction']),
  request: z.string().max(24000),
  prevRequest: z.string().max(1200),
  prev: z.string().max(2000),
  step: z.int().min(0).max(10000),
  plan: z.string().max(600),
  calls: z
    .array(
      z.strictObject({
        name: z.string().max(128),
        args: z.string().max(320),
        result: z.string().max(6006),
      }),
    )
    .max(3),
  directiveIds: z.array(Identifier).max(256),
});
export type ReasoningInput = z.infer<typeof ReasoningInput>;
export const ReasoningResolution = z.strictObject({
  requested: ReasoningPolicy,
  resolved: ReasoningLevel.nullable(),
  source: z.enum(['fixed', 'provider_default', 'local-model', 'fallback', 'compaction']),
  preparationId: Identifier,
  inputHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  kind: z.enum(['turn', 'step', 'compaction']).optional(),
  judgeVersion: z.string().max(200).optional(),
  judged: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
  ladder: z
    .array(z.enum(['low', 'medium', 'high', 'xhigh']))
    .max(4)
    .optional(),
  policyVersion: z.literal('mixdog-relative-v1').optional(),
  fallback: z
    .enum([
      'unavailable',
      'timeout',
      'provider_error',
      'invalid_response',
      'limit',
      'missing_input',
    ])
    .optional(),
});
export type ReasoningResolution = z.infer<typeof ReasoningResolution>;
export const ReasoningWire = z.strictObject({
  kind: z.enum(['effort', 'omitted']),
  value: z.string().max(64).nullable(),
});
export type ReasoningWire = z.infer<typeof ReasoningWire>;

export const ReasoningApplySettings = z.strictObject({
  enabled: z.boolean(),
  maxCalls: z.int().min(0).max(100),
  provider: z.literal('local-model'),
  version: z.string().max(200).nullable(),
});
export type ReasoningApplySettings = z.infer<typeof ReasoningApplySettings>;
