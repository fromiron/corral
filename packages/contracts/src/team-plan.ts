import { z } from 'zod';

// CR-006: a team drafted from a goal. It is a small plan, not a Corral definition: tools,
// connections and limits come from the pattern when the plan becomes a definition, so neither
// a model's answer nor pasted text can grant a permission through it.

export const TEAM_PATTERNS = ['single', 'write_review', 'research_write_review'] as const;
export type TeamPattern = (typeof TEAM_PATTERNS)[number];

export const TEAM_SLOTS = {
  single: ['worker'],
  // The first step feeds the review Loop: a Loop is never the entry (Spec §5.3).
  write_review: ['planner', 'writer', 'reviewer'],
  research_write_review: ['researcher', 'writer', 'reviewer'],
} as const satisfies Record<TeamPattern, readonly string[]>;
export type TeamSlot = 'worker' | 'planner' | 'researcher' | 'writer' | 'reviewer';

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
          slot: z.enum(['worker', 'planner', 'researcher', 'writer', 'reviewer']),
          name: Text(TEAM_LIMITS.roleName),
          duty: Text(TEAM_LIMITS.duty),
        }),
      )
      .min(1)
      .max(3),
    /** Review rounds for the patterns with a review loop. */
    reviewRounds: z.int().min(1).max(3).optional(),
    /** The final output waits for the person's approval. */
    finalApproval: z.boolean(),
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
    if (plan.pattern === 'single' && plan.reviewRounds !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['reviewRounds'], message: 'single has no review' });
    }
  });
export type TeamPlan = z.infer<typeof TeamPlan>;
