import type { Clock, RunEvent, Scheduler } from '@corral/contracts';
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
    case 'model.finished':
      if (state.observedCalls.includes(event.payload.modelCallId)) return state;
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
          }
        : state;
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
