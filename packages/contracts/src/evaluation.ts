import { z } from 'zod';
import { Identifier, SchemaVersion } from './ids.ts';

export const EvalExpectation = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('exact'), text: z.string().max(65536) }),
  z.strictObject({
    kind: z.literal('includes'),
    all: z.array(z.string().min(1).max(4000)).min(1).max(40),
  }),
  z.strictObject({
    kind: z.literal('json'),
    value: z
      .json()
      .refine((value) => JSON.stringify(value).length <= 65536, 'expected JSON too large'),
  }),
]);
export type EvalExpectation = z.infer<typeof EvalExpectation>;
export const EvalGroup = z.enum([
  'baseline',
  'mandatory_skill',
  'deterministic_check',
  'review_repair',
  'coding_tool',
]);
export type EvalGroup = z.infer<typeof EvalGroup>;
export const EvalWorkspace = z.strictObject({
  projectId: Identifier,
  baseCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
});
const label = z.string().min(1).max(80);
export const EvalSuiteDocument = z
  .strictObject({
    schemaVersion: SchemaVersion,
    comparison: z.literal('personal_harness').optional(),
    workspace: EvalWorkspace.optional(),
    briefs: z
      .array(
        z.strictObject({
          id: label,
          brief: z.string().min(1).max(20000),
          phase: z.enum(['calibration', 'holdout']).optional(),
          expected: EvalExpectation.optional(),
        }),
      )
      .min(1)
      .max(100),
    variants: z
      .array(
        z.strictObject({
          id: label,
          corral: z.string().min(1).max(1000),
          group: EvalGroup.optional(),
        }),
      )
      .min(1)
      .max(20),
  })
  .superRefine((suite, ctx) => {
    for (const [name, rows] of [
      ['brief', suite.briefs],
      ['variant', suite.variants],
    ] as const) {
      const seen = new Set<string>();
      for (const row of rows) {
        if (seen.has(row.id))
          ctx.addIssue({ code: 'custom', message: `duplicate ${name} id ${row.id}` });
        seen.add(row.id);
      }
    }
    if (
      suite.comparison === 'personal_harness' &&
      (suite.variants.length !== 5 ||
        EvalGroup.options.some(
          (group) => suite.variants.filter((variant) => variant.group === group).length !== 1,
        ))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'personal_harness requires one variant for each of the five comparison groups',
      });
  });
export type EvalSuiteDocument = z.infer<typeof EvalSuiteDocument>;
