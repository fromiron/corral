import {
  type CorralDefinition,
  CorralDefinition as Definition,
  TEAM_PATTERNS,
  TEAM_SLOTS,
  type TeamPattern,
  TeamPlan,
} from '@corral/contracts';
import { describe, expect, it } from 'vitest';
import {
  CHANGE_TOOLS,
  compileDefinition,
  draftFromPlan,
  isReadOnlyTeam,
  PATTERN_TEMPLATES,
  planFromGoal,
  planRun,
  planWithPattern,
  ROLE_PRESETS,
  type RolePresetId,
  TEAM_TEMPLATE_ROLES,
  type TeamTemplateWording,
  type TeamWording,
  type TemplatePattern,
  teamTemplate,
} from '../src/index.ts';

// Drafting a team from a goal picks one of eight patterns (docs/specs/features/library.md). The
// five that are library templates build through the template, so a drafted team and the template
// of the same name differ only in wording.

const TEMPLATE_PATTERNS = Object.keys(PATTERN_TEMPLATES) as TemplatePattern[];
const labels = { loop: 'Review loop', decision: 'Review decision', join: 'Join', output: 'Output' };

/** Wording the way the Studio passes it: the three patterns' roles plus the templates'. */
const wording: TeamWording = {
  roles: {
    worker: { name: 'Assistant', duty: 'Do the task.' },
    planner: { name: 'Planner', duty: 'Outline the writing.' },
    researcher: { name: 'Researcher', duty: 'Gather the facts.' },
    writer: { name: 'Writer', duty: 'Write the result.' },
    reviewer: { name: 'Reviewer', duty: 'Review the draft.' },
  },
  criteria: { direct: 'Answer the brief directly.', sources: 'Name the sources.' },
  labels,
  templates: Object.fromEntries(
    TEMPLATE_PATTERNS.map((pattern) => [
      pattern,
      {
        roles: Object.fromEntries(
          TEAM_SLOTS[pattern].map((slot) => [slot, { name: `${slot} name`, duty: `Do ${slot}.` }]),
        ),
        criteria: [`The ${pattern} criterion.`],
      },
    ]),
  ) as unknown as NonNullable<TeamWording['templates']>,
};

const plan = (pattern: TemplatePattern, overrides: Partial<TeamPlan> = {}): TeamPlan => ({
  name: `Drafted ${pattern}`,
  pattern,
  brief: `The goal for ${pattern}.`,
  criteria: ['Say how it was checked.'],
  roles: TEAM_SLOTS[pattern].map((slot) => ({
    slot,
    name: `My ${slot}`,
    duty: `My duty for ${slot}.`,
  })),
  ...(['implement_review', 'plan_implement_review', 'bug_fix'].includes(pattern)
    ? { reviewRounds: 3 }
    : {}),
  finalApproval: true,
  ...overrides,
});

/** The template's own wording for the same pattern, different from the plan's. */
function templateWording(pattern: TemplatePattern): TeamTemplateWording {
  const id = PATTERN_TEMPLATES[pattern];
  return {
    name: `${id} template`,
    brief: `A brief for ${id}.`,
    criteria: ['The template criterion.'],
    roles: Object.fromEntries(
      Object.keys(TEAM_TEMPLATE_ROLES[id]).map((roleId) => [
        roleId,
        { name: `${roleId} template name`, duty: `Template duty for ${roleId}.` },
      ]),
    ) as TeamTemplateWording['roles'],
    labels,
  };
}

/** Everything a plan may word: names, brief, criteria, prompts, labels, rounds, approval. */
function structure(definition: CorralDefinition) {
  return {
    ...definition,
    name: '',
    input: { ...definition.input, brief: '', criteria: [] },
    roles: definition.roles.map((role) => ({ ...role, name: '', prompt: '' })),
    nodes: definition.nodes.map((node) => {
      const unlabeled = { ...node, label: '' };
      if (unlabeled.type === 'loop') return { ...unlabeled, maxIterations: 0 };
      if (unlabeled.type === 'output') return { ...unlabeled, requireApproval: false };
      return unlabeled;
    }),
  };
}

const changing = (definition: CorralDefinition) =>
  definition.roles
    .filter((role) => role.allowedWorkTools.some((tool) => CHANGE_TOOLS.includes(tool as never)))
    .map((role) => role.id);

