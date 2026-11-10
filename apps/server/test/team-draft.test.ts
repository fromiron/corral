import { TEAM_PATTERNS, TEAM_SLOTS, type TeamPattern } from '@corral/contracts';
import { describe, expect, it } from 'vitest';
import { DRAFT_SYSTEM_PROMPT, planFromAnswer } from '../src/models/team-draft.ts';

// One model request turns a goal into a team plan (docs/specs/features/library.md). The answer
// is untrusted: only a plan that passes the contract is used, whole or not at all.

const LOOPS = new Set<TeamPattern>([
  'write_review',
  'research_write_review',
  'implement_review',
  'plan_implement_review',
  'bug_fix',
]);
const answer = (pattern: TeamPattern, extra: Record<string, unknown> = {}) => ({
  name: `A ${pattern} team`,
  pattern,
  brief: 'Do the work.',
  criteria: ['Say how it was checked.'],
  roles: TEAM_SLOTS[pattern].map((slot) => ({ slot, name: `${slot}`, duty: `Do ${slot}.` })),
  ...(LOOPS.has(pattern) ? { reviewRounds: 2 } : {}),
  finalApproval: pattern === 'tech_decision',
  ...extra,
});

describe('the draft prompt', () => {
  it('names all eight patterns with their roles from the contract', () => {
    for (const pattern of TEAM_PATTERNS) {
      const line = DRAFT_SYSTEM_PROMPT.split('\n').find((text) =>
        text.startsWith(`- "${pattern}":`),
      );
      expect(line, pattern).toBeDefined();
      expect(line).toContain(`Roles: ${TEAM_SLOTS[pattern].join(', ')}`);
    }
    expect(DRAFT_SYSTEM_PROMPT).toContain(
      'Pick the smallest pattern that fits. Write in the language of the goal.',
    );
  });
});

describe('planFromAnswer', () => {
  it.each(TEAM_PATTERNS)('takes a %s plan, fenced or bare', (pattern) => {
    const plan = answer(pattern);
    expect(planFromAnswer(JSON.stringify(plan))).toEqual(plan);
    expect(planFromAnswer(`Here it is:\n\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``)).toEqual(
      plan,
    );
  });

  it('yields no plan for tools, edges, an unknown pattern or the wrong roles', () => {
    const bad = [
      answer('implement_review', { tools: ['write_file', 'run_command'] }),
      answer('parallel_review', { edges: [{ source: 'scope', target: 'synthesis' }] }),
      answer('tech_decision', { controlEdges: [] }),
      answer('bug_fix', {
        roles: answer('bug_fix').roles.map((role) => ({
          ...role,
          allowedWorkTools: ['write_file'],
        })),
      }),
      { ...answer('bug_fix'), pattern: 'debug_and_fix' },
      { ...answer('implement_review'), pattern: 'implement-review' },
      answer('implement_review', { roles: answer('write_review').roles }),
      answer('parallel_review', { reviewRounds: 2 }),
    ];
    for (const value of bad) expect(planFromAnswer(JSON.stringify(value))).toBeNull();
  });
});
