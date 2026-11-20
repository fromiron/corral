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

// A drafted team's plan (docs/specs/features/library.md): eleven patterns, each with exactly its
// role slots. Anything else in a model's answer makes the whole plan unusable.

const EXPECTED_SLOTS: Record<TeamPattern, string[]> = {
  single: ['worker'],
  write_review: ['planner', 'writer', 'reviewer'],
  research_write_review: ['researcher', 'writer', 'reviewer'],
  implement_review: ['implement', 'review'],
  feature: ['design', 'implement', 'verify'],
  bug_fix: ['investigate', 'fix', 'verify'],
  refactor: ['pin', 'reshape', 'verify'],
  performance: ['baseline', 'improve', 'measure'],
  adversarial_review: ['scope', 'attack_a', 'attack_b', 'verdict'],
  tech_decision: ['frame', 'option_a', 'option_b', 'decide'],
  code_investigation: ['scope', 'trace', 'history', 'write'],
};
// A review or a verification judges the work in a Loop.
const LOOPS = new Set<TeamPattern>([
  'write_review',
  'research_write_review',
  'implement_review',
  'feature',
  'bug_fix',
  'refactor',
  'performance',
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
  it('are the eleven, with their slots in execution order', () => {
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
    const five = planFor('adversarial_review', [...TEAM_SLOTS.adversarial_review, 'review']);
    expect(TeamPlan.safeParse(five).success).toBe(false);
    for (const pattern of TEAM_PATTERNS) {
      const rounds = { ...planFor(pattern), reviewRounds: 2 };
      expect(TeamPlan.safeParse(rounds).success, pattern).toBe(LOOPS.has(pattern));
    }
  });

  it('refuses the retired patterns and a plan with the slots of the pattern it replaced', () => {
    const retired = { ...planFor('feature'), pattern: 'plan_implement_review' };
    expect(TeamPlan.safeParse(retired).success).toBe(false);
    expect(
      TeamPlan.safeParse({ ...planFor('adversarial_review'), pattern: 'parallel_review' }).success,
    ).toBe(false);
    // The old lineups' slots are not the new patterns' slots.
    const old = [
      planFor('feature', ['plan', 'implement', 'review']),
      planFor('bug_fix', ['investigate', 'fix', 'review']),
      planFor('adversarial_review', ['scope', 'correctness', 'security', 'synthesis']),
      planFor('tech_decision', ['frame', 'research_a', 'research_b', 'compare']),
      // Another pattern's slots under this pattern's name.
      planFor('refactor', [...TEAM_SLOTS.feature]),
      planFor('code_investigation', [...TEAM_SLOTS.adversarial_review]),
    ];
    for (const value of old) expect(TeamPlan.safeParse(value).success).toBe(false);
  });

  it('refuses any field the plan does not have: tools, edges, limits, role tools', () => {
    const bad = [
      { ...planFor('implement_review'), tools: ['run_command'] },
      { ...planFor('adversarial_review'), edges: [{ source: 'scope', target: 'verdict' }] },
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
        ...planFor('feature'),
        roles: planFor('feature').roles.map((role) => ({
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