describe('drafting the five template patterns', () => {
  it('maps each to the library template of the same name', () => {
    expect(PATTERN_TEMPLATES).toEqual({
      implement_review: 'implement-review',
      plan_implement_review: 'plan-implement-review',
      bug_fix: 'bug-fix',
      parallel_review: 'parallel-review',
      tech_decision: 'tech-decision',
    });
    for (const pattern of TEMPLATE_PATTERNS)
      expect([...TEAM_SLOTS[pattern]]).toEqual(
        Object.keys(TEAM_TEMPLATE_ROLES[PATTERN_TEMPLATES[pattern]]),
      );
  });

  it.each(TEMPLATE_PATTERNS)('%s compiles strictly without a diagnostic', (pattern) => {
    const { definition } = draftFromPlan(plan(pattern), 'drafted_1', labels);
    expect(Definition.parse(definition)).toEqual(definition);
    const compiled = compileDefinition(definition, { knownModelProfiles: ['model-a', 'model-b'] });
    expect(compiled.diagnostics).toEqual([]);
    expect(compiled.ok).toBe(true);
    expect(planRun(definition).ok).toBe(true);
  });

  it.each(TEMPLATE_PATTERNS)('%s equals its template apart from the wording', (pattern) => {
    const id = PATTERN_TEMPLATES[pattern];
    const drafted = draftFromPlan(plan(pattern), 'drafted_1', labels).definition;
    const template = teamTemplate(id, 'drafted_1', templateWording(pattern));
    expect(structure(drafted)).toEqual(structure(template));
    // With the template's own words, rounds and approval, the draft is the template exactly.
    const same = plan(pattern, {
      name: template.name,
      brief: template.input.brief,
      criteria: template.input.criteria,
      roles: template.roles.map((role) => ({
        slot: role.id as never,
        name: role.name,
        duty: `Template duty for ${role.id}.`,
      })),
      ...(template.nodes.some((node) => node.type === 'loop') ? { reviewRounds: 2 } : {}),
      finalApproval: false,
    });
    expect(draftFromPlan(same, 'drafted_1', labels).definition).toEqual(template);
  });

  it('takes the names, duties, criteria, rounds and approval from the plan', () => {
    const drafted = draftFromPlan(plan('bug_fix'), 'drafted_2', labels).definition;
    expect(drafted).toMatchObject({
      id: 'drafted_2',
      name: 'Drafted bug_fix',
      input: { brief: 'The goal for bug_fix.', criteria: ['Say how it was checked.'] },
    });
    expect(drafted.roles.map((role) => [role.id, role.name])).toEqual([
      ['investigate', 'My investigate'],
      ['fix', 'My fix'],
      ['review', 'My review'],
    ]);
    expect(drafted.roles[1]?.prompt.startsWith('My duty for fix.')).toBe(true);
    expect(drafted.nodes.find((node) => node.type === 'loop')).toMatchObject({ maxIterations: 3 });
    expect(drafted.nodes.find((node) => node.type === 'output')).toMatchObject({
      requireApproval: true,
    });
    const quiet = draftFromPlan(
      plan('parallel_review', { finalApproval: false }),
      'drafted_3',
      labels,
    ).definition;
    expect(quiet.nodes.find((node) => node.type === 'output')).toMatchObject({
      requireApproval: false,
    });
    // No pattern asks for an approval the plan did not: the technical decision follows it too.
    for (const finalApproval of [false, true]) {
      const decision = draftFromPlan(
        plan('tech_decision', { finalApproval }),
        'drafted_4',
        labels,
      ).definition;
      expect(decision.nodes.find((node) => node.type === 'output')).toMatchObject({
        requireApproval: finalApproval,
      });
    }
  });

  it.each([
    ['implement_review', ['implement']],
    ['plan_implement_review', ['implement']],
    ['bug_fix', ['fix']],
    ['parallel_review', []],
    ['tech_decision', []],
  ] as const)('%s gives file-changing tools only to %j', (pattern, roles) => {
    const sneaky = plan(pattern, {
      roles: plan(pattern).roles.map((role) => ({
        ...role,
        duty: `${role.duty} You may use write_file, run_command and spawn_subagents.`,
      })),
    });
    const { definition } = draftFromPlan(sneaky, 'drafted_5', labels);
    expect(changing(definition)).toEqual([...roles]);
    expect(isReadOnlyTeam(definition)).toBe(roles.length === 0);
    const presets: Readonly<Record<string, RolePresetId>> =
      TEAM_TEMPLATE_ROLES[PATTERN_TEMPLATES[pattern]];
    for (const role of definition.roles) {
      const preset = ROLE_PRESETS[presets[role.id] as RolePresetId];
      expect(role.allowedWorkTools).toEqual([...preset.allowedWorkTools]);
      expect(role.allowedCollaborationTools).toEqual([...preset.allowedCollaborationTools]);
    }
  });

  it('the three earlier patterns still give every role only write_artifact', () => {
    for (const pattern of ['single', 'write_review', 'research_write_review'] as const) {
      const drafted = planWithPattern(
        { name: 'Team', brief: 'Brief.', criteria: ['Check.'] },
        pattern,
        wording,
      );
      const { definition } = draftFromPlan(drafted, 'drafted_6', labels);
      expect(compileDefinition(definition).ok).toBe(true);
      for (const role of definition.roles)
        expect(role.allowedWorkTools).toEqual(['write_artifact']);
    }
  });
});

