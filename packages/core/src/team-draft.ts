import {
  type CorralDefinition,
  DEFAULT_ADVISOR_REVIEW,
  DEFAULT_LIMITS,
  hasReviewLoop,
  type PatternSlot,
  TEAM_LIMITS,
  TEAM_SLOTS,
  type TeamPattern,
  type TeamPlan,
} from '@corral/contracts';
import { rolePrompt } from './role-prompt.ts';
import {
  type RoleWording,
  type TeamTemplateId,
  type TeamTemplateWording,
  teamTemplate,
} from './team-templates.ts';

// goal → team plan → Corral. The local suggestion reads the goal's words; the plan
// becomes a definition whose tools, bindings, Loop ports and limits are fixed by the pattern.

export { rolePrompt };

/** The three patterns drafted here; auto mode uses their shapes. */
export type BasePattern = 'single' | 'write_review' | 'research_write_review';
type BaseSlot = PatternSlot<BasePattern>;
/** The five patterns that are the library templates of the same name. */
export type TemplatePattern = Exclude<TeamPattern, BasePattern>;

export const PATTERN_TEMPLATES: Readonly<Record<TemplatePattern, TeamTemplateId>> = {
  implement_review: 'implement-review',
  plan_implement_review: 'plan-implement-review',
  bug_fix: 'bug-fix',
  parallel_review: 'parallel-review',
  tech_decision: 'tech-decision',
};

export const isTemplatePattern = (pattern: TeamPattern): pattern is TemplatePattern =>
  pattern in PATTERN_TEMPLATES;

/** A template pattern's words: its roles by slot and its default criteria. */
export interface PatternWording<P extends TemplatePattern = TemplatePattern> {
  roles: Record<PatternSlot<P>, RoleWording>;
  criteria: readonly string[];
}

/** Words the local suggestion uses, from the Studio's messages (`TeamDraft.wording`). */
export interface TeamWording {
  roles: Record<BaseSlot, { name: string; duty: string }>;
  /** Default criteria: answer the brief; name sources (used by the review patterns). */
  criteria: { direct: string; sources: string };
  /** Labels of the steps the pattern adds. */
  labels: TeamLabels;
  /** Recognized local task: inspect evidence, write findings, independently verify. */
  securityReview?: {
    name: string;
    roles: Pick<TeamWording['roles'], 'researcher' | 'writer' | 'reviewer'>;
    criteria: { evidence: string; verification: string; approval: string };
  };
  /**
   * The template patterns' words, from the library templates (`TeamTemplates`). Without them
   * the local suggestion picks among the three base patterns only.
   */
  templates?: { [P in TemplatePattern]: PatternWording<P> };
}

export interface TeamLabels {
  loop: string;
  decision: string;
  output: string;
  outriderPrinciples?: string;
  /** The Join where the parallel patterns' branches meet. */
  join?: string;
}

const DEFAULT_OUTRIDER_PRINCIPLES =
  'Check the evidence against the requested result and suggest concrete corrections.';

const ENGLISH_LABELS: TeamLabels = {
  loop: 'Review loop',
  decision: 'Review decision',
  output: 'Output',
  join: 'Join',
};

export interface TeamDraft {
  definition: CorralDefinition;
}

const RESEARCH =
  /\b(research\w*|compar\w*|investigat\w*|analy[sz]\w*|survey\w*|evaluat\w*|assess\w*|sources?|market|benchmark\w*)\b|조사|비교|분석|리서치|자료|출처|평가|시장/i;
const WRITING =
  /\b(write|writing|draft\w*|report\w*|article\w*|essay\w*|post|announcement\w*|proposal\w*|document\w*|blog\w*|summar\w*|e-?mail\w*|letter\w*|review\w*|plan)\b|작성|글|보고서|문서|안내문|제안서|기획|요약|검토|이메일|편지/i;

