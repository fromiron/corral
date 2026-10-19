import { z } from 'zod';
import { Identifier } from './ids.ts';

export const WorkPlanItems = z
  .array(
    z.strictObject({
      id: Identifier,
      title: z.string().trim().min(1).max(500),
      status: z.enum(['pending', 'in_progress', 'completed']),
      requiresVerification: z.boolean().optional(),
      evidenceRefs: z.array(Identifier).max(8).optional(),
    }),
  )
  .min(1)
  .max(20)
  .refine(
    (items) => new Set(items.map((item) => item.id)).size === items.length,
    'plan item IDs must be unique',
  )
  .refine(
    (items) => items.filter((item) => item.status === 'in_progress').length <= 1,
    'only one item may be in progress',
  )
  .refine(
    (items) =>
      items.every(
        (item) =>
          item.status !== 'completed' || !item.requiresVerification || item.evidenceRefs?.length,
      ),
    'verification requires evidence',
  );

export const WorkPlanUpdate = z.strictObject({
  scope: z.enum(['execution', 'team']),
  expectedRevision: z.int().min(0).max(1000),
  criteriaVersionId: Identifier,
  items: WorkPlanItems,
});
export type WorkPlanUpdate = z.infer<typeof WorkPlanUpdate>;
export const WorkPlan = WorkPlanUpdate.omit({ expectedRevision: true }).extend({
  revision: z.int().min(1).max(1000),
  executionId: Identifier,
  attemptNo: z.int().min(1),
});
export type WorkPlan = z.infer<typeof WorkPlan>;