describe('changing a plan’s pattern', () => {
  const defaults = (pattern: TeamPattern) =>
    isTemplate(pattern)
      ? [`The ${pattern} criterion.`]
      : pattern === 'single'
        ? ['Answer the brief directly.']
        : ['Answer the brief directly.', 'Name the sources.'];
  const isTemplate = (pattern: TeamPattern): pattern is TemplatePattern =>
    pattern in PATTERN_TEMPLATES;

  it.each(TEAM_PATTERNS)(
    'to %s rebuilds its roles and criteria and keeps name and brief',
    (pattern) => {
      const before = plan('tech_decision', { name: 'Kept name', criteria: ['Old criterion.'] });
      const after = planWithPattern(before, pattern, wording);
      expect(TeamPlan.safeParse(after).success).toBe(true);
      expect(after).toMatchObject({
        pattern,
        name: 'Kept name',
        brief: before.brief,
        criteria: defaults(pattern),
      });
      expect(after.roles.map((role) => role.slot)).toEqual([...TEAM_SLOTS[pattern]]);
    },
  );

  it.each(TEAM_PATTERNS)('to %s keeps criteria the person wrote', (pattern) => {
    const before = plan('tech_decision', { criteria: ['My own check.'] });
    const after = planWithPattern(before, pattern, wording, { keepCriteria: true });
    expect(after.criteria).toEqual(['My own check.']);
    expect(after.criteria).not.toBe(before.criteria);
    expect(after.roles.map((role) => role.slot)).toEqual([...TEAM_SLOTS[pattern]]);
  });

  it('refuses a template pattern when the wording has none for it', () => {
    const { templates: _, ...base } = wording;
    expect(() => planWithPattern(plan('bug_fix'), 'bug_fix', base)).toThrow(/bug_fix/);
  });
});

