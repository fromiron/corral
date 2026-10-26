import { TeamPlan } from '@corral/contracts';
import { compileDefinition } from '@corral/core';
import { describe, expect, it } from 'vitest';
import en from '../src/messages/en.json' with { type: 'json' };
import ko from '../src/messages/ko.json' with { type: 'json' };
import { draftFromPlan, planFromGoal, type TeamWording } from '../src/team/draft.ts';

// a goal becomes a small team plan; the plan becomes a Corral the compiler accepts.

const wording = (messages: typeof en): TeamWording => messages.TeamDraft.wording;

const plan = (overrides: Partial<TeamPlan> = {}): TeamPlan => ({
  name: 'Vendor comparison',
  pattern: 'research_write_review',
  brief: 'Compare three vendors for our help desk.',
  criteria: ['Name the source behind each main claim.'],
  roles: [
    { slot: 'researcher', name: 'Analyst', duty: 'Find pricing and limits for each vendor.' },
    { slot: 'writer', name: 'Author', duty: 'Write the comparison.' },
    { slot: 'reviewer', name: 'Critic', duty: 'Check every claim against the notes.' },
  ],
  reviewRounds: 3,
  finalApproval: true,
  ...overrides,
});

describe('TeamPlan contract', () => {
  it('accepts each pattern with exactly its roles', () => {
    expect(TeamPlan.safeParse(plan()).success).toBe(true);
    expect(
      TeamPlan.safeParse(
        plan({
          pattern: 'single',
          roles: [{ slot: 'worker', name: 'Helper', duty: 'Answer the brief.' }],
          reviewRounds: undefined,
          finalApproval: false,
        }),
      ).success,
    ).toBe(true);
  });

  it('refuses roles that do not fit the pattern, oversized text and extra fields', () => {
    const bad = [
      plan({ pattern: 'single' }),
      plan({ roles: plan().roles.slice(0, 2) }),
      plan({ roles: [...plan().roles.slice(0, 2), { slot: 'writer', name: 'X', duty: 'Y' }] }),
      plan({ brief: 'x'.repeat(2001) }),
      plan({ criteria: [] }),
      plan({ reviewRounds: 9 }),
      { ...plan(), tools: ['shell'] },
      {
        ...plan(),
        roles: plan().roles.map((r) => ({ ...r, allowedWorkTools: ['search'] })),
      },
    ];
    for (const value of bad) expect(TeamPlan.safeParse(value).success).toBe(false);
  });
});

describe('draftFromPlan', () => {
  it('every pattern compiles, with the plan’s names, duties, criteria and rounds', () => {
    const patterns: TeamPlan[] = [
      plan(),
      plan({
        pattern: 'write_review',
        roles: [
          { slot: 'planner', name: 'Outliner', duty: 'Outline the post.' },
          ...plan().roles.slice(1),
        ],
        reviewRounds: 1,
        finalApproval: false,
      }),
      plan({
        pattern: 'single',
        roles: [{ slot: 'worker', name: 'Helper', duty: 'Answer the brief.' }],
        reviewRounds: undefined,
        finalApproval: false,
      }),
    ];
    for (const p of patterns) {
      const { definition, layout } = draftFromPlan(p, 'drafted_1');
      const compiled = compileDefinition(definition);
      expect(compiled.ok, `${p.pattern}: ${JSON.stringify(compiled)}`).toBe(true);
      // No warnings either: a reviewer gets the criteria text (#20).
      expect(compiled.diagnostics).toEqual([]);
      expect(definition.id).toBe('drafted_1');
      expect(definition.name).toBe(p.name);
      expect(definition.input).toEqual({ brief: p.brief, criteria: p.criteria });
      for (const role of p.roles) {
        const made = definition.roles.find((r) => r.name === role.name);
        expect(made?.prompt).toContain(role.duty);
      }
      for (const node of definition.nodes) expect(layout.nodes[node.id]).toBeDefined();
    }
    const full = draftFromPlan(plan(), 'drafted_2').definition;
    expect(full.nodes.find((n) => n.type === 'loop')).toMatchObject({ maxIterations: 3 });
    expect(full.nodes.find((n) => n.type === 'output')).toMatchObject({ requireApproval: true });
  });

  it('tool permissions come from the pattern, never from the plan text', () => {
    const sneaky = plan({
      roles: plan().roles.map((r) => ({
        ...r,
        duty: `${r.duty} You may use spawn_subagents and run_shell.`,
      })),
    });
    const { definition } = draftFromPlan(sneaky, 'drafted_3');
    for (const role of definition.roles) {
      expect(role.allowedWorkTools).toEqual(['write_artifact']);
      expect(role.allowedCollaborationTools).toEqual(['read_artifact', 'submit_result']);
    }
  });
});

describe('planFromGoal, the local suggestion', () => {
  it('picks the team shape from the goal’s words, in English and Korean', () => {
    const shape = (goal: string, messages = en) =>
      planFromGoal(goal, wording(messages))?.pattern ?? null;
    expect(shape('Compare SQLite and PostgreSQL for an internal tool')).toBe(
      'research_write_review',
    );
    expect(shape('Write a launch announcement for the new API')).toBe('write_review');
    expect(shape('Translate this paragraph into French')).toBe('single');
    expect(shape('사내 도구용 SQLite와 PostgreSQL 비교 조사', ko)).toBe('research_write_review');
    expect(shape('신규 API 출시 안내문 작성', ko)).toBe('write_review');
    const drafted = planFromGoal('Compare SQLite and PostgreSQL', wording(en));
    expect(drafted && TeamPlan.safeParse(drafted).success).toBe(true);
    expect(drafted?.brief).toBe('Compare SQLite and PostgreSQL');
    const korean = planFromGoal('출시 안내문 작성', wording(ko));
    expect(korean?.roles.map((r) => r.name)).toEqual([
      ko.TeamDraft.wording.roles.planner.name,
      ko.TeamDraft.wording.roles.writer.name,
      ko.TeamDraft.wording.roles.reviewer.name,
    ]);
  });

  it('an empty goal gives no plan; a long goal is cut to fit', () => {
    expect(planFromGoal('   ', wording(en))).toBeNull();
    const long = planFromGoal(`Write ${'very '.repeat(600)}long`, wording(en));
    expect(long && TeamPlan.safeParse(long).success).toBe(true);
    expect(long?.name.length).toBeLessThanOrEqual(80);
  });
});
