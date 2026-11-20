import {
  type CorralDefinition,
  CorralDefinition as Definition,
  hasReviewLoop,
  isWorkAgent,
  TEAM_PATTERNS,
  TEAM_SLOTS,
  type TeamPattern,
  TeamPlan,
} from '@corral/contracts';
import { describe, expect, it } from 'vitest';
import {
  compileDefinition,
  draftFromPlan,
  isReadOnlyTeam,
  isTemplatePattern,
  PATTERN_TEMPLATES,
  planAfterModel,
  planFromGoal,
  planRun,
  planWithPattern,
  ROLE_PRESETS,
  ROLE_RULES,
  type RolePresetId,
  TEAM_TEMPLATE_ROLES,
  type TeamTemplateWording,
  type TeamWording,
  type TemplatePattern,
  teamTemplate,
} from '../src/index.ts';

// Drafting a team from a goal picks one of eleven patterns (docs/specs/features/library.md). The
// eight that are library templates build through the template, so a drafted team and the template
// of the same name differ only in wording.

const TEMPLATE_PATTERNS = Object.keys(PATTERN_TEMPLATES) as TemplatePattern[];
const labels = {
  loop: 'Review loop',
  decision: 'Review decision',
  verifyLoop: 'Verification loop',
  verifyDecision: 'Verification decision',
  join: 'Join',
  output: 'Output',
};

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
  ...(hasReviewLoop(pattern) ? { reviewRounds: 3 } : {}),
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

/** Everything a plan may word: names, brief, criteria, seat duties, labels, rounds, approval. */
function structure(definition: CorralDefinition) {
  return {
    ...definition,
    name: '',
    input: { ...definition.input, brief: '', criteria: [] },
    roles: definition.roles.map((role) => ({ ...role, name: '' })),
    nodes: definition.nodes.map((node) => {
      const unlabeled = { ...node, label: '' };
      if (isWorkAgent(unlabeled)) return { ...unlabeled, stepInstruction: '' };
      if (unlabeled.type === 'loop') return { ...unlabeled, maxIterations: 0 };
      if (unlabeled.type === 'output') return { ...unlabeled, requireApproval: false };
      return unlabeled;
    }),
  };
}

const FILE_CHANGES = ['write_file', 'delete_file', 'move_file'] as const;
const COMMANDS = ['run_command', 'preview_action'] as const;
const holding = (definition: CorralDefinition, tools: readonly string[]) =>
  definition.roles
    .filter((role) => role.allowedWorkTools.some((tool) => tools.includes(tool)))
    .map((role) => role.id);
const changing = (definition: CorralDefinition) => holding(definition, FILE_CHANGES);

it.each(TEAM_PATTERNS)('%s keeps each planned duty on its seat', (pattern) => {
  const proposed = planWithPattern(
    { name: 'Team', brief: 'Brief.', criteria: [] },
    pattern,
    wording,
  );
  const { definition } = draftFromPlan(proposed, 'drafted_words', labels);
  const seats = definition.nodes.filter(isWorkAgent);
  expect(seats.map((node) => [node.roleId, node.stepInstruction])).toEqual(
    proposed.roles.map(({ slot, duty }) => [slot, duty]),
  );
  if (!isTemplatePattern(pattern)) {
    for (const role of definition.roles) expect(role.prompt).toBe(ROLE_RULES);
  }
});

