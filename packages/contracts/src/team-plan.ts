import { z } from 'zod';

// A team of one of the three patterns auto mode builds. It is a small plan, not a Corral
// definition: tools, connections and limits come from the pattern when the plan becomes a
// definition, so nothing written into a plan can grant a permission through it.

export const TEAM_PATTERNS = ['single', 'write_review', 'research_write_review'] as const;
export type TeamPattern = (typeof TEAM_PATTERNS)[number];

/** Each pattern's role slots in execution order. */
export const TEAM_SLOTS = {
  single: ['worker'],
  // The first step feeds the review Loop: a Loop is never the entry.
  write_review: ['planner', 'writer', 'reviewer'],
  research_write_review: ['researcher', 'writer', 'reviewer'],
} as const satisfies Record<TeamPattern, readonly string[]>;
export type PatternSlot<P extends TeamPattern> = (typeof TEAM_SLOTS)[P][number];
export type TeamSlot = PatternSlot<TeamPattern>;

const SLOT_NAMES = [...new Set(Object.values(TEAM_SLOTS).flat())] as [TeamSlot, ...TeamSlot[]];
const MAX_ROLES = Math.max(...Object.values(TEAM_SLOTS).map((slots) => slots.length));

/** The patterns whose work a review judges in a Loop; only these take `reviewRounds`. */
export const REVIEW_LOOP_PATTERNS = [
  'write_review',
  'research_write_review',
] as const satisfies readonly TeamPattern[];

export const hasReviewLoop = (pattern: TeamPattern) =>
  (REVIEW_LOOP_PATTERNS as readonly TeamPattern[]).includes(pattern);

const Text = (max: number) => z.string().trim().min(1).max(max);

export const TEAM_LIMITS = { name: 80, brief: 2000, criterion: 200, roleName: 40, duty: 400 };

export const TeamPlan = z
  .strictObject({
    name: Text(TEAM_LIMITS.name),
    pattern: z.enum(TEAM_PATTERNS),
    brief: Text(TEAM_LIMITS.brief),
    criteria: z.array(Text(TEAM_LIMITS.criterion)).min(1).max(6),
    roles: z
      .array(
        z.strictObject({
          slot: z.enum(SLOT_NAMES),
          name: Text(TEAM_LIMITS.roleName),
          duty: Text(TEAM_LIMITS.duty),
        }),
      )
      .min(1)
      .max(MAX_ROLES),
    /** Rounds for the patterns whose work a review judges in a Loop. */
    reviewRounds: z.int().min(1).max(3).optional(),
    /** The final output waits for the person's approval. No pattern turns this on by itself. */
    finalApproval: z.boolean(),
    /** Explicitly watch the workers while they work, independently of their review policy. */
    observeWork: z.literal(true).optional(),
    /** Requested shared consultation; unresolved policies are shown before a draft can be saved. */
    outrider: z
      .enum(['consultation', 'artifact_review', 'clarify_review', 'required_review'])
      .optional(),
  })
  .superRefine((plan, ctx) => {
    const wanted: readonly string[] = TEAM_SLOTS[plan.pattern];
    const slots = plan.roles.map((r) => r.slot);
    if (
      slots.length !== wanted.length ||
      !wanted.every((slot) => slots.includes(slot as TeamSlot))
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['roles'],
        message: `${plan.pattern} needs exactly these roles: ${wanted.join(', ')}`,
      });
    }
    if (!hasReviewLoop(plan.pattern) && plan.reviewRounds !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['reviewRounds'],
        message: `${plan.pattern} has no review rounds`,
      });
    }
  });
export type TeamPlan = z.infer<typeof TeamPlan>;
