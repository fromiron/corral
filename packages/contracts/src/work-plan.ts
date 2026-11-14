import { z } from 'zod';
import { Identifier } from './ids.ts';

// A work plan is a plain checklist of progress: each item is a title and a status. It claims
// nothing about verification; checks are recorded on their own (chat-widgets-contract §5.4).

const ITEM_FIELDS = ['id', 'title', 'status'] as const;

export const WorkPlanItems = z
  .array(
    z.strictObject({
      id: Identifier,
      title: z.string().trim().min(1).max(500),
      status: z.enum(['pending', 'in_progress', 'completed']),
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
  );

const UPDATE_FIELDS = ['scope', 'expectedRevision', 'criteriaVersionId', 'items'] as const;

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

/** A field name the model sent that is safe to repeat back: a plain identifier, never prose. */
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/**
 * Why an `update_plan` input is refused, for the model that sent it: the first problem's field
 * path and rule. It never repeats a value the input held (an item title can carry the person's
 * words), and names an unknown field only when the name is a plain identifier. Null when valid.
 */
export function workPlanProblem(input: unknown): string | null {
  const parsed = WorkPlanUpdate.safeParse(input);
  if (parsed.success) return null;
  const issue = parsed.error.issues[0];
  if (!issue) return 'input: invalid';
  const path = issue.path.map(String).join('.') || 'input';
  if (issue.code === 'unrecognized_keys') {
    const named = issue.keys.filter((key) => FIELD_NAME.test(key));
    const allowed = issue.path.length === 0 ? UPDATE_FIELDS : ITEM_FIELDS;
    const unknown = named.length
      ? `unknown field${named.length > 1 ? 's' : ''} ${named.join(', ')}`
      : 'unknown field';
    return `${path}: ${unknown}; allowed fields are ${allowed.join(', ')}`;
  }
  // Zod's own messages state the rule (expected type, length, options, pattern) without the
  // received value; the refinements above are this contract's own sentences.
  return `${path}: ${issue.message}`.slice(0, 300);
}