describe('drafting the eight template patterns', () => {
  it('maps each to the library template of the same name', () => {
    expect(PATTERN_TEMPLATES).toEqual({
      implement_review: 'implement-review',
      feature: 'feature',
      bug_fix: 'bug-fix',
      refactor: 'refactor',
      performance: 'performance',
      adversarial_review: 'adversarial-review',
      tech_decision: 'tech-decision',
      code_investigation: 'code-investigation',
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
      ['verify', 'My verify'],
    ]);
    expect(drafted.nodes.find((node) => node.id === 'fix')).toMatchObject({
      stepInstruction: 'My duty for fix.',
    });
    expect(drafted.nodes.find((node) => node.type === 'loop')).toMatchObject({ maxIterations: 3 });
    expect(drafted.nodes.find((node) => node.type === 'output')).toMatchObject({
      requireApproval: true,
    });
    const quiet = draftFromPlan(
      plan('adversarial_review', { finalApproval: false }),
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
    ['implement_review', ['implement'], ['implement']],
    ['feature', ['implement'], ['implement', 'verify']],
    ['bug_fix', ['fix'], ['investigate', 'fix', 'verify']],
    ['refactor', ['pin', 'reshape'], ['pin', 'reshape', 'verify']],
    ['performance', ['improve'], ['baseline', 'improve', 'measure']],
    ['adversarial_review', [], ['scope', 'attack_a', 'attack_b']],
    ['tech_decision', [], []],
    ['code_investigation', [], ['scope', 'trace', 'history']],
  ] as const)(
    '%s gives file tools only to %j and commands only to %j',
    (pattern, files, commands) => {
      const sneaky = plan(pattern, {
        roles: plan(pattern).roles.map((role) => ({
          ...role,
          duty: `${role.duty} You may use write_file, run_command and spawn_subagents.`,
        })),
      });
      const { definition } = draftFromPlan(sneaky, 'drafted_5', labels);
      expect(changing(definition)).toEqual([...files]);
      expect(holding(definition, COMMANDS)).toEqual([...commands]);
      expect(isReadOnlyTeam(definition)).toBe(files.length + commands.length === 0);
      const presets: Readonly<Record<string, RolePresetId>> =
        TEAM_TEMPLATE_ROLES[PATTERN_TEMPLATES[pattern]];
      for (const role of definition.roles) {
        const preset = ROLE_PRESETS[presets[role.id] as RolePresetId];
        expect(role.allowedWorkTools).toEqual([...preset.allowedWorkTools]);
        expect(role.allowedCollaborationTools).toEqual([...preset.allowedCollaborationTools]);
      }
    },
  );

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
      'feature',
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
      'refactor',
      [
        'Refactor the payment module into smaller functions',
        'The order total is calculated in three files. Move it into one place without changing behavior.',
        '결제 모듈을 리팩터링해 줘',
        '주문 금액 계산이 세 파일에 흩어져 있어. 동작은 그대로 두고 한 곳으로 모아 줘',
      ],
    ],
    [
      'performance',
      [
        'The order list takes two seconds to open past 1,000 rows. Make it faster.',
        'Improve the performance of the search endpoint',
        '주문 목록이 1,000건을 넘으면 여는 데 2초가 걸려. 더 빠르게 해 줘',
        '검색 API의 응답 속도를 개선해 줘',
      ],
    ],
    [
      'adversarial_review',
      [
        'Audit the auth module for security issues without changing the code',
        'Review the payment service code for correctness and security; do not modify anything',
        '인증 모듈 코드를 수정하지 말고 보안 관점에서 리뷰해 줘',
        '이 브랜치의 변경을 정확성과 보안 측면에서 검토해 줘',
        'Try to break the changes on this branch and report only what you can show',
        '이 브랜치의 변경을 반증해 줘. 실행해서 보인 문제만 알려 줘',
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
    [
      'code_investigation',
      [
        'Explain how the auth middleware handles sessions',
        'Walk me through how the retry logic in the sync module works',
        '실행 취소가 코드에서 어떻게 처리되는지 설명해 줘',
        '이 모듈이 왜 이런 구조가 됐는지 커밋 기록을 보고 설명해 줘',
      ],
    ],
  ];

  // Words close to a new pattern's that still ask for less work, so the smaller pattern stays.
  it.each([
    ['Rename the `fetchUser` helper to `loadUser` across the repo', 'single'],
    ['이 문단을 빠르게 번역해 줘', 'single'],
    ['Why is the app slow?', 'single'],
    ['Compare the performance of SQLite and PostgreSQL', 'research_write_review'],
    ['Write a design doc for the new export feature', 'write_review'],
    ['Write a report on how we made the search faster', 'write_review'],
    ['Explain what a race condition is', 'single'],
    ['Review the onboarding guide and try to break its examples', 'write_review'],
  ] as const)('%s stays %s', (goal, pattern) => {
    expect(shape(goal)).toBe(pattern);
  });

  // The idea behind a pattern, not one phrasing of it: each group names the pattern by what the
  // goal asks for, and its near misses ask for something smaller or different.
  it.each([
    // A slowdown wants speed back, however it is put: a regression, a number, no "optimize".
    [
      "Checkout got noticeably slower after Tuesday's deploy; get it back to how it was",
      'performance',
    ],
    [
      'Our p99 for the image upload API went from 300 ms to 1.2 s. Bring it back down.',
      'performance',
    ],
    ['Fix the latency regression in the search endpoint', 'performance'],
    ['대시보드 첫 화면이 지난 업데이트 이후로 두 배는 느려졌어. 원래대로 돌려 줘', 'performance'],
    ['로그인 API 응답이 오래 걸려. 빨리 되게 해 줘', 'performance'],
    ['앱 시작이 업데이트 후로 5초나 걸려. 예전처럼 빨라지게 해 줘', 'performance'],
    [
      'The nightly build went from 8 minutes to 20 minutes after the dependency upgrade',
      'performance',
    ],
    // Asking a part of the software to be fast says by itself that it is slow.
    ['Make the CSV import fast; it chokes on files over 50 MB', 'performance'],
    // Asking why it is slow, or writing about speed, is not a request to make it faster.
    [
      'Why did the search page get slower after the release? Just tell me the likely cause',
      'single',
    ],
    ['어제 배포 후 느려진 원인이 뭘까?', 'single'],
    ['Write a blog post about how we cut the p95 latency in half', 'write_review'],
    ['Is 200 ms p95 good for a search API?', 'single'],
    // When it was seen is not that it got slower; a comparison is not a slowdown.
    ["Measure the search endpoint's latency after the deploy", 'single'],
    ['배포 후 성능을 측정해 줘', 'single'],
    ['Check memory usage after the upgrade', 'single'],
    ['Is Python slower than Go?', 'single'],
    // Getting around faster with a new feature is the feature.
    ['Add keyboard shortcuts to the settings page so I can get around faster', 'implement_review'],
  ] as const)('a speed goal: %s is %s', (goal, pattern) => {
    expect(shape(goal)).toBe(pattern);
  });

  it.each([
    // How a part of the code works, or why it is that way, even when written up as a document.
    [
      'How does the job scheduler decide which worker gets a task, and why does it skip retries on weekends? Put the answer in a short doc for the team',
      'code_investigation',
    ],
    [
      'Document how the config parser resolves environment overrides and why it reads files in that order',
      'code_investigation',
    ],
    [
      'Write a guide for new hires explaining how the billing module computes proration',
      'code_investigation',
    ],
    [
      '알림 발송 로직이 어떤 순서로 실행되는지, 왜 그렇게 짜였는지 조사해서 문서로 정리해 줘',
      'code_investigation',
    ],
    [
      '동기화 큐가 실패한 작업을 어떻게 다시 넣는지, 그리고 왜 최대 다섯 번까지만 시도하는지 커밋 기록까지 보고 써 줘',
      'code_investigation',
    ],
    [
      'How does our rate limiter count requests across instances, and why does it use Redis for that?',
      'code_investigation',
    ],
    // A short answer about one piece of code, or a general question, is one agent's answer.
    ['Explain this function in one sentence', 'single'],
    ['이 메서드가 하는 일을 간단히 설명해 줘', 'single'],
    ['Explain how a hash map works', 'single'],
    ['Write a user guide explaining how to export reports', 'write_review'],
  ] as const)('a goal about existing code: %s is %s', (goal, pattern) => {
    expect(shape(goal)).toBe(pattern);
  });

  it.each([
    // Trying to make finished work fail, and keeping only what was shown.
    [
      "Find the ways this upload handler can corrupt files. Don't fix anything, just show me each one running",
      'adversarial_review',
    ],
    ['Red-team the new session-timeout change: what are its blind spots?', 'adversarial_review'],
    ['새로 넣은 정렬 기능을 부숴 봐. 고치지 말고 재현되는 것만 알려 줘', 'adversarial_review'],
    [
      '결제 웹훅 핸들러가 중복 처리로 꼬일 수 있는 경우를 찾아 줘. 고치지는 마',
      'adversarial_review',
    ],
    [
      'Try to break the new checkout flow and report only failures you can reproduce',
      'adversarial_review',
    ],
    // Finding failures to fix them is a fix; attacking a document is a document's review.
    ['Find the cases where the CSV import fails and fix them', 'bug_fix'],
    ['Find the ways the importer can crash and fix them', 'bug_fix'],
    ['Try to break my argument in this essay', 'write_review'],
    ['이 기획서의 허점을 찾아 줘', 'write_review'],
    // The attack's own word names nothing to attack.
    [
      'Stress-test our pricing assumptions against competitors with sources',
      'research_write_review',
    ],
  ] as const)('a goal to break work: %s is %s', (goal, pattern) => {
    expect(shape(goal)).toBe(pattern);
  });

  it.each([
    // Words that also name things outside code are not code by themselves.
    ['Review the video script without changing anything', 'write_review'],
    ['Review my class notes; don’t edit them', 'write_review'],
    ['Clean up the interview scripts', 'single'],
    // A script named by its job is code.
    ["Try to break the deploy script I just wrote; don't fix it", 'adversarial_review'],
    // "Don't fix anything" asks for no fix; it names no change to attack.
    ["Poke holes in my startup idea; don't fix anything", 'single'],
  ] as const)('code or not: %s is %s', (goal, pattern) => {
    expect(shape(goal)).toBe(pattern);
  });

  it('changes to a document are not finished work to attack', () => {
    expect(shape('Poke holes in the changes to the onboarding guide')).not.toBe(
      'adversarial_review',
    );
  });

  it('a vulnerability (취약점) is not a weak point (약점) to attack', () => {
    expect(shape('이 브랜치 코드의 보안 취약점을 찾아 줘')).not.toBe('adversarial_review');
    expect(shape('이 브랜치 코드의 약점을 찾아 줘')).toBe('adversarial_review');
  });

  it.each([
    // Asking for code to be made, changed or removed needs a seat that writes files.
    ['Break this function into smaller pieces', 'refactor'],
    ['이 함수를 더 작은 함수 여러 개로 쪼개 줘', 'refactor'],
    ['Add a test for the case where the request will fail', 'implement_review'],
    ['주문 API가 실패할 수 있는 경우를 처리하는 코드를 추가해 줘', 'implement_review'],
    ['허점 없이 가입 양식 검증을 구현해 줘', 'implement_review'],
    ['함수에 설명 주석을 달아 줘', 'single'],
    ['Add an option to select the export format', 'implement_review'],
    ['두 가지 옵션을 모두 선택하면 폼이 죽는 버그를 고쳐 줘', 'bug_fix'],
    // A change the goal describes, or one it asks whether to make, asks for none.
    ['This PR adds a retry queue. Try to break it', 'adversarial_review'],
    ['Red-team the latest update to the billing module', 'adversarial_review'],
    ['새로 구현한 정렬 함수를 깨뜨려 봐', 'adversarial_review'],
    ['Should we add Redis or a CDN in front of the API? Recommend one', 'tech_decision'],
    // Making a written deliverable is not a change to the code.
    ['Should we choose Kafka or SQS? Recommend one and add a short rationale', 'tech_decision'],
    ['Decide between Redux and Zustand. Create a comparison table.', 'tech_decision'],
    ['Redux와 Zustand 중 무엇을 쓸지 결정해 줘. 비교 표도 만들어 줘', 'tech_decision'],
  ] as const)('a change asked of the code: %s is %s', (goal, pattern) => {
    expect(shape(goal)).toBe(pattern);
  });

  it.each([
    ['Write tests for the edge cases that could crash the importer', 'adversarial_review'],
    ['Review the payment module for correctness and fix what you find', 'adversarial_review'],
    ['Delete the unused handler and explain why it existed', 'code_investigation'],
    ['Write a docstring explaining how the parser handles errors', 'code_investigation'],
    [
      'Explain how the session cache evicts entries, then rewrite it to use LRU',
      'code_investigation',
    ],
    // Splitting a PR or a commit reshapes the change, not the code.
    ['Split this PR into smaller PRs', 'refactor'],
    ['이 커밋을 여러 개로 쪼개 줘', 'refactor'],
  ] as const)('a change asked of the code: %s is not %s', (goal, pattern) => {
    expect(shape(goal)).not.toBe(pattern);
  });

  it.each([
    // A resource or a speed named in an ordinary change is not a slowdown.
    '프로그램을 개선해 줘',
    '텔레그램 알림 연동을 고쳐 줘',
    '프로그램 설정 화면의 오타를 수정해 줘',
    'Fix the Dockerfile so the container image builds',
    'Fix the memory settings page layout',
    'Fix the upload limit so files over 10 MB are rejected',
    '업로드 용량 제한을 10MB로 수정해 줘',
    '배송 지연 안내 문구를 수정해 줘',
    'Make the page responsive',
    'Improve the error messages on the performance dashboard',
    // A size that is a limit's value, or a speed word naming a UI part, is not a resource.
    'The 10 MB upload limit is too large; lower it to 5 MB',
    '업로드 용량 제한이 너무 커. 5MB로 낮춰 줘',
    '로딩 스피너를 작게 해 줘',
  ])('names no slowdown: %s is not performance', (goal) => {
    expect(shape(goal)).not.toBe('performance');
  });

  it.each([
    // An explicit refactoring stays one, whatever else it mentions.
    ['Refactor the slow report module to improve readability', 'refactor'],
    // A speed or a resource that should come down, said outright.
    ['Reduce the latency of the search endpoint', 'performance'],
    ['번들 크기를 줄여 줘', 'performance'],
    ['램 사용량이 너무 많아. 줄여 줘', 'performance'],
    ['Fix the slow checkout query', 'performance'],
    // Running out of memory or spiking the CPU says it is heavy; a leak is a bug.
    ['The server runs out of memory under load; fix it', 'performance'],
    ['CPU usage spikes to 100% on every deploy; investigate and fix it', 'performance'],
    ['메모리 누수를 고쳐 줘', 'bug_fix'],
    ['앱 용량이 너무 커졌어. 줄여 줘', 'performance'],
  ] as const)('a speed or size said outright: %s is %s', (goal, pattern) => {
    expect(shape(goal)).toBe(pattern);
  });

  it.each([
    // A concept, a why-only question, or a plea for help is not tracing existing code.
    ['Explain what a pure function is', 'single'],
    ['Explain the difference between a library and a framework', 'single'],
    ['How do webhooks work?', 'single'],
    ['Explain how React components work', 'single'],
    ['순수 함수가 뭔지 설명해 줘', 'single'],
    ['코드 리뷰가 왜 필요한지 설명해 줘', 'single'],
    ['이 코드가 왜 안 되는지 모르겠어. 봐 줘', 'single'],
    // A code word that is also history's, research about other projects, or a story about the
    // team names no part of this code to trace.
    ['Explain what a commit is', 'single'],
    ['커밋과 브랜치의 차이를 설명해 줘', 'single'],
    [
      'Investigate how other open-source projects handle plugin sandboxing and write a summary with sources',
      'research_write_review',
    ],
    ['Write a blog post about how we migrated the repo to pnpm', 'write_review'],
    ['Investigate the flaky test in the order module', 'research_write_review'],
    ['How do I write a commit message?', 'write_review'],
    // Tracing a part of the code, or writing down why it is so, is.
    ['Trace how a request flows through the API gateway middleware', 'code_investigation'],
    ['Document why the config loader reads files in that order', 'code_investigation'],
    ['Explain how session expiry is handled in the auth module', 'code_investigation'],
    ['Explain how the auth middleware adds the session cookie', 'code_investigation'],
    ['Write up how session tokens get refreshed by our auth middleware', 'code_investigation'],
    ['Explain the git history of the auth module', 'code_investigation'],
  ] as const)('a question near the code: %s is %s', (goal, pattern) => {
    expect(shape(goal)).toBe(pattern);
  });

  it.each([
    // Lighter is performance too: a resource that grew too large and should come down.
    ["The dashboard's memory use climbs past 2 GB after an hour; bring it down", 'performance'],
    ['Our JS bundle is 4 MB now. Make it smaller.', 'performance'],
    ['The worker pegs the CPU at 100% while idle; make it use less', 'performance'],
    ['앱 번들 크기가 너무 커졌어. 줄여 줘', 'performance'],
    ['로그 때문에 서버 디스크 용량이 금방 차. 덜 쓰게 해 줘', 'performance'],
    ['Our Docker image is 2 GB; make it smaller', 'performance'],
    // Asking how much it uses, or only why, or writing about it, asks for nothing lighter.
    ['How much memory does the indexer use?', 'single'],
    ['메모리 사용량이 왜 이렇게 큰지 원인만 알려 줘', 'single'],
    ['Write a report on how we halved our memory footprint', 'write_review'],
    ['Reduce the number of steps in the signup form', 'single'],
  ] as const)('a lighter goal: %s is %s', (goal, pattern) => {
    expect(shape(goal)).toBe(pattern);
  });

  it.each([
    // Merging or tidying duplicated code while the behavior is held, however that is worded.
    ['중복된 날짜 변환 코드를 한 곳으로 합쳐 줘. 동작이 바뀌면 안 돼', 'refactor'],
    ['주문 검증 로직이 세 군데에 복사돼 있어. 정리해 줘, 결과가 달라지면 안 됨', 'refactor'],
    ['알림 모듈의 중복 함수들을 정리해 줘. 동작은 지금과 똑같아야 해', 'refactor'],
    [
      'Merge the three copies of the retry helper into one module; it must not change behavior',
      'refactor',
    ],
    ['Deduplicate the validation code in the checkout flow, keeping every test green', 'refactor'],
    ['Pull the duplicated price rounding into one helper; no behavior changes', 'refactor'],
    // Writing about behavior, finding duplicates without changing them, or a feature with tests.
    ['동작이 바뀌면 안 되는 이유를 문서로 정리해 줘', 'write_review'],
    ["Find where the validation code is duplicated, but don't change anything", 'single'],
    ['Add an export button to the reports page; every test must still pass', 'implement_review'],
  ] as const)('a behavior-kept tidy-up: %s is %s', (goal, pattern) => {
    expect(shape(goal)).toBe(pattern);
  });

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
      { slot: 'verify', name: 'verify name', duty: 'Do verify.' },
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
      pattern: 'adversarial_review',
      finalApproval: false,
    });
    expect(
      planFromGoal('Review the API code for correctness; report findings only', wording),
    ).not.toHaveProperty('reviewRounds');
    expect(planFromGoal('Implement a CSV export', wording)?.finalApproval).toBe(false);
  });

  const security: TeamWording = {
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

  it('keeps the security PR review as its own recognized task', () => {
    const goal =
      'Review a pull request for security issues, then have a second agent double check the findings and write a summary for me to approve';
    expect(planFromGoal(goal, security)).toMatchObject({
      name: 'Security PR review',
      pattern: 'research_write_review',
    });
  });

  it.each([
    'Security review of this PR',
    'Security review of the PR. Do not change anything.',
    '보안 관점에서 PR을 검토해 줘. 고치지는 마',
  ])(
    'a security PR review is the recognized task whether or not it forbids changes: %s',
    (goal) => {
      expect(planFromGoal(goal, security)).toMatchObject({
        name: 'Security PR review',
        pattern: 'research_write_review',
      });
    },
  );

  it('a PR review for correctness as well as security is a review of the code', () => {
    expect(
      planFromGoal('Review this PR for correctness and security; do not change anything', security)
        ?.pattern,
    ).toBe('adversarial_review');
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

it('keeps requested artifact advice outside the work sequence', () => {
  const proposed = planFromGoal(
    'Let the writer ask for manuscript review when needed and revise it before submitting.',
    wording,
  );
  if (!proposed) throw new Error('expected a plan');
  expect(proposed.pattern).toBe('single');
  const { definition } = draftFromPlan(proposed, 'requested_review', labels);
  expect(definition.sharedOutrider).toMatchObject({
    targets: { kind: 'all' },
    artifactReview: true,
  });
  expect(compileDefinition(definition).ok).toBe(true);
  expect(definition.nodes.map((step) => step.type)).toEqual(['agent', 'output']);
  expect(definition.roles).toHaveLength(1);
});

it.each([
  ['작업자가 직접 고쳐 제출', undefined],
  ['모두가 필요할 때 전문가에게 물어보게 해줘', 'consultation'],
  ['작성자가 원고 리뷰를 요청할 수 있게', 'artifact_review'],
  ['리뷰 후 제출', 'clarify_review'],
  ['매 제출 전 반드시 통과', 'required_review'],
] as const)('keeps authorship and review policy distinct for %s', (goal, policy) => {
  const proposal = planFromGoal(goal, wording);
  expect(proposal?.outrider).toBe(policy);
  expect(proposal?.pattern).toBe('single');
});

it.each([
  '작성자가 필요할 때만 전문가에게 자문한다. 검토 통과나 자동 관찰은 필요 없다.',
  'The writer consults an expert when needed. No review pass or automatic observation is needed.',
  'Let the writer ask for advice on demand; passing review and automatic observation are not required.',
])('keeps negated review and observation out of both goal-draft paths: %s', (goal) => {
  const local = planFromGoal(goal, wording);
  expect(local).toMatchObject({ pattern: 'single', outrider: 'consultation' });
  if (!local) throw new Error('Expected a local plan');
  expect(local).not.toHaveProperty('observeWork');
  const proposed: TeamPlan = { ...local, name: 'Model writer', outrider: 'consultation' };
  expect(planAfterModel(goal, proposed, wording)).toEqual({ plan: proposed, recovery: null });
  const { definition } = draftFromPlan(proposed, 'advice', labels);
  expect(definition.nodes.map((node) => node.type)).toEqual(['agent', 'output']);
  expect(definition.sharedOutrider).not.toHaveProperty('observation');
  expect(definition.sharedOutrider).not.toHaveProperty('artifactReview');
});

it('does not negate independently requested manuscript feedback or work observation', () => {
  expect(
    planFromGoal(
      'Ask for manuscript feedback when needed. No review pass is needed. Watch work in progress.',
      wording,
    ),
  ).toMatchObject({ pattern: 'single', outrider: 'artifact_review', observeWork: true });
  expect(planFromGoal('Write the note. A review pass is not required.', wording)).toMatchObject({
    pattern: 'single',
  });
  const noGate = 'Write the note. A review pass is not required.';
  const proposed = planFromGoal('Write and review a note.', wording);
  expect(planAfterModel(noGate, proposed, wording)).toMatchObject({
    plan: { pattern: 'single' },
    recovery: 'incompatible',
  });
});

describe('work observation in a goal draft', () => {
  it('preserves explicit work observation even when the model omits it or its response needs local recovery', () => {
    const goal = 'Let the writer ask for feedback when needed and watch work in progress.';
    const local = planFromGoal(goal, wording);
    if (!local) throw new Error('Expected a suggestion');
    const { observeWork: _omitted, ...model } = local;
    expect(planAfterModel(goal, model, wording)).toMatchObject({
      plan: { observeWork: true, outrider: 'artifact_review' },
      recovery: null,
    });
    expect(planAfterModel(goal, null, wording)).toMatchObject({
      plan: { observeWork: true, outrider: 'artifact_review' },
      recovery: 'unusable',
    });
    expect(planAfterModel('Watch work in progress.', null, wording)).toMatchObject({
      plan: { observeWork: true },
      recovery: 'unusable',
    });
  });

  it.each([
    ['진행 중 자동 관찰을 켜고 작성자가 원고 리뷰를 요청할 수 있게', 'artifact_review'],
    ['자동 관찰을 켜 줘.', undefined],
    ['작업자들을 주기적으로 관찰해 줘.', undefined],
    ['Automatically monitor the workers as they work.', undefined],
    ['Let the Outrider watch work in progress.', undefined],
  ] as const)('adds an independent observation proposal for %s', (goal, outrider) => {
    const suggested = planFromGoal(goal, wording);
    expect(suggested?.observeWork).toBe(true);
    expect(suggested?.outrider).toBe(outrider);
    if (!suggested) throw new Error('Expected a suggestion');
    for (const proposal of [suggested, planWithPattern(suggested, 'bug_fix', wording)]) {
      const draft = draftFromPlan(TeamPlan.parse(proposal), 'observe_goal', labels);
      expect(draft.definition.sharedOutrider).toMatchObject({
        targets: { kind: 'all' },
        observation: { targets: { kind: 'all' }, review: { interval: 3, maxRequestsPerReview: 8 } },
      });
      expect(
        draft.definition.nodes.some(
          (node) => node.type === 'agent' && node.invocation === 'observer',
        ),
      ).toBe(false);
    }
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
    const suggested = planFromGoal(goal, wording);
    if (!suggested) throw new Error('Expected a suggestion');
    expect(suggested).not.toHaveProperty('observeWork');
    expect(
      draftFromPlan(suggested, 'goal', labels).definition.sharedOutrider?.observation,
    ).toBeUndefined();
  });
});

it('preserves an explicitly required gate for confirmation when a model supplies a different or unusable policy', () => {
  const goal = 'Write an invitation. The result must pass review before submitting.';
  const plan = planFromGoal(goal, wording);
  if (!plan) throw Error('No local draft');
  const proposed = { ...plan, name: 'Model invitation', outrider: 'artifact_review' as const };
  expect(planAfterModel(goal, proposed, wording).plan).toMatchObject({
    name: 'Model invitation',
    outrider: 'required_review',
  });
  expect(planAfterModel(goal, null, wording)).toMatchObject({
    plan: { outrider: 'required_review' },
    recovery: 'unusable',
  });
});
