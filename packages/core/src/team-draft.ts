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
// pattern.

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
