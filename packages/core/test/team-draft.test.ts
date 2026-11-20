import { isWorkAgent, TEAM_SLOTS, TeamPlan } from '@corral/contracts';
import { describe, expect, it } from 'vitest';
import {
  adviceIntentFromGoal,
  compileDefinition,
  draftFromPlan,
  ROLE_RULES,
} from '../src/index.ts';

// A plan of one of the three base patterns becomes a definition whose tools and wiring come from
// the pattern (auto mode builds its teams this way), and edit mode of the team assistant reads
// review and observation intent from the words (docs/specs/features/team-assistant.md).

const BASE = ['single', 'write_review', 'research_write_review'] as const;
const labels = { loop: 'Review loop', decision: 'Review decision', output: 'Output' };

/** A plan of the pattern with every role worded by its slot. */
const planOf = (pattern: (typeof BASE)[number], more: Partial<TeamPlan> = {}): TeamPlan =>
  TeamPlan.parse({
    name: 'Team',
    pattern,
    brief: 'Brief.',
    criteria: ['Check.'],
    roles: TEAM_SLOTS[pattern].map((slot) => ({ slot, name: `${slot} name`, duty: `Do ${slot}.` })),
    ...(pattern === 'single' ? {} : { reviewRounds: 2 }),
    finalApproval: false,
    ...more,
  });

describe('drafting a base pattern', () => {
  it.each(BASE)('%s keeps each planned duty on its seat', (pattern) => {
    const proposed = planOf(pattern);
    const { definition } = draftFromPlan(proposed, 'drafted_words', labels);
    const seats = definition.nodes.filter(isWorkAgent);
    expect(seats.map((node) => [node.roleId, node.stepInstruction])).toEqual(
      proposed.roles.map(({ slot, duty }) => [slot, duty]),
    );
    for (const role of definition.roles) expect(role.prompt).toBe(ROLE_RULES);
  });

  it('gives every role only write_artifact, and compiles', () => {
    for (const pattern of BASE) {
      const { definition } = draftFromPlan(planOf(pattern), 'drafted_6', labels);
      expect(compileDefinition(definition).ok).toBe(true);
      for (const role of definition.roles)
        expect(role.allowedWorkTools).toEqual(['write_artifact']);
    }
  });

  it('keeps requested artifact advice outside the work sequence', () => {
    const { definition } = draftFromPlan(
      planOf('single', { outrider: 'artifact_review' }),
      'requested_review',
      labels,
    );
    expect(definition.sharedOutrider).toMatchObject({
      targets: { kind: 'all' },
      artifactReview: true,
    });
    expect(compileDefinition(definition).ok).toBe(true);
    expect(definition.nodes.map((step) => step.type)).toEqual(['agent', 'output']);
    expect(definition.roles).toHaveLength(1);
  });

  it('gives consultation an Outrider without observation or artifact review', () => {
    const { definition } = draftFromPlan(
      planOf('single', { outrider: 'consultation' }),
      'advice',
      labels,
    );
    expect(definition.nodes.map((node) => node.type)).toEqual(['agent', 'output']);
    expect(definition.sharedOutrider).toMatchObject({ targets: { kind: 'all' } });
    expect(definition.sharedOutrider).not.toHaveProperty('observation');
    expect(definition.sharedOutrider).not.toHaveProperty('artifactReview');
  });

  it.each(BASE)('%s observes the workers only when the plan asks', (pattern) => {
    const observed = draftFromPlan(planOf(pattern, { observeWork: true }), 'observe', labels);
    expect(observed.definition.sharedOutrider).toMatchObject({
      targets: { kind: 'all' },
      observation: { targets: { kind: 'all' }, review: { interval: 3, maxRequestsPerReview: 8 } },
    });
    expect(
      observed.definition.nodes.some(
        (node) => node.type === 'agent' && node.invocation === 'observer',
      ),
    ).toBe(false);
    const plain = draftFromPlan(planOf(pattern), 'plain', labels);
    expect(plain.definition.sharedOutrider?.observation).toBeUndefined();
  });
});

describe('advice intent in an edit request', () => {
  it.each([
    ['작업자가 직접 고쳐 제출', undefined],
    ['모두가 필요할 때 전문가에게 물어보게 해줘', 'consultation'],
    ['작성자가 원고 리뷰를 요청할 수 있게', 'artifact_review'],
    ['리뷰 후 제출', 'clarify_review'],
    ['매 제출 전 반드시 통과', 'required_review'],
    ['Write an invitation. The result must pass review before submitting.', 'required_review'],
  ] as const)('keeps authorship and review policy distinct for %s', (goal, policy) => {
    expect(adviceIntentFromGoal(goal).outrider).toBe(policy);
  });

  it.each([
    '작성자가 필요할 때만 전문가에게 자문한다. 검토 통과나 자동 관찰은 필요 없다.',
    'The writer consults an expert when needed. No review pass or automatic observation is needed.',
    'Let the writer ask for advice on demand; passing review and automatic observation are not required.',
  ])('keeps negated review and observation out: %s', (goal) => {
    expect(adviceIntentFromGoal(goal)).toEqual({
      outrider: 'consultation',
      observeWork: false,
      singleWithoutReview: true,
    });
  });

  it('does not negate independently requested manuscript feedback or work observation', () => {
    expect(
      adviceIntentFromGoal(
        'Ask for manuscript feedback when needed. No review pass is needed. Watch work in progress.',
      ),
    ).toMatchObject({ outrider: 'artifact_review', observeWork: true });
    expect(adviceIntentFromGoal('Write the note. A review pass is not required.')).toMatchObject({
      singleWithoutReview: true,
    });
    // Explicit roles outrank a declined review.
    expect(
      adviceIntentFromGoal('A planner and then a writer. A review pass is not required.'),
    ).toMatchObject({ singleWithoutReview: false });
  });

  it.each([
    ['진행 중 자동 관찰을 켜고 작성자가 원고 리뷰를 요청할 수 있게', 'artifact_review'],
    ['자동 관찰을 켜 줘.', undefined],
    ['작업자들을 주기적으로 관찰해 줘.', undefined],
    ['Automatically monitor the workers as they work.', undefined],
    ['Let the Outrider watch work in progress.', undefined],
    ['Let the writer ask for feedback when needed and watch work in progress.', 'artifact_review'],
  ] as const)('reads an independent observation request in %s', (goal, outrider) => {
    expect(adviceIntentFromGoal(goal)).toMatchObject({ observeWork: true, outrider });
  });

  it.each([
    'Let the writer ask for manuscript review when needed.',
    '자동 관찰하지 말고 필요할 때만 전문가에게 물어보게 해줘.',
    '진행 중 자동 관찰을 끄고 필요할 때만 의견을 받자.',
    '자동 관찰을 켜지 말고 요청한 작업자에게만 답해줘.',
    'Do not enable automatic observation of workers.',
    'Do not automatically monitor the workers. Let the writer ask for advice when needed.',
    'Observe how bicycle gears work and explain the process.',
    'Build a service to automatically monitor traffic.',
  ])('leaves automatic observation off for %s', (goal) => {
    expect(adviceIntentFromGoal(goal).observeWork).toBe(false);
  });
});
