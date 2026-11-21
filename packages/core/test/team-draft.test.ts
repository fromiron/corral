import { isWorkAgent, TEAM_SLOTS, TeamPlan } from '@corral/contracts';
import { describe, expect, it } from 'vitest';
import { compileDefinition, draftFromPlan, ROLE_RULES } from '../src/index.ts';

// A plan of one of the three base patterns becomes a definition whose tools and wiring come from
// the pattern (auto mode builds its teams this way).

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
