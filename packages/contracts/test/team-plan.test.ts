import { describe, expect, it } from 'vitest';
import {
  AUTO_TEMPLATE_VERSION,
  AUTO_TEMPLATES,
  AutoTemplate,
  TEAM_PATTERNS,
  TEAM_SLOTS,
  type TeamPattern,
  TeamPlan,
} from '../src/index.ts';

// A drafted team's plan (docs/specs/features/library.md): eight patterns, each with exactly its
// role slots. Anything else in a model's answer makes the whole plan unusable.

const EXPECTED_SLOTS: Record<TeamPattern, string[]> = {
  single: ['worker'],
  write_review: ['planner', 'writer', 'reviewer'],
  research_write_review: ['researcher', 'writer', 'reviewer'],
  implement_review: ['implement', 'review'],
  plan_implement_review: ['plan', 'implement', 'review'],
  bug_fix: ['investigate', 'fix', 'review'],
  parallel_review: ['scope', 'correctness', 'security', 'synthesis'],
  tech_decision: ['frame', 'research_a', 'research_b', 'compare'],
};
const LOOPS = new Set<TeamPattern>([
  'write_review',
  'research_write_review',
  'implement_review',
  'plan_implement_review',
  'bug_fix',
]);

const planFor = (pattern: TeamPattern, slots: readonly string[] = TEAM_SLOTS[pattern]) => ({
  name: `A ${pattern} team`,
  pattern,
  brief: 'Do the work the goal asks for.',
  criteria: ['Do what the brief asks.'],
  roles: slots.map((slot) => ({ slot, name: `${slot} role`, duty: `Do the ${slot} part.` })),
  ...(LOOPS.has(pattern) ? { reviewRounds: 2 } : {}),
  finalApproval: false,
});

describe('TeamPlan patterns', () => {
  it('are the eight, with their slots in execution order', () => {
    expect([...TEAM_PATTERNS]).toEqual(Object.keys(EXPECTED_SLOTS));
    for (const pattern of TEAM_PATTERNS)
      expect([...TEAM_SLOTS[pattern]]).toEqual(EXPECTED_SLOTS[pattern]);
  });

  it.each(TEAM_PATTERNS)('%s accepts exactly its slots, in any order', (pattern) => {
    expect(TeamPlan.safeParse(planFor(pattern)).success).toBe(true);
    expect(TeamPlan.safeParse(planFor(pattern, [...TEAM_SLOTS[pattern]].reverse())).success).toBe(
      true,
    );
  });

  it.each(TEAM_PATTERNS)('%s refuses a missing, repeated, extra or foreign slot', (pattern) => {
    const slots: readonly string[] = TEAM_SLOTS[pattern];
    const foreign = TEAM_PATTERNS.flatMap((other) => [...TEAM_SLOTS[other]]).find(
      (slot) => !slots.includes(slot),
    );
    const bad = [
      planFor(pattern, slots.slice(1)),
      planFor(pattern, [...slots, slots[0] as string]),
      planFor(
        pattern,
        slots.length > 1 ? [...slots.slice(0, -1), slots[0] as string] : [...slots, ...slots],
      ),
      planFor(pattern, [...slots.slice(0, -1), foreign as string]),
      planFor(pattern, [...slots, foreign as string]),
      planFor(pattern, [...slots.slice(0, -1), 'deployer']),
    ];
    for (const value of bad) expect(TeamPlan.safeParse(value).success).toBe(false);
  });

  it('refuses an unknown pattern, more than four roles, and review rounds without a review loop', () => {
    expect(TeamPlan.safeParse({ ...planFor('bug_fix'), pattern: 'bug_hunt' }).success).toBe(false);
    expect(TeamPlan.safeParse({ ...planFor('single'), pattern: 'Single' }).success).toBe(false);
    const five = planFor('parallel_review', [...TEAM_SLOTS.parallel_review, 'review']);
    expect(TeamPlan.safeParse(five).success).toBe(false);
    for (const pattern of TEAM_PATTERNS) {
      const rounds = { ...planFor(pattern), reviewRounds: 2 };
      expect(TeamPlan.safeParse(rounds).success, pattern).toBe(LOOPS.has(pattern));
    }
  });

  it('refuses any field the plan does not have: tools, edges, limits, role tools', () => {
    const bad = [
      { ...planFor('implement_review'), tools: ['run_command'] },
      { ...planFor('parallel_review'), edges: [{ source: 'scope', target: 'synthesis' }] },
      { ...planFor('tech_decision'), controlEdges: [] },
      { ...planFor('bug_fix'), limits: { maxTurns: 500 } },
      {
        ...planFor('bug_fix'),
        roles: planFor('bug_fix').roles.map((role) => ({
          ...role,
          allowedWorkTools: ['write_file'],
        })),
      },
      {
        ...planFor('plan_implement_review'),
        roles: planFor('plan_implement_review').roles.map((role) => ({
          ...role,
          modelProfile: 'model-b',
        })),
      },
    ];
    for (const value of bad) expect(TeamPlan.safeParse(value).success).toBe(false);
  });
});

describe('auto mode keeps its three templates', () => {
  it('is its own list, not the draft patterns, and its version is unchanged', () => {
    expect([...AUTO_TEMPLATES]).toEqual(['single', 'write_review', 'research_write_review']);
    expect(AUTO_TEMPLATE_VERSION).toBe(3);
    for (const pattern of TEAM_PATTERNS)
      expect(AutoTemplate.safeParse(pattern).success, pattern).toBe(
        (AUTO_TEMPLATES as readonly string[]).includes(pattern),
      );
  });
});
