import {
  type AgentStartInput,
  type Clock,
  DEFAULT_REQUEST_BUDGET,
  type RequestBudget,
  type RequestBudgetKind,
  type RunEvent,
  type RunLimits,
  type Scheduler,
} from '@corral/contracts';
import { canonicalJson } from './canonical-json.ts';
import type { RunProjection } from './projection.ts';

export class LogicalDeadline {
  private remaining: number;
  private startedAt: number | null = null;
  private cancelTimer: (() => void) | null = null;
  private ended = false;
  private readonly clock: Clock;
  private readonly timers: Scheduler;
  private readonly expire: () => void;

  constructor(clock: Clock, timers: Scheduler, timeoutMs: number, expire: () => void) {
    this.clock = clock;
    this.timers = timers;
    this.expire = expire;
    this.remaining = timeoutMs;
    this.resume();
  }

  get remainingMs(): number {
    return Math.max(
      0,
      this.remaining - (this.startedAt === null ? 0 : this.clock.monotonicMs() - this.startedAt),
    );
  }

  pause(): void {
    if (this.startedAt === null || this.ended) return;
    this.remaining = this.remainingMs;
    this.startedAt = null;
    this.cancelTimer?.();
    this.cancelTimer = null;
  }

  resume(): void {
    if (this.startedAt !== null || this.ended) return;
    this.startedAt = this.clock.monotonicMs();
    this.cancelTimer = this.timers.after(this.remaining, () => {
      if (this.startedAt === null || this.ended) return;
      this.cancel();
      this.expire();
    });
  }

  cancel(): void {
    this.pause();
    this.ended = true;
  }
}

export function createsWaitCycle(
  projection: Pick<RunProjection, 'executions' | 'questions' | 'tasks'>,
  sourceExecutionId: string,
  targetExecutionIds: readonly string[],
): boolean {
  const pending = [...targetExecutionIds];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const id = pending.pop() ?? '';
    if (id === sourceExecutionId) return true;
    if (visited.has(id)) continue;
    visited.add(id);
    const execution = projection.executions[id];
    if (!execution?.waitingOn) continue;
    for (const target of execution.waitingOn.targetIds) {
      const question = projection.questions[target];
      if (question) {
        const responder = projection.tasks[question.taskId]?.activeExecutionId;
        if (question.status === 'open' && responder) pending.push(responder);
      } else pending.push(target);
    }
  }
  return false;
}

export interface ProgressState {
  turns: number;
  observedCalls: string[];
  submittedHashes: string[];
  reviewSignatures: string[];
  evidenceHashes?: string[];
  /** artifacts written since the last submission; a new version of one is no progress. */
  writtenArtifacts?: string[];
}

export const NO_PROGRESS_TURNS = 6;
export function emptyProgress(): ProgressState {
  return { turns: 0, observedCalls: [], submittedHashes: [], reviewSignatures: [] };
}
export function noProgressReached(state: ProgressState): boolean {
  return state.turns >= NO_PROGRESS_TURNS;
}
export function applyProgressEvent(
  state: ProgressState,
  event: RunEvent,
  projection: Pick<RunProjection, 'artifacts' | 'questions'>,
): ProgressState {
  switch (event.type) {
    case 'tool.finished': {
      const signature = event.payload.progressHash;
      const known = state.evidenceHashes ?? [];
      return !event.payload.error && signature && !known.includes(signature)
        ? { ...state, turns: 0, evidenceHashes: [...known, signature] }
        : state;
    }
    case 'artifact.version_created': {
      const signature = event.payload.contentHash;
      const known = state.evidenceHashes ?? [];
      const written = state.writtenArtifacts ?? [];
      // Rewording an answer that was never submitted is not new work (the question-mode loop).
      if (written.includes(event.payload.artifactId)) return state;
      return known.includes(signature)
        ? { ...state, writtenArtifacts: [...written, event.payload.artifactId] }
        : {
            ...state,
            turns: 0,
            evidenceHashes: [...known, signature],
            writtenArtifacts: [...written, event.payload.artifactId],
          };
    }
    case 'model.finished':
      // A response the person cut is not a turn the agent spent without progress.
      if (event.payload.interrupted || state.observedCalls.includes(event.payload.modelCallId))
        return state;
      return {
        ...state,
        turns: state.turns + 1,
        observedCalls: [...state.observedCalls, event.payload.modelCallId],
      };
    case 'task.submitted': {
      const hashes = event.payload.artifactVersionIds.flatMap((id) => {
        const hash = projection.artifacts[id]?.contentHash;
        return hash && !state.submittedHashes.includes(hash) ? [hash] : [];
      });
      return hashes.length > 0
        ? {
            ...state,
            turns: 0,
            submittedHashes: [...new Set([...state.submittedHashes, ...hashes])],
            writtenArtifacts: [],
          }
        : { ...state, writtenArtifacts: [] };
    }
    case 'review.recorded': {
      const { criteriaVersionId, verdict, issues } = event.payload;
      const unmet = [
        ...new Set(issues.map((issue) => `${issue.criterionId}:${issue.severity}`)),
      ].sort();
      const signature = canonicalJson({ criteriaVersionId, verdict, unmet });
      return state.reviewSignatures.includes(signature)
        ? state
        : { ...state, turns: 0, reviewSignatures: [...state.reviewSignatures, signature] };
    }
    case 'message.answer_committed': {
      const question = projection.questions[event.payload.questionId];
      return question?.delivery === 'parent' &&
        question.targetExecutionId === event.payload.responderExecutionId
        ? { ...state, turns: 0 }
        : state;
    }
    case 'task.completed':
    case 'approval.resolved':
      return { ...state, turns: 0 };
    default:
      return state;
  }
}

