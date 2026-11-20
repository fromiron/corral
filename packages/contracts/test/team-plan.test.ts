import { describe, expect, it } from 'vitest';
import {
  AUTO_TEMPLATE_VERSION,
  AUTO_TEMPLATES,
  AutoTemplate,
  REVIEW_LOOP_PATTERNS,
  TEAM_PATTERNS,
  TEAM_SLOTS,
  type TeamPattern,
  TeamPlan,
} from '../src/index.ts';

// A plan of one of the three patterns auto mode builds, each with exactly its role slots.
// Anything else makes the whole plan unusable.

const EXPECTED_SLOTS: Record<TeamPattern, string[]> = {
  single: ['worker'],
  write_review: ['planner', 'writer', 'reviewer'],
  research_write_review: ['researcher', 'writer', 'reviewer'],
};
// A review judges the work in a Loop.
const LOOPS = new Set<TeamPattern>(['write_review', 'research_write_review']);

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
  it('are the three auto mode builds, with their slots in execution order', () => {
    expect([...TEAM_PATTERNS]).toEqual(Object.keys(EXPECTED_SLOTS));
    expect(Object.keys(TEAM_SLOTS)).toEqual(Object.keys(EXPECTED_SLOTS));
    for (const pattern of TEAM_PATTERNS)
      expect([...TEAM_SLOTS[pattern]]).toEqual(EXPECTED_SLOTS[pattern]);
    expect([...REVIEW_LOOP_PATTERNS]).toEqual([...LOOPS]);
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

  it('refuses an unknown pattern, more than three roles, and review rounds without a review loop', () => {
    expect(TeamPlan.safeParse({ ...planFor('single'), pattern: 'Single' }).success).toBe(false);
    for (const removed of ['bug_fix', 'feature', 'implement_review', 'tech_decision'])
      expect(TeamPlan.safeParse({ ...planFor('write_review'), pattern: removed }).success).toBe(
        false,
      );
    const four = planFor('write_review', [...TEAM_SLOTS.write_review, 'researcher']);
    expect(TeamPlan.safeParse(four).success).toBe(false);
    for (const pattern of TEAM_PATTERNS) {
      const rounds = { ...planFor(pattern), reviewRounds: 2 };
      expect(TeamPlan.safeParse(rounds).success, pattern).toBe(LOOPS.has(pattern));
    }
  });

  it('refuses any field the plan does not have: tools, edges, limits, role tools', () => {
    const bad = [
      { ...planFor('single'), tools: ['run_command'] },
      { ...planFor('write_review'), edges: [{ source: 'planner', target: 'reviewer' }] },
      { ...planFor('research_write_review'), controlEdges: [] },
      { ...planFor('single'), limits: { maxTurns: 500 } },
      {
        ...planFor('write_review'),
        roles: planFor('write_review').roles.map((role) => ({
          ...role,
          allowedWorkTools: ['write_file'],
        })),
      },
      {
        ...planFor('research_write_review'),
        roles: planFor('research_write_review').roles.map((role) => ({
          ...role,
          modelProfile: 'model-b',
        })),
      },
    ];
    for (const value of bad) expect(TeamPlan.safeParse(value).success).toBe(false);
  });
});

describe('auto mode keeps its three templates', () => {
  it('are the plan patterns, and its version is unchanged', () => {
    expect([...AUTO_TEMPLATES]).toEqual(['single', 'write_review', 'research_write_review']);
    expect([...AUTO_TEMPLATES]).toEqual([...TEAM_PATTERNS]);
    expect(AUTO_TEMPLATE_VERSION).toBe(3);
    for (const pattern of TEAM_PATTERNS) expect(AutoTemplate.safeParse(pattern).success).toBe(true);
  });
});