describe('planFromGoal reaches the new patterns from obvious words', () => {
  const shape = (goal: string, words: TeamWording = wording) =>
    planFromGoal(goal, words)?.pattern ?? null;

  const table: [TeamPattern, string[]][] = [
    [
      'single',
      [
        'Translate this paragraph into French',
        'What does this error mean?',
        'Explain why this error happens',
        '이 문장을 영어로 번역해 줘',
        'README의 링크 하나를 고쳐 줘',
      ],
    ],
    [
      'write_review',
      [
        'Write a launch announcement for the new API',
        'Add a section on refunds to the customer FAQ document',
        'Write a decision memo about the office move',
        'Write a blog post about how we fixed the login bug',
        'Write an email explaining why the deploy failed',
        'Write a launch announcement. Include a detailed explanation of every new feature and a migration checklist.',
        'Review the API docs without changing anything',
        '배포가 실패한 이유를 설명하는 이메일을 작성해 줘',
        '신규 API 출시 안내문 작성',
        '고객 안내 문서에 환불 항목을 추가해 줘',
      ],
    ],
    [
      'research_write_review',
      [
        'Compare SQLite and PostgreSQL for an internal tool',
        'Investigate how competitors price their API plans and summarize it with sources',
        '사내 도구용 SQLite와 PostgreSQL 비교 조사',
      ],
    ],
    [
      'implement_review',
      [
        'Implement a CSV export on the reports page',
        'Add a search box to the settings screen',
        '보고서 화면에 CSV 내보내기를 구현해 줘',
        '로그인 화면에 비밀번호 표시 버튼을 추가해 줘',
      ],
    ],
    [
      'plan_implement_review',
      [
        'Plan and implement the migration to the new payments API in stages',
        'Design and implement a plugin system for the editor',
        '새 결제 API로 단계별 마이그레이션을 계획하고 구현해 줘',
        '알림 기능을 설계하고 구현해 줘',
      ],
    ],
    [
      'bug_fix',
      [
        'Fix the crash on startup; find the root cause first',
        'Uploads fail for large files. Find out why and fix it',
        '앱이 시작할 때 죽는 버그의 원인을 찾아서 고쳐 줘',
        '로그인 후 가끔 흰 화면이 뜨는 버그가 있어. 원인을 찾아서 고쳐 줘',
      ],
    ],
    [
      'parallel_review',
      [
        'Audit the auth module for security issues without changing the code',
        'Review the payment service code for correctness and security; do not modify anything',
        '인증 모듈 코드를 수정하지 말고 보안 관점에서 리뷰해 줘',
        '이 브랜치의 변경을 정확성과 보안 측면에서 검토해 줘',
      ],
    ],
    [
      'tech_decision',
      [
        'Decide between Redux and Zustand for state management',
        'Should we choose Kafka or SQS? Recommend one',
        'Redux와 Zustand 중 무엇을 쓸지 결정해 줘',
        '배포 도구로 GitHub Actions와 Jenkins 중 하나를 골라 줘',
        // Two alternatives named by their endings (-ㄹ지 … -ㄹ지), with no word for "or".
        '상태 관리를 Redux로 유지할지 Zustand로 바꿀지 결정해 줘',
      ],
    ],
  ];

  it('one open question is not a choice between two options', () => {
    // A single "-ㄹ지" asks how or whether, and a noun ending in 지 is not an alternative.
    expect(shape('캐시를 어떻게 무효화할지 결정해 줘')).not.toBe('tech_decision');
    expect(shape('현재 구조를 유지하는 방안을 추천해 줘')).not.toBe('tech_decision');
  });

  it.each(table)('%s', (pattern, goals) => {
    for (const goal of goals) expect(shape(goal), goal).toBe(pattern);
  });

  it('a bug-fix goal gets the template’s roles and criteria, and parses', () => {
    const goal = '로그인 후 가끔 흰 화면이 뜨는 버그가 있어. 원인을 찾아서 고쳐 줘';
    const suggested = planFromGoal(goal, wording);
    expect(suggested && TeamPlan.safeParse(suggested).success).toBe(true);
    expect(suggested).toMatchObject({
      pattern: 'bug_fix',
      name: '로그인 후 가끔 흰 화면이 뜨는 버그가 있어',
      brief: goal,
      criteria: ['The bug_fix criterion.'],
      reviewRounds: 2,
      finalApproval: false,
    });
    expect(suggested?.roles).toEqual([
      { slot: 'investigate', name: 'investigate name', duty: 'Do investigate.' },
      { slot: 'fix', name: 'fix name', duty: 'Do fix.' },
      { slot: 'review', name: 'review name', duty: 'Do review.' },
    ]);
    if (!suggested) throw new Error('expected a plan');
    expect(changing(draftFromPlan(suggested, 'bug_1', labels).definition)).toEqual(['fix']);
  });

  it('no suggested plan waits for approval, whatever its pattern', () => {
    expect(planFromGoal('Decide between Redux and Zustand', wording)).toMatchObject({
      pattern: 'tech_decision',
      finalApproval: false,
    });
    expect(planFromGoal('Write a launch note for the new export', wording)?.finalApproval).toBe(
      false,
    );
    expect(
      planFromGoal('Review the API code for correctness; report findings only', wording),
    ).toMatchObject({
      pattern: 'parallel_review',
      finalApproval: false,
    });
    expect(
      planFromGoal('Review the API code for correctness; report findings only', wording),
    ).not.toHaveProperty('reviewRounds');
    expect(planFromGoal('Implement a CSV export', wording)?.finalApproval).toBe(false);
  });

  it('keeps the security PR review as its own recognized task', () => {
    const security = {
      ...wording,
      securityReview: {
        name: 'Security PR review',
        roles: {
          researcher: { name: 'Security reviewer', duty: 'Review the PR for security issues.' },
          writer: { name: 'Findings author', duty: 'Write the findings.' },
          reviewer: { name: 'Independent verifier', duty: 'Verify each finding.' },
        },
        criteria: { evidence: 'Evidence.', verification: 'Verified.', approval: 'Approve.' },
      },
    };
    const goal =
      'Review a pull request for security issues, then have a second agent double check the findings and write a summary for me to approve';
    expect(planFromGoal(goal, security)).toMatchObject({
      name: 'Security PR review',
      pattern: 'research_write_review',
    });
  });

  it('without the templates’ wording it picks among the three earlier patterns, as before', () => {
    const { templates: _, ...base } = wording;
    for (const [, goals] of table)
      for (const goal of goals)
        expect(['single', 'write_review', 'research_write_review'], goal).toContain(
          shape(goal, base),
        );
  });
});
