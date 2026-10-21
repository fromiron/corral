import { z } from 'zod';
import { EvalExpectation } from './evaluation.ts';
import { ContentHash, HarnessBindingRef } from './harness.ts';
import { HarnessEntryKey } from './harness-management.ts';
import { Identifier } from './ids.ts';

export const SkillKey = HarnessEntryKey.extend({ kind: z.literal('skill') });
export type SkillKey = z.infer<typeof SkillKey>;
export const SkillEvaluationRequest = z
  .strictObject({
    operationId: Identifier,
    candidate: SkillKey,
    baseline: SkillKey.optional(),
    modelProfile: Identifier,
    mode: z.enum(['mock', 'live']),
    fixtures: z
      .array(
        z.strictObject({
          id: Identifier,
          brief: z.string().min(1).max(20000),
          expected: EvalExpectation,
          shouldActivate: z.boolean(),
          phase: z.enum(['calibration', 'holdout']),
        }),
      )
      .min(2)
      .max(10),
  })
  .refine(
    (input) =>
      new Set(input.fixtures.map((f) => f.id)).size === input.fixtures.length &&
      input.fixtures.some((f) => f.shouldActivate) &&
      input.fixtures.some((f) => !f.shouldActivate) &&
      input.fixtures.some((f) => f.phase === 'holdout'),
    'Use distinct positive and negative fixtures, including holdout.',
  );
export type SkillEvaluationRequest = z.infer<typeof SkillEvaluationRequest>;
export const SkillEvaluationCase = z.strictObject({
  runId: Identifier,
  variant: z.enum(['baseline', 'candidate']),
  fixtureId: Identifier,
  phase: z.enum(['calibration', 'holdout']),
  status: z.string(),
  correct: z.boolean().nullable(),
  activationPassed: z.boolean().nullable(),
  output: z.string().max(4096).nullable(),
  outputTruncated: z.boolean(),
  definitionHash: ContentHash.nullable(),
  harnessHashes: z.array(ContentHash),
  modelHashes: z.array(ContentHash),
  modelCalls: z.int().min(0),
  outputTokens: z.number().min(0),
  unknownTokens: z.number().min(0),
});
export const SkillEvaluationView = z.strictObject({
  id: Identifier,
  requestHash: ContentHash,
  fixtureHash: ContentHash,
  request: SkillEvaluationRequest,
  status: z.enum(['running', 'completed', 'cancelled', 'failed', 'interrupted']),
  createdAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
  runIds: z.array(Identifier),
  results: z.array(SkillEvaluationCase),
});
export type SkillEvaluationView = z.infer<typeof SkillEvaluationView>;
export const SkillAdoptionTarget = z
  .strictObject({
    scope: z.enum(['personal', 'project']),
    scopeId: Identifier,
    expectedRevision: z.int().min(0),
    binding: HarnessBindingRef,
  })
  .refine((target) => target.scope !== 'personal' || target.scopeId === 'default');
export const SkillAdoptRequest = z.strictObject({
  operationId: Identifier,
  evaluationId: Identifier,
  reviewed: z.literal(true),
  target: SkillAdoptionTarget,
});
export type SkillAdoptRequest = z.infer<typeof SkillAdoptRequest>;
export const SkillAdoption = z.strictObject({
  kind: z.literal('skill_adoption'),
  id: Identifier,
  evaluationId: Identifier,
  target: SkillAdoptionTarget,
  binding: HarnessBindingRef,
  defaultRevision: z.int().min(1),
});
export type SkillAdoption = z.infer<typeof SkillAdoption>;
export const SkillRollbackRequest = z.strictObject({
  operationId: Identifier,
  adoptionId: Identifier,
  expectedRevision: z.int().min(1),
});
export type SkillRollbackRequest = z.infer<typeof SkillRollbackRequest>;
export interface SkillUpdatePreview {
  candidate: z.infer<typeof SkillKey>;
  baseline: z.infer<typeof SkillKey> | null;
  sourceChanged: boolean;
  licenseChanged: boolean;
  changes: {
    path: string;
    change: 'added' | 'removed' | 'changed';
    category: 'license' | 'reference' | 'script' | 'permissions' | 'source';
  }[];
}
export interface SkillFileComparison {
  path: string;
  before: { hash: string; bytes: number; text: string | null } | null;
  after: { hash: string; bytes: number; text: string | null } | null;
}
