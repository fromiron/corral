import {
  approvalIsFixed,
  type CorralDefinition,
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
  /** The Join where the parallel patterns' branches meet. */
  join?: string;
}

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
  /\b(code|codebase|source|prs?|pull[ -]?requests?|diffs?|branch\w*|commits?|modules?|middleware|functions?|endpoints?|services?|implementation|apis?|repo\w*|librar\w*|components?|handlers?)\b|코드|브랜치|커밋|모듈|함수|미들웨어|구현|엔드포인트|서비스|라이브러리|컴포넌트|API/i;
const NO_CHANGE =
  /\b(without (chang|modif|edit|touch|fix)\w*|(don['’]?t|do not|never) (change|modify|edit|touch|fix)\w*|read[- ]only|findings only|only report\w*|report (the )?findings|no (changes|edits|fixes))\b|고치지\s*말|수정하지\s*말|바꾸지\s*말|변경하지\s*말|건드리지\s*말|손대지\s*말|읽기\s*전용/i;
const CORRECTNESS = /\b(correctness|logic errors?)\b|정확성|논리\s*오류/i;
const BUG =
  /\b(bugs?|crash\w*|errors?|exceptions?|fail\w*|broken|regressions?|flaky|intermittent\w*|timeouts?|hangs?|freez\w*|leaks?)\b|버그|오류|에러|장애|크래시|죽는|죽어|깨지|깨져|실패|안\s?되|멈추|멈춰|타임아웃|먹통/i;
const CAUSE =
  /\b(causes?|caused|why|root|investigat\w*|debug\w*|diagnos\w*|reproduc\w*|trace|find out)\b|원인|이유|왜|재현|추적|디버그|디버깅/i;
const FIX = /\b(fix\w*|repair\w*|resolv\w*|patch\w*)\b|고쳐|고치|수정해|해결/i;
const DECISION =
  /\b(decid\w*|decisions?|choos\w*|chose|pick|select|which (one|option|is better)|should (we|i)|recommend\w*|trade-?offs?)\b|결정|선택|고를|고르|골라|할지|추천|권해|권하/i;
const OPTIONS =
  /\b(between|or|vs\.?|versus|both|options?|alternatives?|either)\b|중\s*(에|에서)?\s*(무엇|어느|뭘|뭐|하나|어떤)|아니면|두\s*(안|가지|방안|옵션|후보)|둘\s*중|대신/i;
const IMPLEMENT =
  /\b(implement\w*|add|adds|adding|build|builds|building|develop|developing|introduce|integrat\w*|migrat\w*|refactor\w*)\b|구현|추가|개발|도입|연동|마이그레이션|리팩터|리팩토링|이관/i;
const PLAN_FIRST =
  /\b(plan\w*|design\w*|migrat\w*|stages?|staged|step[- ]by[- ]step|phases?|phased|incremental\w*|roadmap|architect\w*)\b|설계|계획|마이그레이션|이관|옮기|옮겨|단계|아키텍처/i;
const DOCUMENT =
  /\b(documents?|docs?|reports?|articles?|essays?|posts?|announcements?|proposals?|blogs?|e-?mails?|letters?|memos?|newsletters?|readme|faq|slides?|decks?|guides?|manuals?)\b|안내문|보고서|문서|제안서|기획서|이메일|편지|공지|슬라이드|가이드|매뉴얼/i;
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
  if (BUG.test(brief) && (CAUSE.test(brief) || FIX.test(brief)) && !keepsCode) return 'bug_fix';
  if (DECISION.test(brief) && OPTIONS.test(brief)) return 'tech_decision';
  if (IMPLEMENT.test(brief) && !(DOCUMENT.test(brief) && !SOFTWARE.test(brief)))
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
      finalApproval: pattern !== 'single',
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
    // A template's own default: only the technical decision waits for approval.
    finalApproval: approvalIsFixed(pattern),
  };
}

/** The plan with another pattern: its roles rebuilt, its name, brief and criteria kept. */
export function planWithPattern(
  plan: Pick<TeamPlan, 'name' | 'brief' | 'criteria'>,
  pattern: TeamPattern,
  wording: TeamWording,
): TeamPlan {
  const { criteria: _, ...parts } = patternParts(pattern, wording);
  return { name: plan.name, pattern, brief: plan.brief, criteria: [...plan.criteria], ...parts };
}

/** The local suggestion: no model call. Null for an empty goal. */
export function planFromGoal(goal: string, wording: TeamWording): TeamPlan | null {
  const brief = goal.trim();
  if (!brief) return null;
  const pattern: TeamPattern =
    (wording.templates ? templatePatternFromGoal(brief) : null) ?? basePatternFromGoal(brief);
  const task =
    pattern === 'research_write_review' && isSecurityReview(brief)
      ? wording.securityReview
      : undefined;
  const firstLine = brief.split('\n')[0]?.replace(/\s+/g, ' ') ?? brief;
  const firstSentence = firstLine.split(/[.!?](?:\s|$)/)[0] || firstLine;
  const parts = patternParts(pattern, wording);
  return {
    name: task?.name ?? cut(firstSentence, SUGGESTED_NAME_LENGTH),
    pattern,
    brief: cut(brief, TEAM_LIMITS.brief),
    criteria: (task ? Object.values(task.criteria) : undefined) ?? parts.criteria,
    roles: parts.roles.map((role) => ({
      ...role,
      ...(task && role.slot in task.roles ? task.roles[role.slot as keyof typeof task.roles] : {}),
    })),
    ...(parts.reviewRounds === undefined ? {} : { reviewRounds: parts.reviewRounds }),
    finalApproval: parts.finalApproval,
  };
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
      if (node.type === 'output' && !approvalIsFixed(pattern))
        return { ...node, requireApproval: plan.finalApproval };
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
  if (isTemplatePattern(plan.pattern))
    return { definition: templateDraft(plan, plan.pattern, corralId, labels) };
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
