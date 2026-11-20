import {
  type CorralDefinition,
  DEFAULT_ADVISOR_REVIEW,
  DEFAULT_LIMITS,
  type PatternSlot,
  type TeamPlan,
} from '@corral/contracts';
import { ROLE_RULES } from './role-prompt.ts';

// The three base patterns as a Corral: auto mode's local choice among them and the definition a
// plan of one of them becomes, whose tools, bindings, Loop ports and limits are fixed by the
// pattern. Edit mode of the team assistant reads review and observation intent from the words.

/** The three patterns drafted here; auto mode uses their shapes. */
export type BasePattern = 'single' | 'write_review' | 'research_write_review';
type BaseSlot = PatternSlot<BasePattern>;

/** Words a drafted plan uses: its roles by slot, default criteria and step labels. */
export interface TeamWording {
  roles: Record<BaseSlot, { name: string; duty: string }>;
  /** Default criteria: answer the brief; name sources (used by the review patterns). */
  criteria: { direct: string; sources: string };
  /** Labels of the steps the pattern adds. */
  labels: TeamLabels;
}

export interface TeamLabels {
  loop: string;
  decision: string;
  output: string;
  outriderPrinciples?: string;
}

const DEFAULT_OUTRIDER_PRINCIPLES =
  'Check the evidence against the requested result and suggest concrete corrections.';

const ENGLISH_LABELS: TeamLabels = {
  loop: 'Review loop',
  decision: 'Review decision',
  output: 'Output',
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
    /\b(review (?:it )?(?:before (?:every )?(?:submitting|submission|publishing|publication)|then submit)|submit after review)\b|(?:검토|리뷰)(?:한)? 후 제출|(?:발행|제출)\s*전에?\s*(?:검토|리뷰)/i.test(
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

// Remove only the denied policy, not the entire sentence: the author may still want
// manuscript feedback or separately ask to observe the work.
const EN_POLICY =
  '(?:passing (?:a )?review|(?:an? )?(?:review(?: pass| gate| step| rounds?)?|automatic observation(?: of (?:the )?(?:workers?|work in progress))?))';
const EN_POLICIES = `${EN_POLICY}(?:\\s+(?:or|and|nor)\\s+${EN_POLICY})*`;
const DENIED_EN_POLICY = new RegExp(
  `\\b(?:(?:no(?: need for)?|without|do not need|don't need|skip)\\s+${EN_POLICIES}|${EN_POLICIES}\\s+(?:(?:is|are) not|isn't|aren't|not) (?:needed|required|necessary))\\b`,
  'gi',
);
const KO_POLICY = '(?:(?:검토|리뷰)(?:\\s*(?:통과|단계))?|(?:진행\\s*중\\s*)?자동\\s*관찰)';
const DENIED_KO_POLICY = new RegExp(
  `${KO_POLICY}(?:\\s*(?:이나|나|또는|와|과|및)\\s*${KO_POLICY})*(?:이|가|은|는|을|를|도)?\\s*(?:필요\\s*없|필요하지\\s*않|불필요|없이|하지\\s*(?:않|말|마))`,
  'g',
);

export interface AdviceIntent {
  outrider: TeamPlan['outrider'];
  observeWork: boolean;
  singleWithoutReview: boolean;
}

/** The same review and observation intent governs local, model and conversational proposals. */
export function adviceIntentFromGoal(goal: string): AdviceIntent {
  let declinedReview = false;
  const removeDenied = (policy: string) => {
    if (/review|검토|리뷰/i.test(policy)) declinedReview = true;
    return ' ';
  };
  const positive = goal
    .replace(DENIED_EN_POLICY, removeDenied)
    .replace(DENIED_KO_POLICY, removeDenied);
  return {
    outrider: outriderFromGoal(positive),
    observeWork: matchesWorkObservation(positive),
    singleWithoutReview: declinedReview && !hasExplicitTeamStructure(positive),
  };
}

/** A request to watch the team's ongoing work, including explicit opt-outs in either locale. */
function matchesWorkObservation(goal: string): boolean {
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

const CONTRACT: Record<BaseSlot, CorralDefinition['roles'][number]['outputContract']> = {
  worker: 'draft',
  planner: 'notes',
  researcher: 'notes',
  writer: 'draft',
  reviewer: 'review',
};

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
  const plannedRole = (slot: BaseSlot) => {
    const planned = plan.roles.find((r) => r.slot === slot);
    if (!planned) throw new Error(`the plan has no ${slot}`);
    return planned;
  };
  const seatWording = (slot: BaseSlot) => {
    const { name, duty } = plannedRole(slot);
    return { label: name, stepInstruction: duty };
  };
  const role = (slot: BaseSlot): CorralDefinition['roles'][number] => {
    return {
      id: slot,
      name: plannedRole(slot).name,
      prompt: ROLE_RULES,
      modelProfile: slot === 'reviewer' ? 'model-b' : 'model-a',
      allowedWorkTools: ['write_artifact' as const],
      allowedCollaborationTools: ['read_artifact' as const, 'submit_result' as const],
      outputContract: CONTRACT[slot],
    };
  };
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
          ...seatWording('worker'),
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
      ...seatWording(first),
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
      ...seatWording('writer'),
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
      ...seatWording('reviewer'),
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
