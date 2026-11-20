import {
  assistantKindAllowed,
  hasAssistantTarget,
  hasReviewLoop,
  TeamAssistantReply as Reply,
  type TeamAssistantRequest,
  type TeamAssistantTarget,
  type TeamPlan,
} from '@corral/contracts';
import { type AdviceIntent, adviceIntentFromGoal, withWorkObservation } from './team-draft.ts';

type PlanReply = Extract<Reply, { kind: 'plan' }>;
type EditsReply = Extract<Reply, { kind: 'edits' }>;
type EditRequest = Extract<TeamAssistantRequest, { mode: 'edit' }>;

/** Assistant turns in the current proposal are the questions already shown to the person. */
export function canAskAssistantQuestion(messages: TeamAssistantRequest['messages']): boolean {
  let asked = 0;
  for (const message of messages) if (message.role === 'assistant' && ++asked === 2) return false;
  return true;
}

function alreadyAsked(
  request: TeamAssistantRequest,
  id: Extract<Reply, { kind: 'question' }>['id'],
) {
  return request.messages.some((turn) => turn.role === 'assistant' && turn.questionId === id);
}

function boundedQuestion(
  request: TeamAssistantRequest,
  question: Extract<Reply, { kind: 'question' }>,
): Reply | null {
  if (!canAskAssistantQuestion(request.messages)) return null;
  if (alreadyAsked(request, question.id))
    return request.mode === 'edit' ? { kind: 'unsupported' } : null;
  return question;
}

const reviewPolicyQuestion = {
  kind: 'question',
  id: 'review_policy',
  choices: ['opinion_only', 'required'],
} satisfies Reply;

// If structure changes, the model's old reason (e.g. "passing review is required") is
// no longer an explanation of the checked proposal. Only describe the person's setting.
function policyReason(policy: TeamPlan['outrider'], korean: boolean): string {
  switch (policy) {
    case 'required_review':
      return korean
        ? '선택한 결과는 검토를 통과한 뒤에 제출합니다.'
        : 'The selected result is submitted after it passes review.';
    case 'artifact_review':
    case 'consultation':
      return korean
        ? '작성자는 필요할 때만 의견을 구하고 직접 제출합니다.'
        : 'The author can ask for advice when needed and submit the result directly.';
    default:
      return korean
        ? '요청하지 않은 검토나 승인 없이 작성자가 직접 제출합니다.'
        : 'The author submits the result without an unrequested review or approval.';
  }
}

function reconcilePlan(
  reply: PlanReply,
  request: TeamAssistantRequest,
  intent: AdviceIntent,
  korean: boolean,
): Reply | null {
  const decisions = request.decisions;
  // A typed clarification lets the model resolve what was ambiguous in the original goal.
  const inferred =
    intent.outrider === 'clarify_review' && alreadyAsked(request, 'review_policy')
      ? undefined
      : intent.outrider;
  const policy =
    decisions?.reviewPolicy === 'required'
      ? 'required_review'
      : decisions?.reviewPolicy === 'opinion_only'
        ? 'artifact_review'
        : inferred;
  if (
    policy === 'clarify_review' ||
    (!policy && reply.plan.outrider === 'clarify_review' && !intent.singleWithoutReview)
  )
    return boundedQuestion(request, reviewPolicyQuestion);

  let plan = reply.plan;
  if (intent.singleWithoutReview && plan.pattern !== 'single') {
    // The writer of a write/review proposal is the producer; do not guess a producer
    // in unrelated patterns or retain the sequential reviewer in the proposal.
    const writer = plan.roles.find((role) => role.slot === 'writer');
    if (!writer) return null;
    const { reviewRounds: _rounds, ...rest } = plan;
    plan = { ...rest, pattern: 'single', roles: [{ ...writer, slot: 'worker' }] };
  }
  if (
    decisions?.reviewPolicy === 'opinion_only' &&
    (hasReviewLoop(plan.pattern) || plan.pattern === 'adversarial_review')
  )
    return null;
  // Structural evidence only: never infer a material choice from model-generated prose.
  if (decisions?.material) {
    const researches = plan.pattern === 'research_write_review' || plan.pattern === 'tech_decision';
    if ((decisions.material === 'team') !== researches) return null;
  }
  if (policy && plan.outrider !== policy) plan = { ...plan, outrider: policy };
  else if (!policy && intent.singleWithoutReview && plan.outrider) {
    const { outrider: _denied, ...rest } = plan;
    plan = rest;
  }
  // There is no human-approval choice in this assistant. It belongs in the editor.
  if (plan.finalApproval) plan = { ...plan, finalApproval: false };
  const checked = withWorkObservation(plan, decisions?.observeWork ?? intent.observeWork);
  if (checked === reply.plan) return reply;
  const reason =
    plan === reply.plan
      ? checked.observeWork
        ? korean
          ? '요청한 대로 작업을 진행하는 동안 관찰합니다.'
          : 'Work is observed while it is in progress, as requested.'
        : korean
          ? '자동 관찰을 요청하지 않아 관찰 단계는 넣지 않습니다.'
          : 'Automatic observation is off because it was not requested.'
      : policyReason(checked.outrider, korean);
  return { kind: 'plan', plan: checked, reason };
}

