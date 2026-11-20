import {
  assistantKindAllowed,
  hasAssistantTarget,
  TeamAssistantReply as Reply,
  TEAM_COMPOSITION_LIMITS,
  type TeamAssistantRequest,
  type TeamAssistantTarget,
  type TeamCatalog,
  type TeamComposition,
} from '@corral/contracts';
import { compositionProblem, type TeamCompositionProblem } from './team-composition.ts';
import { type AdviceIntent, adviceIntentFromGoal } from './team-draft.ts';

type PlanReply = Extract<Reply, { kind: 'plan' }>;
type EditsReply = Extract<Reply, { kind: 'edits' }>;
type EditRequest = Extract<TeamAssistantRequest, { mode: 'edit' }>;
type CreateRequest = Extract<TeamAssistantRequest, { mode: 'create' }>;

/**
 * Why a model answer cannot be used, with none of its text: no single JSON value (`not_json`), not
 * a reply (`shape`), a kind this mode does not take (`kind`), a composition the catalog cannot seat,
 * or a reply that contradicts what the person already decided or was asked (`decision_conflict`).
 */
export type TeamAssistantProblem =
  | 'not_json'
  | 'shape'
  | 'kind'
  | TeamCompositionProblem
  | 'decision_conflict';

export type TeamAssistantReading = { reply: Reply } | { problem: TeamAssistantProblem };
const conflict = (reply: Reply | null): TeamAssistantReading =>
  reply ? { reply } : { problem: 'decision_conflict' };

/** Assistant turns in the current proposal are the questions already shown to the person. */
export function canAskAssistantQuestion(messages: TeamAssistantRequest['messages']): boolean {
  let asked = 0;
  for (const message of messages) if (message.role === 'assistant' && ++asked === 2) return false;
  return true;
}

/**
 * The questions a new team's model may still ask: none after two, none already shown and none the
 * person already decided.
 */
