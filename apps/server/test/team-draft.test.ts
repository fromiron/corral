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
  finalApproval: false,
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
    expect(DRAFT_SYSTEM_PROMPT).toContain('Pick the smallest pattern that fits.');
    expect(DRAFT_SYSTEM_PROMPT).toContain('Write in the language of the goal.');
  });

  it('asks for an approval only when the goal does, and for no pattern by rule', () => {
    const line = DRAFT_SYSTEM_PROMPT.split('\n').find((text) =>
      text.startsWith('- finalApproval:'),
    );
    expect(line).toContain('true or false');
    expect(line).toContain('false unless the goal itself asks');
    expect(DRAFT_SYSTEM_PROMPT).not.toContain('always true');
    expect(DRAFT_SYSTEM_PROMPT).not.toContain('to approve.');
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

  it('reads an answer that leaves the approval out as a plan without one', () => {
    const { finalApproval: _left, ...bare } = answer('tech_decision');
    expect(planFromAnswer(JSON.stringify(bare))).toEqual({ ...bare, finalApproval: false });
    expect(planFromAnswer(JSON.stringify({ ...bare, finalApproval: true }))?.finalApproval).toBe(
      true,
    );
    // Any other value for it is still not a plan.
    expect(planFromAnswer(JSON.stringify({ ...bare, finalApproval: 'no' }))).toBeNull();
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