function reconcileEdits(
  reply: EditsReply,
  request: EditRequest,
  intent: AdviceIntent,
  korean: boolean,
): Reply | null {
  const { team, decisions } = request;
  const gates = reply.edits.filter((edit) => edit.kind === 'require_review');
  // Validate *all* proposed targets before correcting any of them to a person's choice.
  if (gates.some((gate) => !hasAssistantTarget(team, gate))) return null;
  const policy = decisions?.reviewPolicy;
  if (!policy && intent.outrider === 'clarify_review' && !alreadyAsked(request, 'review_policy'))
    return boundedQuestion(request, reviewPolicyQuestion);
  if (policy === 'opinion_only' || (!policy && intent.singleWithoutReview)) {
    const needsAdvice =
      Boolean(policy === 'opinion_only' || intent.outrider) &&
      !team.hasSharedOutrider &&
      !reply.edits.some((edit) => edit.kind === 'add_shared_advice');
    if (!gates.length && !needsAdvice) return reply;
    const edits = reply.edits.filter((edit) => edit.kind !== 'require_review');
    if (needsAdvice) edits.push({ kind: 'add_shared_advice' });
    return edits.length
      ? {
          kind: 'edits',
          edits,
          reason: policyReason(
            policy === 'opinion_only' ? 'artifact_review' : intent.outrider,
            korean,
          ),
        }
      : { kind: 'describe', topic: 'review' };
  }
  if (!gates.length && policy !== 'required') return reply;
  let target = decisions?.reviewTarget;
  if (!target && alreadyAsked(request, 'review_target')) {
    // After a typed target answer, accept a single checked model target, not a guess
    // from the order of the outputs. A still-unresolved target cannot be asked again.
    if (gates.length !== 1) return { kind: 'unsupported' };
    return reply;
  }
  if (!target) {
    const choices: TeamAssistantTarget[] = [];
    for (const output of team.outputs) {
      for (const result of output.results) {
        choices.push({ outputId: output.outputId, index: result.index });
        if (choices.length === 3)
          return boundedQuestion(request, { kind: 'question', id: 'review_target', choices });
      }
    }
    if (choices.length > 1)
      return boundedQuestion(request, { kind: 'question', id: 'review_target', choices });
    target = choices[0];
    if (!target) return null;
  }
  if (
    gates.length === 1 &&
    gates[0]?.outputId === target.outputId &&
    gates[0].index === target.index
  )
    return reply;
  return {
    kind: 'edits',
    edits: [
      ...reply.edits.filter((edit) => edit.kind !== 'require_review'),
      { kind: 'require_review', ...target },
    ],
    reason: policyReason('required_review', korean),
  };
}

/** Check the reply in its proposal context. Structured decisions take priority over goal text. */
export function reconcileAssistantReply(reply: Reply, request: TeamAssistantRequest): Reply | null {
  if (!assistantKindAllowed(request.mode, reply.kind)) return null;
  const team = request.mode === 'edit' ? request.team : undefined;
  const decisions = request.decisions;
  if (decisions?.reviewTarget && !hasAssistantTarget(team, decisions.reviewTarget)) return null;
  if (reply.kind === 'question') {
    switch (reply.id) {
      case 'material':
        if (decisions?.material) return null;
        break;
      case 'review_policy':
        if (decisions?.reviewPolicy) return null;
        break;
      case 'review_target':
        if (
          !team ||
          decisions?.reviewTarget ||
          decisions?.reviewPolicy === 'opinion_only' ||
          reply.choices.some((choice) => !hasAssistantTarget(team, choice))
        )
          return null;
        break;
    }
    return boundedQuestion(request, reply);
  }
  if (reply.kind === 'describe' || reply.kind === 'unsupported') return reply;
  const users = request.messages.filter((message) => message.role === 'user');
  const korean = /[가-힣]/.test(users.at(-1)?.content ?? '');
  const intent = adviceIntentFromGoal(users.map((message) => message.content).join('\n'));
  if (reply.kind === 'plan') return reconcilePlan(reply, request, intent, korean);
  return request.mode === 'edit' ? reconcileEdits(reply, request, intent, korean) : null;
}

/** Never extract partial edits or execute strings from untrusted model text. */
export function assistantReplyFromAnswer(
  text: string,
  request: TeamAssistantRequest,
): Reply | null {
  let value: unknown;
  // Read one complete JSON value, never an object nested inside an array or a second
  // reply. The outer envelope (a fence or surrounding explanation) is not executable.
  const start = text.search(/[[{]/);
  const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  if (start < 0 || end <= start) return null;
  try {
    value = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const parsed = Reply.safeParse(value);
  return parsed.success ? reconcileAssistantReply(parsed.data, request) : null;
}