const SECURITY = /\b(security|vulnerabilit\w*)\b|보안|취약점/i;
const PULL_REQUEST = /\b(pull[ -]?request|pr)\b|풀\s*리퀘스트|풀\s*리퀘/i;
const REVIEW = /\b(review\w*|check\w*|audit\w*)\b|검토|검사|확인|점검/i;
const SUGGESTED_NAME_LENGTH = 48;

// The template patterns, reached only from words that leave little doubt.
const REVIEW_CODE = /\b(review\w*|audit\w*|inspect\w*)\b|검토|리뷰|점검/i;
const CODE =
  /\b(code|codebase|prs?|pull[ -]?requests?|diffs?|branch\w*|commits?|modules?|middleware|functions?|endpoints?|implementation|repo\w*|librar\w*|components?|handlers?)\b|코드|브랜치|커밋|모듈|함수|미들웨어|구현|엔드포인트|라이브러리|컴포넌트/i;
const NO_CHANGE =
  /\b(without (chang|modif|edit|touch|fix)\w*|(don['’]?t|do not|never) (change|modify|edit|touch|fix)\w*|read[- ]only|findings only|only report\w*|report (the )?findings|no (changes|edits|fixes))\b|고치지\s*말|수정하지\s*말|바꾸지\s*말|변경하지\s*말|건드리지\s*말|손대지\s*말|읽기\s*전용/i;
const CORRECTNESS = /\b(correctness|logic errors?)\b|정확성|논리\s*오류/i;
const BUG =
  /\b(bugs?|crash\w*|errors?|exceptions?|fail\w*|broken|regressions?|flaky|intermittent\w*|timeouts?|hangs?|freez\w*|leaks?)\b|버그|오류|에러|장애|크래시|죽는|죽어|깨지|깨져|실패|안\s?되|멈추|멈춰|타임아웃|먹통/i;
const FIX = /\b(fix\w*|repair\w*|resolv\w*|patch\w*)\b|고쳐|고치|수정해|해결/i;
const DECISION =
  /\b(decid\w*|decisions?|choos\w*|chose|pick|select|which (one|option|is better)|should (we|i)|recommend\w*|trade-?offs?)\b|결정|선택|고를|고르|골라|할지|추천|권해|권하/i;
const OPTIONS =
  /\b(between|or|vs\.?|versus|both|options?|alternatives?|either)\b|중\s*(에|에서)?\s*(무엇|어느|뭘|뭐|하나|어떤)|아니면|두\s*(안|가지|방안|옵션|후보)|둘\s*중|대신/i;
/** Korean names two alternatives by their endings alone: "유지할지 바꿀지". */
function twoAlternatives(brief: string) {
  let count = 0;
  for (const match of brief.matchAll(/([가-힣])지(?![가-힣])/g)) {
    // A syllable that ends in ㄹ: its final-consonant index is 8.
    if (((match[1]?.charCodeAt(0) ?? 0) - 0xac00) % 28 === 8) count += 1;
  }
  return count >= 2;
}
const IMPLEMENT =
  /\b(implement\w*|add|adds|adding|build|builds|building|develop|developing|introduce|integrat\w*|refactor\w*)\b|구현|추가|개발|도입|연동|리팩터|리팩토링/i;
const PLAN_FIRST =
  /\b(plan\w*|design\w*|migrat\w*|stages?|staged|step[- ]by[- ]step|phases?|phased|incremental\w*|roadmap|architect\w*)\b|설계|계획|마이그레이션|이관|옮기|옮겨|단계|아키텍처/i;
const DOCUMENT =
  /\b(documents?|docs?|manuscripts?|reports?|articles?|essays?|posts?|announcements?|proposals?|blogs?|e-?mails?|letters?|memos?|newsletters?|readme|faq|slides?|decks?|guides?|manuals?)\b|안내문|보고서|문서|원고|제안서|기획서|이메일|편지|공지|슬라이드|가이드|매뉴얼/i;
/** Writing a document: never a code pattern, whatever the document is about. */
const WRITE = /\b(write|writing|draft\w*|summar\w*)\b|작성|써\s*줘|써줘|요약/i;
const SOFTWARE =
  /\b(pages?|screens?|forms?|buttons?|toggles?|apps?|features?|cach\w*|database|db|tests?|settings|ui|cli|validation|login|sign[- ]?up|export|import|search)\b|화면|양식|폼|버튼|토글|앱|기능|캐시|데이터베이스|테스트|설정|로그인|가입|내보내기|검색/i;

const isSecurityReview = (brief: string) =>
  SECURITY.test(brief) && PULL_REQUEST.test(brief) && REVIEW.test(brief);

/** The choice among the three base patterns; auto mode's local rule. */
export function basePatternFromGoal(goal: string): BasePattern {
  const brief = goal.trim();
  return isSecurityReview(brief) || RESEARCH.test(brief)
    ? 'research_write_review'
    : WRITING.test(brief)
      ? 'write_review'
      : 'single';
}

function templatePatternFromGoal(brief: string): TemplatePattern | null {
  const keepsCode = NO_CHANGE.test(brief);
  if (REVIEW_CODE.test(brief) && CODE.test(brief) && (keepsCode || CORRECTNESS.test(brief)))
    return 'parallel_review';
  // A security PR review is a recognized task of its own (docs/specs/features/canvas.md).
  if (isSecurityReview(brief)) return null;
  if (DECISION.test(brief) && (OPTIONS.test(brief) || twoAlternatives(brief)))
    return 'tech_decision';
  const document = DOCUMENT.test(brief);
  if (
    document &&
    (WRITE.test(brief) || (!CODE.test(brief) && !SOFTWARE.test(brief) && FIX.test(brief)))
  )
    return null;
  // Fixing changes code; finding a cause without fixing it is research.
  if (BUG.test(brief) && FIX.test(brief) && !keepsCode) return 'bug_fix';
  if (IMPLEMENT.test(brief) && !(document && !SOFTWARE.test(brief)))
    return PLAN_FIRST.test(brief) ? 'plan_implement_review' : 'implement_review';
  return null;
}

function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max - 1);
  const space = head.lastIndexOf(' ');
  return `${(space > max / 2 ? head.slice(0, space) : head).trimEnd()}…`;
}

/** A pattern's roles and settings in the given words; criteria are its defaults. */
function patternParts(
  pattern: TeamPattern,
  wording: TeamWording,
): Pick<TeamPlan, 'criteria' | 'roles' | 'reviewRounds' | 'finalApproval'> {
  const rounds = hasReviewLoop(pattern) ? { reviewRounds: 2 } : {};
  if (!isTemplatePattern(pattern)) {
    const slots: readonly BaseSlot[] = TEAM_SLOTS[pattern];
    return {
      criteria:
        pattern === 'single'
          ? [wording.criteria.direct]
          : [wording.criteria.direct, wording.criteria.sources],
      roles: slots.map((slot) => ({ slot, ...wording.roles[slot] })),
      ...rounds,
      finalApproval: false,
    };
  }
  const words = wording.templates?.[pattern] as PatternWording | undefined;
  if (!words) throw new Error(`no wording for the ${pattern} pattern`);
  const roles = words.roles as Readonly<Record<string, RoleWording | undefined>>;
  return {
    criteria: [...words.criteria],
    roles: TEAM_SLOTS[pattern].map((slot) => {
      const named = roles[slot];
      if (!named) throw new Error(`the ${pattern} wording has no ${slot}`);
      return { slot, name: named.name, duty: named.duty };
    }),
    ...rounds,
    finalApproval: false,
  };
}

/**
 * The plan with another pattern: its roles, settings and criteria become the pattern's defaults,
 * its name and brief stay. `keepCriteria` keeps criteria the person wrote by hand.
 */
export function planWithPattern(
  plan: Pick<TeamPlan, 'name' | 'brief' | 'criteria' | 'outrider' | 'observeWork'>,
  pattern: TeamPattern,
  wording: TeamWording,
  { keepCriteria = false }: { keepCriteria?: boolean } = {},
): TeamPlan {
  const parts = patternParts(pattern, wording);
  return {
    name: plan.name,
    pattern,
    brief: plan.brief,
    ...(plan.outrider ? { outrider: plan.outrider } : {}),
    ...(plan.observeWork ? { observeWork: true } : {}),
    ...parts,
    criteria: keepCriteria ? [...plan.criteria] : parts.criteria,
  };
}

/** Read explicit advice/review intent before matching the work itself to a pattern. */
function outriderFromGoal(goal: string): TeamPlan['outrider'] {
  const review = /\b(review|feedback|critique|pass)\b|검토|리뷰|피드백|수정 의견|통과/i.test(goal);
  const request =
    /\b(on request|on demand|when needed|when asked|if needed|as needed|ask for|request a|request review|can ask)\b|필요할 때|요청할 수|요청할 때|원할 때|물어볼 수|물어보게|부탁할 수/i.test(
      goal,
    );
  const mustPass =
    /\b(must pass|must be approved by (?:a|the) review|only (?:after|if).{0,32}(?:review|pass)|require.{0,18}review.{0,18}pass)\b|반드시.{0,20}통과|통과해야.{0,15}제출|통과한 뒤에만/i.test(
      goal,
    );
  if (review && mustPass) return 'required_review';
  if (review && request) return 'artifact_review';
  if (
    /\b(review (?:it )?(?:before (?:every )?(?:submitting|submission)|then submit)|submit after review)\b|(?:검토|리뷰)(?:한)? 후 제출/i.test(
      goal,
    )
  )
    return 'clarify_review';
  if (
    request &&
    /\b(experts?|advice|advisors?|consult\w*|outrider)\b|전문가|자문|아웃라이더|Outrider|조언/i.test(
      goal,
    )
  )
    return 'consultation';
  return undefined;
}

/** A request to watch the team's ongoing work, including explicit opt-outs in either locale. */
export function requestsWorkObservation(goal: string): boolean {
  return goal.split(/[.!?;\n]/).some((clause) => {
    const english =
      /\b(?:(?:observe|watch|monitor) (?:the )?work in progress|(?:automatically|periodically) (?:observe|watch|monitor) (?:the |each |all )?(?:workers?|agents?)\b|automatic observation of (?:the )?(?:workers?|work in progress))\b/i;
    const korean =
      /(?:자동\s*관찰(?:을|를)?\s*(?:켜|활성화)|진행\s*중(?:인)?\s*(?:(?:작업|업무)(?:을|를)?\s*)?(?:자동(?:으로)?\s*)?관찰|(?:작업자|에이전트)(?:들의?|들|의)?\s*(?:작업|업무)?(?:을|를)?\s*(?:자동으로|주기적으로)\s*관찰)/;
    const match = english.exec(clause) ?? korean.exec(clause);
    if (!match) return false;
    const before = clause.slice(0, match.index);
    const after = clause.slice(match.index + match[0].length);
    return (
      !/\b(?:never|no|without|not|don't|disable)\s+(?:enable\s+|turn on\s+)?(?:(?:the |any )?(?:outrider|advisor) to )?$/i.test(
        before,
      ) && !/^(?:을|를|은|는)?\s*(?:(?:하)?지\s*(?:않|말|마)|없이|끄|꺼|비활성|금지)/.test(after)
    );
  });
}

/** Keep an independently requested observation setting when accepting a model's other choices. */
export function withWorkObservation(plan: TeamPlan, enabled: boolean): TeamPlan {
  if (Boolean(plan.observeWork) === enabled) return plan;
  if (enabled) return { ...plan, observeWork: true };
  const { observeWork: _unrequested, ...rest } = plan;
  return rest;
}

/** The local suggestion: no model call. Null for an empty goal. */
export function planFromGoal(goal: string, wording: TeamWording): TeamPlan | null {
  const brief = goal.trim();
  if (!brief) return null;
  const outrider = outriderFromGoal(brief);
  const observeWork = requestsWorkObservation(brief);
  const template = wording.templates ? templatePatternFromGoal(brief) : null;
  // An optional review request alone does not add a sequential review to a writing task.
  const selfReview =
    /\b(?:worker|writer|author).{0,34}(?:revise|edit|correct).{0,28}(?:submit|deliver)\b|(?:작업자|작성자).{0,24}직접.{0,18}(?:고쳐|수정).{0,14}제출/i.test(
      brief,
    );
  const pattern: TeamPattern =
    (outrider || selfReview) && !template && !isSecurityReview(brief)
      ? 'single'
      : (template ?? basePatternFromGoal(brief));
  const task =
    pattern === 'research_write_review' && isSecurityReview(brief)
      ? wording.securityReview
      : undefined;
  const firstLine = brief.split('\n')[0]?.replace(/\s+/g, ' ') ?? brief;
  const firstSentence = firstLine.split(/[.!?](?:\s|$)/)[0] || firstLine;
  const parts = patternParts(pattern, wording);
  const worker =
    pattern === 'single' && (selfReview || outrider === 'artifact_review') && WRITING.test(brief)
      ? wording.roles.writer
      : undefined;
  return {
    name: task?.name ?? cut(firstSentence, SUGGESTED_NAME_LENGTH),
    pattern,
    brief: cut(brief, TEAM_LIMITS.brief),
    criteria: (task ? Object.values(task.criteria) : undefined) ?? parts.criteria,
    roles: parts.roles.map((role) => ({
      ...role,
      ...(role.slot === 'worker' && worker ? worker : {}),
      ...(task && role.slot in task.roles ? task.roles[role.slot as keyof typeof task.roles] : {}),
    })),
    ...(parts.reviewRounds === undefined ? {} : { reviewRounds: parts.reviewRounds }),
    finalApproval: parts.finalApproval,
    ...(outrider ? { outrider } : {}),
    ...(observeWork ? { observeWork: true } : {}),
  };
}

/** Explicit task roles take priority over the inferred shape of an advice-only goal. */
function hasExplicitTeamStructure(goal: string): boolean {
  return (
    /\b(?:two|three|four|[2-9])\s+(?:(?:different|distinct|separate)\s+)?(?:agents|roles|workers)\b|(?:두|세|네)\s*(?:명의?|개의?)?\s*(?:역할|작업자|에이전트)/i.test(
      goal,
    ) ||
    /\bone (?:agent|role|worker)\b.*\b(?:another|the other)\b|(?:역할을|작업을)\s*(?:나누|분담)/i.test(
      goal,
    ) ||
    /\b(?:planner|researcher|writer|editor|implementer|tester|reviewer)\b.{0,30}\b(?:and|then)\b.{0,16}\b(?:planner|researcher|writer|editor|implementer|tester|reviewer)\b|(?:기획자|조사자|작성자|편집자|구현자|검토자).{0,18}(?:와|과|다음에|그 뒤).{0,12}(?:기획자|조사자|작성자|편집자|구현자|검토자)/i.test(
      goal,
    )
  );
}

/** The plan Studio can present after a model answer. A local recovery retains its origin. */
export function planAfterModel(
  goal: string,
  proposed: TeamPlan | null,
  wording: TeamWording,
): { plan: TeamPlan | null; recovery: 'incompatible' | 'unusable' | null } {
  const local = planFromGoal(goal, wording);
  if (!proposed && local?.observeWork) return { plan: local, recovery: 'unusable' };
  const modelPlan = proposed && withWorkObservation(proposed, Boolean(local?.observeWork));
  if (
    local?.pattern !== 'single' ||
    (local.outrider !== 'consultation' && local.outrider !== 'artifact_review') ||
    hasExplicitTeamStructure(goal)
  )
    return { plan: modelPlan, recovery: null };

  if (proposed?.pattern === 'single' && proposed.outrider === local.outrider)
    return { plan: modelPlan, recovery: null };
  return { plan: local, recovery: proposed ? 'incompatible' : 'unusable' };
}

const CONTRACT: Record<BaseSlot, CorralDefinition['roles'][number]['outputContract']> = {
  worker: 'draft',
  planner: 'notes',
  researcher: 'notes',
  writer: 'draft',
  reviewer: 'review',
};

/**
 * A template pattern as its library template: structure and tools from the template, the words
 * from the plan. Review rounds and the final approval follow the plan where the pattern lets it.
 */
function templateDraft(
  plan: TeamPlan,
  pattern: TemplatePattern,
  corralId: string,
  labels: TeamLabels,
): CorralDefinition {
  const definition = teamTemplate(PATTERN_TEMPLATES[pattern], corralId, {
    name: plan.name,
    brief: plan.brief,
    criteria: plan.criteria,
    roles: Object.fromEntries(
      plan.roles.map(({ slot, name, duty }) => [slot, { name, duty }]),
    ) as TeamTemplateWording['roles'],
    labels: {
      loop: labels.loop,
      decision: labels.decision,
      join: labels.join ?? 'Join',
      output: labels.output,
    },
  });
  return {
    ...definition,
    nodes: definition.nodes.map((node) => {
      if (node.type === 'loop' && plan.reviewRounds !== undefined)
        return { ...node, maxIterations: plan.reviewRounds };
      if (node.type === 'output') return { ...node, requireApproval: plan.finalApproval };
      return node;
    }),
  };
}

/** The plan as a Corral. Tools and wiring come from the pattern alone. */
export function draftFromPlan(
  plan: TeamPlan,
  corralId: string,
  labels: TeamLabels = ENGLISH_LABELS,
): TeamDraft {
  const sharedOutrider =
    plan.observeWork ||
    plan.outrider === 'consultation' ||
    plan.outrider === 'artifact_review' ||
    plan.outrider === 'required_review'
      ? {
          modelProfile: 'model-a',
          principles: labels.outriderPrinciples ?? DEFAULT_OUTRIDER_PRINCIPLES,
          targets: { kind: 'all' as const },
          ...(plan.outrider === 'artifact_review' ? { artifactReview: true as const } : {}),
          ...(plan.observeWork
            ? {
                observation: {
                  targets: { kind: 'all' as const },
                  review: { ...DEFAULT_ADVISOR_REVIEW },
                },
              }
            : {}),
        }
      : undefined;
  const consultation = sharedOutrider ? { sharedOutrider } : {};
  if (isTemplatePattern(plan.pattern))
    return {
      definition: { ...templateDraft(plan, plan.pattern, corralId, labels), ...consultation },
    };
  const role = (slot: BaseSlot): CorralDefinition['roles'][number] => {
    const planned = plan.roles.find((r) => r.slot === slot);
    if (!planned) throw new Error(`the plan has no ${slot}`);
    return {
      id: slot,
      name: planned.name,
      prompt: rolePrompt(planned.duty),
      modelProfile: slot === 'reviewer' ? 'model-b' : 'model-a',
      allowedWorkTools: ['write_artifact' as const],
      allowedCollaborationTools: ['read_artifact' as const, 'submit_result' as const],
      outputContract: CONTRACT[slot],
    };
  };
  const label = (slot: BaseSlot) => plan.roles.find((r) => r.slot === slot)?.name ?? slot;
  const base = {
    ...consultation,
    schemaVersion: '0.1' as const,
    id: corralId,
    name: plan.name,
    input: { brief: plan.brief, criteria: plan.criteria },
    capabilityLinks: [],
    limits: DEFAULT_LIMITS,
  };
  const output = (source: string) => ({
    id: 'output',
    type: 'output' as const,
    label: labels.output,
    inputBindings: [{ kind: 'task_output' as const, name: 'draft', sourceNodeId: source }],
    requireApproval: plan.finalApproval,
  });

  if (plan.pattern === 'single') {
    const definition = {
      ...base,
      entryNodeId: 'work',
      roles: [role('worker')],
      nodes: [
        {
          id: 'work',
          type: 'agent' as const,
          label: label('worker'),
          roleId: 'worker',
          invocation: 'scheduled' as const,
          inputBindings: [{ kind: 'run_input' as const, name: 'brief' }],
          outputName: 'draft',
        },
        output('work'),
      ],
      controlEdges: [
        { id: 'e1', source: 'work', sourcePort: 'out', target: 'output', targetPort: 'in' },
      ],
    } satisfies CorralDefinition;
    return { definition };
  }

  // The first step (research or an outline) feeds the review Loop.
  const first: BaseSlot = plan.pattern === 'research_write_review' ? 'researcher' : 'planner';
  const firstNode = first === 'researcher' ? 'research' : 'plan';
  const nodes: CorralDefinition['nodes'] = [
    {
      id: firstNode,
      type: 'agent',
      label: label(first),
      roleId: first,
      invocation: 'scheduled',
      inputBindings: [{ kind: 'run_input', name: 'brief' }],
      outputName: 'notes',
    },
    {
      id: 'review_loop',
      type: 'loop',
      label: labels.loop,
      maxIterations: plan.reviewRounds ?? 2,
    },
    {
      id: 'write',
      type: 'agent',
      label: label('writer'),
      parentId: 'review_loop',
      roleId: 'writer',
      invocation: 'scheduled',
      inputBindings: [
        { kind: 'run_input', name: 'brief' },
        { kind: 'task_output', name: 'notes', sourceNodeId: firstNode },
        { kind: 'previous_iteration_output', name: 'draft', sourceNodeId: 'write', optional: true },
        {
          kind: 'previous_iteration_output',
          name: 'review',
          sourceNodeId: 'review',
          optional: true,
        },
      ],
      outputName: 'draft',
    },
    {
      id: 'review',
      type: 'agent',
      label: label('reviewer'),
      parentId: 'review_loop',
      roleId: 'reviewer',
      invocation: 'scheduled',
      // The criteria text, so the review is against what the person asked for (#20).
      inputBindings: [
        { kind: 'task_output', name: 'draft', sourceNodeId: 'write' },
        { kind: 'run_input', name: 'criteria' },
      ],
      outputName: 'review',
    },
    {
      id: 'review_decision',
      type: 'decision',
      label: labels.decision,
      parentId: 'review_loop',
      mode: 'review',
      rule: 'review_verdict',
      inputBindings: [{ kind: 'task_output', name: 'review', sourceNodeId: 'review' }],
    },
    output('write'),
  ];
  const edges: CorralDefinition['controlEdges'] = [
    { id: 'e0', source: firstNode, sourcePort: 'out', target: 'review_loop', targetPort: 'enter' },
    { id: 'e1', source: 'review_loop', sourcePort: 'body', target: 'write', targetPort: 'in' },
    { id: 'e2', source: 'write', sourcePort: 'out', target: 'review', targetPort: 'in' },
    { id: 'e3', source: 'review', sourcePort: 'out', target: 'review_decision', targetPort: 'in' },
    {
      id: 'e4',
      source: 'review_decision',
      sourcePort: 'revise',
      target: 'review_loop',
      targetPort: 'repeat',
    },
    {
      id: 'e5',
      source: 'review_decision',
      sourcePort: 'pass',
      target: 'review_loop',
      targetPort: 'exit',
    },
    { id: 'e6', source: 'review_loop', sourcePort: 'next', target: 'output', targetPort: 'in' },
    // At the round cap nobody is asked: the last draft goes on with its review.
    {
      id: 'e7',
      source: 'review_loop',
      sourcePort: 'exhausted',
      target: 'output',
      targetPort: 'in',
    },
  ];
  const definition: CorralDefinition = {
    ...base,
    entryNodeId: firstNode,
    roles: [role(first), role('writer'), role('reviewer')],
    nodes,
    controlEdges: edges,
  };
  return { definition };
}
