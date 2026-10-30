import {
  type CorralDefinition,
  DEFAULT_LIMITS,
  TEAM_LIMITS,
  type TeamPattern,
  type TeamPlan,
  type TeamSlot,
} from '@corral/contracts';

// goal → team plan → Corral. The local suggestion reads the goal's words; the plan
// becomes a definition whose tools, bindings, Loop ports and limits are fixed by the pattern.

/** Words the local suggestion uses, from the Studio's messages (`TeamDraft.wording`). */
export interface TeamWording {
  roles: Record<TeamSlot, { name: string; duty: string }>;
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
}

export interface TeamLabels {
  loop: string;
  decision: string;
  output: string;
}

const ENGLISH_LABELS: TeamLabels = {
  loop: 'Review loop',
  decision: 'Review decision',
  output: 'Output',
};

type Box = { x: number; y: number; width?: number; height?: number };
export interface TeamDraft {
  definition: CorralDefinition;
  layout: { nodes: Record<string, Box>; viewport: { x: number; y: number; zoom: number } };
}

const RESEARCH =
  /\b(research\w*|compar\w*|investigat\w*|analy[sz]\w*|survey\w*|evaluat\w*|assess\w*|sources?|market|benchmark\w*)\b|조사|비교|분석|리서치|자료|출처|평가|시장/i;
const WRITING =
  /\b(write|writing|draft\w*|report\w*|article\w*|essay\w*|post|announcement\w*|proposal\w*|document\w*|blog\w*|summar\w*|e-?mail\w*|letter\w*|review\w*|plan)\b|작성|글|보고서|문서|안내문|제안서|기획|요약|검토|이메일|편지/i;

const SECURITY = /\b(security|vulnerabilit\w*)\b|보안|취약점/i;
const PULL_REQUEST = /\b(pull[ -]?request|pr)\b|풀\s*리퀘스트|풀\s*리퀘/i;
const REVIEW = /\b(review\w*|check\w*|audit\w*)\b|검토|검사|확인|점검/i;
const SUGGESTED_NAME_LENGTH = 48;

const SLOTS: Record<TeamPattern, TeamSlot[]> = {
  single: ['worker'],
  write_review: ['planner', 'writer', 'reviewer'],
  research_write_review: ['researcher', 'writer', 'reviewer'],
};

function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max - 1);
  const space = head.lastIndexOf(' ');
  return `${(space > max / 2 ? head.slice(0, space) : head).trimEnd()}…`;
}

/** The local suggestion: no model call. Null for an empty goal. */
export function planFromGoal(goal: string, wording: TeamWording): TeamPlan | null {
  const brief = goal.trim();
  if (!brief) return null;
  const securityReview = SECURITY.test(brief) && PULL_REQUEST.test(brief) && REVIEW.test(brief);
  const task = securityReview ? wording.securityReview : undefined;
  const pattern: TeamPattern =
    securityReview || RESEARCH.test(brief)
      ? 'research_write_review'
      : WRITING.test(brief)
        ? 'write_review'
        : 'single';
  const firstLine = brief.split('\n')[0]?.replace(/\s+/g, ' ') ?? brief;
  const firstSentence = firstLine.split(/[.!?](?:\s|$)/)[0] || firstLine;
  return {
    name: task?.name ?? cut(firstSentence, SUGGESTED_NAME_LENGTH),
    pattern,
    brief: cut(brief, TEAM_LIMITS.brief),
    criteria:
      (task ? Object.values(task.criteria) : undefined) ??
      (pattern === 'single'
        ? [wording.criteria.direct]
        : [wording.criteria.direct, wording.criteria.sources]),
    roles: SLOTS[pattern].map((slot) => ({
      slot,
      ...(task && slot in task.roles
        ? task.roles[slot as keyof typeof task.roles]
        : wording.roles[slot]),
    })),
    ...(pattern === 'single' ? {} : { reviewRounds: 2 }),
    finalApproval: pattern !== 'single',
  };
}

const prompt = (duty: string) =>
  `${duty} Use only the task and inputs you were given, keep exact artifact versions and evidence references, and submit with submit_result. Do not hide tool failures or missing evidence.`;

const CONTRACT: Record<TeamSlot, CorralDefinition['roles'][number]['outputContract']> = {
  worker: 'draft',
  planner: 'notes',
  researcher: 'notes',
  writer: 'draft',
  reviewer: 'review',
};

/** The plan as a Corral and its layout. Tools and wiring come from the pattern alone. */
export function draftFromPlan(
  plan: TeamPlan,
  corralId: string,
  labels: TeamLabels = ENGLISH_LABELS,
): TeamDraft {
  const role = (slot: TeamSlot): CorralDefinition['roles'][number] => {
    const planned = plan.roles.find((r) => r.slot === slot);
    if (!planned) throw new Error(`the plan has no ${slot}`);
    return {
      id: slot,
      name: planned.name,
      prompt: prompt(planned.duty),
      modelProfile: slot === 'reviewer' ? 'model-b' : 'model-a',
      allowedWorkTools: ['write_artifact' as const],
      allowedCollaborationTools: ['read_artifact' as const, 'submit_result' as const],
      outputContract: CONTRACT[slot],
    };
  };
  const label = (slot: TeamSlot) => plan.roles.find((r) => r.slot === slot)?.name ?? slot;
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
    return {
      definition,
      layout: {
        nodes: { work: { x: 80, y: 120 }, output: { x: 360, y: 120 } },
        viewport: { x: 16, y: 16, zoom: 1 },
      },
    };
  }

  // The first step (research or an outline) feeds the review Loop.
  const first: TeamSlot = plan.pattern === 'research_write_review' ? 'researcher' : 'planner';
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
      loopId: 'review_loop',
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
      loopId: 'review_loop',
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
      loopId: 'review_loop',
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
  return {
    definition,
    layout: {
      nodes: {
        [firstNode]: { x: 20, y: 90 },
        review_loop: { x: 230, y: 20, width: 650, height: 210 },
        write: { x: 260, y: 90 },
        review: { x: 470, y: 90 },
        review_decision: { x: 680, y: 90 },
        // Below the Loop, so the team fits a 1280px canvas.
        output: { x: 680, y: 290 },
      },
      viewport: { x: 16, y: 16, zoom: 0.75 },
    },
  };
}