// ── unattended request budget (product contract §9) ─────────────────────────

/** The budgets a run uses: the definition's values, the omitted ones from the defaults. */
export function effectiveRequestBudget(limits: Pick<RunLimits, 'requestBudget'>): RequestBudget {
  return { ...DEFAULT_REQUEST_BUDGET, ...limits.requestBudget };
}

/** The request budget of one kind of execution; 0 means it is off. */
export function requestBudgetOf(
  kind: RequestBudgetKind,
  limits: Pick<RunLimits, 'requestBudget'>,
): number {
  return effectiveRequestBudget(limits)[kind];
}

/**
 * Which budget an execution counts against, or null when it answers the conversation directly:
 * a scheduled execution whose last reply is the run's answer (the conversation lead, a question
 * about a result) or a meeting answer. A team role counts against `role`; an execution created
 * while the run goes (a delegated child, a question's responder) against `child`.
 */
export function requestBudgetKind(
  input: Pick<AgentStartInput, 'assignment' | 'role' | 'meeting'>,
): Exclude<RequestBudgetKind, 'advisor'> | null {
  if (input.assignment.kind !== 'scheduled') return 'child';
  return input.role.answer === 'final_reply' || input.meeting ? null : 'role';
}

/** The requests an execution may still make after the submit notice before it waits. */
export const REQUEST_BUDGET_GRACE = 5;
/** The request count, as a multiple of the budget, at which the submit notice goes out. */
export const REQUEST_BUDGET_SUBMIT_FACTOR = 1.5;

/** The Coordinator's notices to an execution past its budget; model-facing, so in English. */
export const REQUEST_BUDGET_NOTICES = {
  wrapUp: (budget: number) =>
    `You have used your request budget of ${budget} model requests. Wrap up: finish what is in progress and submit your result.`,
  submit:
    "You are well past your request budget. Submit what you have now; further requests will pause for the person's decision.",
} as const;

/**
 * One execution's requests since its budget last started counting, and the counts at which its
 * wrap-up and submit notices went out. Counting starts again when the person continues it.
 */
export interface RequestBudgetState {
  used: number;
  wrapAt: number | null;
  submitAt: number | null;
}

const freshBudget = (): RequestBudgetState => ({ used: 0, wrapAt: null, submitAt: null });

export type RequestBudgetStage = 'wrap_up' | 'submit' | 'approval' | null;

/** What the budget asks for now: a notice to send, the person's decision, or nothing. */
export function requestBudgetStage(
  state: RequestBudgetState | undefined,
  budget: number,
): RequestBudgetStage {
  if (budget === 0 || !state) return null;
  if (state.submitAt !== null)
    return state.used >= state.submitAt + REQUEST_BUDGET_GRACE ? 'approval' : null;
  if (state.wrapAt !== null)
    return state.used >= Math.ceil(REQUEST_BUDGET_SUBMIT_FACTOR * budget) ? 'submit' : null;
  return state.used >= budget ? 'wrap_up' : null;
}

/**
 * Counts every model request an execution started, a retry or a cut one included, from the
 * events alone. The Coordinator's system directives mark the notices in the order it sends
 * them, and an approved `request_budget` decision starts the count again.
 */
export function applyRequestBudgetEvent(
  budgets: Readonly<Record<string, RequestBudgetState>>,
  event: RunEvent,
  approvals: Readonly<Record<string, { kind: string; executionId?: string }>>,
): Record<string, RequestBudgetState> {
  switch (event.type) {
    case 'model.request_prepared': {
      const { executionId } = event.payload;
      const state = budgets[executionId] ?? freshBudget();
      return { ...budgets, [executionId]: { ...state, used: state.used + 1 } };
    }
    case 'directive.accepted': {
      if (event.payload.origin !== 'system') return budgets;
      const id = event.payload.targetExecutionId;
      const state = budgets[id] ?? freshBudget();
      if (state.wrapAt === null) return { ...budgets, [id]: { ...state, wrapAt: state.used } };
      if (state.submitAt === null) return { ...budgets, [id]: { ...state, submitAt: state.used } };
      return budgets;
    }
    case 'approval.resolved': {
      const approval = approvals[event.payload.approvalId];
      if (
        event.payload.decision !== 'approve' ||
        approval?.kind !== 'request_budget' ||
        !approval.executionId
      )
        return budgets;
      return { ...budgets, [approval.executionId]: freshBudget() };
    }
    default:
      return budgets;
  }
}