export function createQuestionsLeft(
  request: TeamAssistantRequest,
): ('material' | 'review_policy')[] {
  if (!canAskAssistantQuestion(request.messages)) return [];
  const decided = {
    material: request.decisions?.material,
    review_policy: request.decisions?.reviewPolicy,
  };
  return (['material', 'review_policy'] as const).filter(
    (id) => !decided[id] && !alreadyAsked(request, id),
  );
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
function policyReason(
  policy: TeamComposition['outrider'] | AdviceIntent['outrider'],
  korean: boolean,
): string {
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

type Loose = Record<string, unknown>;
const isRecord = (value: unknown): value is Loose =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
/** A `null` optional field is the field left out. */
function withoutNull(record: Loose, key: string): Loose {
  const { [key]: value, ...rest } = record;
  return value === null ? rest : record;
}
const CHOICES = { material: ['person', 'team'], review_policy: ['opinion_only', 'required'] };

/**
 * A seat's skills as the catalog can add them: ids it lists, none its agent already has, each once,
 * the first four. A seat left with none names none.
 */
function seatSkills(seat: Loose, catalog: TeamCatalog): Loose {
  if (!Array.isArray(seat.skills)) return seat;
  const skillName = new Map(catalog.skills.map((skill) => [skill.id, skill.name]));
  const own = new Set(catalog.agents.find((agent) => agent.id === seat.agent)?.skills ?? []);
  const kept = [
    ...new Set(
      seat.skills.filter((id): id is string => {
        const name = typeof id === 'string' ? skillName.get(id) : undefined;
        return name !== undefined && !own.has(name);
      }),
    ),
  ].slice(0, TEAM_COMPOSITION_LIMITS.seatSkills);
  const { skills: _skills, ...rest } = seat;
  return kept.length ? { ...rest, skills: kept } : rest;
}

/**
 * A new team's answer with the notation that does not change the team read leniently, before the
 * strict parse: a `null` skills, outrider or rounds is absent, a seat's skills are cleaned up, and
 * a question without choices gets its fixed ones. Everything else is left for the schema to judge.
 */
function lenientCreateAnswer(value: unknown, catalog: TeamCatalog): unknown {
  if (!isRecord(value)) return value;
  if (value.kind === 'question') {
    const id = value.id;
    if ((id === 'material' || id === 'review_policy') && (value.choices ?? null) === null)
      return { ...value, choices: [...CHOICES[id]] };
    return value;
  }
  if (value.kind !== 'plan' || !isRecord(value.plan)) return value;
  const plan = withoutNull(value.plan, 'outrider');
  const seats = Array.isArray(plan.seats)
    ? plan.seats.map((seat) =>
        isRecord(seat) ? seatSkills(withoutNull(seat, 'skills'), catalog) : seat,
      )
    : plan.seats;
  const flow = Array.isArray(plan.flow)
    ? plan.flow.map((step) =>
        isRecord(step) && isRecord(step.loop)
          ? { ...step, loop: withoutNull(step.loop, 'rounds') }
          : step,
      )
    : plan.flow;
  return { ...value, plan: { ...plan, seats, flow } };
}

/**
 * A new team as the model composed it, checked against the catalog it was composed from and the
 * person's review policy. The goal's words are the model's to read: nothing here re-reads them.
 */
function reconcilePlan(
  reply: PlanReply,
  request: CreateRequest,
  korean: boolean,
): TeamAssistantReading {
  const { decisions } = request;
  const problem = compositionProblem(reply.plan, request.catalog, decisions);
  if (problem) return { problem };
  const { plan } = reply;
  const policy =
    decisions?.reviewPolicy === 'required'
      ? 'required_review'
      : decisions?.reviewPolicy === 'opinion_only'
        ? 'artifact_review'
        : undefined;
  if (!policy || plan.outrider === policy) return { reply };
  return {
    reply: {
      kind: 'plan',
      plan: { ...plan, outrider: policy },
      reason: policyReason(policy, korean),
    },
  };
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
  const checked = checkAssistantReply(reply, request);
  return 'reply' in checked ? checked.reply : null;
}

function checkAssistantReply(reply: Reply, request: TeamAssistantRequest): TeamAssistantReading {
  if (!assistantKindAllowed(request.mode, reply.kind)) return { problem: 'kind' };
  const team = request.mode === 'edit' ? request.team : undefined;
  const decisions = request.decisions;
  if (decisions?.reviewTarget && !hasAssistantTarget(team, decisions.reviewTarget))
    return { problem: 'decision_conflict' };
  if (reply.kind === 'question') {
    switch (reply.id) {
      case 'material':
        if (decisions?.material) return conflict(null);
        break;
      case 'review_policy':
        if (decisions?.reviewPolicy) return conflict(null);
        break;
      case 'review_target':
        if (
          !team ||
          decisions?.reviewTarget ||
          decisions?.reviewPolicy === 'opinion_only' ||
          reply.choices.some((choice) => !hasAssistantTarget(team, choice))
        )
          return conflict(null);
        break;
    }
    return conflict(boundedQuestion(request, reply));
  }
  if (reply.kind === 'describe' || reply.kind === 'unsupported') return { reply };
  const users = request.messages.filter((message) => message.role === 'user');
  const korean = /[가-힣]/.test(users.at(-1)?.content ?? '');
  if (reply.kind === 'plan')
    return request.mode === 'create' ? reconcilePlan(reply, request, korean) : { problem: 'kind' };
  if (request.mode !== 'edit') return { problem: 'kind' };
  // Edits to an existing team still read its review and observation intent from the words.
  const intent = adviceIntentFromGoal(users.map((message) => message.content).join('\n'));
  return conflict(reconcileEdits(reply, request, intent, korean));
}

/** Never extract partial edits or execute strings from untrusted model text. */
export function assistantReplyFromAnswer(
  text: string,
  request: TeamAssistantRequest,
): Reply | null {
  const read = readAssistantAnswer(text, request);
  return 'reply' in read ? read.reply : null;
}

/** The checked reply in a model answer, or why there is none. */
export function readAssistantAnswer(
  text: string,
  request: TeamAssistantRequest,
): TeamAssistantReading {
  let value: unknown;
  // Read one complete JSON value, never an object nested inside an array or a second
  // reply. The outer envelope (a fence or surrounding explanation) is not executable.
  const start = text.search(/[[{]/);
  const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  if (start < 0 || end <= start) return { problem: 'not_json' };
  try {
    value = JSON.parse(text.slice(start, end + 1));
  } catch {
    return { problem: 'not_json' };
  }
  const parsed = Reply.safeParse(
    request.mode === 'create' ? lenientCreateAnswer(value, request.catalog) : value,
  );
  return parsed.success ? checkAssistantReply(parsed.data, request) : { problem: 'shape' };
}
