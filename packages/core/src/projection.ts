import type {
  DirectiveStatus,
  EventOf,
  EventPayload,
  ExecutionActivity,
  ExecutionStatus,
  ItemRef,
  ModelProfileSnapshot,
  NormalizedUsage,
  OutputContract,
  ReasoningResolution,
  ReasoningWire,
  RunDecisionSettings,
  RunEvent,
  RunLimits,
  RunStatus,
  TaskStatus,
  WaitingOn,
} from '@corral/contracts';
import { TERMINAL_RUN_STATUSES } from '@corral/contracts';
import { applyBudgetEvent, type BudgetState, emptyBudget } from './budget.ts';
import { applyProgressEvent, emptyProgress, type ProgressState } from './limits.ts';

// Read model rebuilt only from committed events (INV-14). The same reducer runs in the
// coordinator and in every client, so a replayed log and a live view cannot drift.

export interface ExecutionView {
  candidateId?: string;
  item?: ItemRef;
  executionId: string;
  nodeId: string;
  taskId: string;
  attemptNo: number;
  parentExecutionId: string | null;
  previousExecutionId: string | null;
  depth: number;
  iterationId: string | null;
  modelProfile: string;
  configRevision: number;
  criteriaVersionId: string | null;
  status: ExecutionStatus;
  activity: ExecutionActivity | null;
  /** What a waiting execution waits for, with the ids to link to (OBS-001). */
  waitingOn: WaitingOn | null;
  modelCallIds: string[];
  error: string | null;
}

export interface TaskView {
  taskId: string;
  nodeId: string;
  roleId: string;
  contract: OutputContract;
  status: TaskStatus;
  activeExecutionId: string | null;
  attemptCount: number;
  submittedArtifactVersionIds: string[];
}

export interface DirectiveView {
  directiveId: string;
  targetExecutionId: string;
  text: string;
  status: DirectiveStatus;
  commandId: string | null;
  acceptedSeq: number;
  contextSnapshotId: string | null;
  modelCallId: string | null;
  reason: string | null;
}

export interface ModelCallView {
  reasoning?: ReasoningResolution;
  reasoningWire?: ReasoningWire;
  modelCallId: string;
  executionId: string;
  contextSnapshotId: string;
  profile: string;
  configRevision: number;
  directiveIds: string[];
  inputArtifactVersionIds: string[];
  finished: boolean;
  usage: NormalizedUsage | null;
  rawUsage: Record<string, unknown> | null;
  certainty: 'reported' | 'estimated' | 'unknown' | null;
  /** Committed response text, available after reconnect even without an output artifact. */
  responseRef?: string | null;
}

export interface ArtifactVersionView {
  media?: import('@corral/contracts').BinaryArtifact;
  artifactVersionId: string;
  artifactId: string;
  version: number;
  /** The version this one revises (the same node's draft in the previous Loop round). */
  parentVersionId: string | null;
  name: string;
  contract: OutputContract;
  contentHash: string;
  byteLength: number;
  authorExecutionId: string;
  modelCallId: string | null;
  contextSnapshotId: string | null;
  submitted: boolean;
  configRevision: number;
  criteriaVersionId: string | null;
  inputArtifactVersionIds: string[];
}

export interface ToolCallView {
  toolCallId: string;
  executionId: string;
  name: string;
  status: 'requested' | 'blocked';
  phase?: 'allowed' | 'running' | 'finished' | 'failed';
  effectId?: string;
  reason: string | null;
  resultRef?: string | null;
}

/** One reasoning_effort judgment of one request (CR-003). Observed, never applied. */
export interface DecisionView {
  decisionId: string;
  provider: string;
  privacy: 'local' | 'external';
  executionId: string;
  modelCallId: string;
  /**
   * `not_collected`: the run ended before the provider answered (#22). Derived from the run's
   * terminal state; no event is written after the end, and no answer is made up.
   */
  status: 'requested' | 'observed' | 'failed' | 'not_collected';
  answer: 'low' | 'medium' | 'high' | 'xhigh' | null;
  probabilities: { low: number; medium: number; high: number; xhigh: number } | null;
  evidenceLevel: 'model_probability' | 'rule' | 'none' | null;
  reason: string | null;
  latencyMs: number | null;
  readyBeforeDispatch: boolean | null;
  afterRequestFinished: boolean | null;
}

export interface EffectView {
  effectId: string;
  kind: 'model_request' | 'tool' | 'spawn' | 'decision';
  scope: string;
  epoch: number;
  dispatched: boolean;
  reservationId: string | null;
  status: 'admitted' | 'settled';
  outcome: 'succeeded' | 'failed' | 'cancelled' | 'unknown' | null;
}

export interface IterationView {
  iterationId: string;
  loopNodeId: string;
  no: number;
  criteriaVersionId: string;
  outcome: 'pass' | 'revise' | 'inconclusive' | 'cap_reached' | 'cancelled' | null;
}

/** A question from one execution to a callable role, answered by a new responder task. */
export interface QuestionView {
  delivery?: 'parent';
  targetExecutionId?: string;
  questionId: string;
  /** The responder's task. */
  taskId: string;
  senderExecutionId: string;
  targetNodeId: string;
  targetRoleId: string;
  body: string;
  artifactRefs: string[];
  deadline: string;
  status: 'open' | 'answered' | 'cancelled' | 'timed_out';
  answer: { responderExecutionId: string; body: string; evidenceRefs: string[] } | null;
}

export interface ApprovalView {
  approvalId: string;
  kind: 'final_output' | 'loop_cap' | 'user_action';
  /** The exact versions this decision is about; the first is the one being approved. */
  subjectVersionIds: string[];
  criteriaVersionId: string | null;
  tool?: EventPayload<'approval.requested'>['tool'];
  status: 'pending' | 'approved' | 'rejected' | 'stale';
}

export interface PatchView extends EventPayload<'patch.committed'> {
  executionIds: string[];
  iterationIds: string[];
}

export interface ReviewView {
  design?: EventPayload<'review.recorded'>['design'];
  stale: boolean;
  newCriteriaVersionId: string | null;
  reviewVersionId: string;
  targetVersionId: string;
  criteriaVersionId: string;
  verdict: 'pass' | 'revise' | 'inconclusive';
  issues: { criterionId: string; reason: string; severity: 'required' | 'advisory' }[];
}

export interface RunProjection {
  candidateComparison?: import('@corral/contracts').CandidateComparisonView;
  /** When run.started and the terminal state change were recorded; null until then. */
  startedAt: string | null;
  endedAt: string | null;
  /** The model each profile resolved to when the run started (run.started). */
  modelProfiles: Record<string, ModelProfileSnapshot>;
  /** The earlier version this run's brief starts from (CR-007); null otherwise. */
  startedFrom: { runId: string; artifactVersionId: string } | null;
  runId: string;
  corralId: string | null;
  definitionHash: string | null;
  mode: 'mock' | 'live' | null;
  status: RunStatus;
  statusReason: string | null;
  /** Logical question deadlines exclude the time spent under a user pause. */
  userPauseStartedAt: string | null;
  lastSeq: number;
  executions: Record<string, ExecutionView>;
  executionOrder: string[];
  nodeExecutions: Record<string, string[]>;
  tasks: Record<string, TaskView>;
  directives: Record<string, DirectiveView>;
  directiveOrder: string[];
  modelCalls: Record<string, ModelCallView>;
  artifacts: Record<string, ArtifactVersionView>;
  toolCalls: Record<string, ToolCallView>;
  effects: Record<string, EffectView>;
  iterations: Record<string, IterationView>;
  questions: Record<string, QuestionView>;
  approvals: Record<string, ApprovalView>;
  runtimeCheckpoints?: Record<string, EventPayload<'runtime.checkpoint_created'>>;
  compactions?: Record<string, EventPayload<'context.compaction_changed'>>;
  workPlans?: Record<string, EventPayload<'work_plan.updated'>>;
  /** Reviews as recorded by the runtime (C-027), in order. */
  reviews: Record<string, ReviewView>;
  /** Bumped by control changes (patches, P6); approvals and patches must name it. */
  controlRevision: number;
  patches: Record<string, PatchView>;
  currentCriteriaVersionId: string | null;
  limits: RunLimits | null;
  /** CR-048: version 2 Ultra, where `limits` are not applied. */
  usageLimits?: 'none';
  budget: BudgetState;
  progress: ProgressState;
  /** The final approval behind the output, when the Output required one. */
  outputApprovalId: string | null;
  /** Versions each execution read through read_artifact, in order. */
  artifactReads: Record<string, string[]>;
  /** Iteration ids per Loop node, in round order. */
  loopIterations: Record<string, string[]>;
  /** Set when a backend restart ended the run (RUN-007). */
  interruptedBy: string | null;
  output: { nodeId: string; artifactVersionIds: string[] } | null;
  /** Judgment settings fixed at run start; null when the runtime had none (CR-003). */
  decisionSettings: RunDecisionSettings | null;
  /** reasoning_effort judgments by decisionId, in commit order. */
  decisions: Record<string, DecisionView>;
}

export class ProjectionGapError extends Error {
  readonly expectedSeq: number;
  readonly receivedSeq: number;

  constructor(expectedSeq: number, receivedSeq: number) {
    super(`event gap: expected runSeq ${expectedSeq}, received ${receivedSeq}`);
    this.expectedSeq = expectedSeq;
    this.receivedSeq = receivedSeq;
  }
}

export function emptyProjection(runId: string): RunProjection {
  return {
    runId,
    corralId: null,
    definitionHash: null,
    mode: null,
    status: 'created',
    statusReason: null,
    userPauseStartedAt: null,
    lastSeq: 0,
    executions: {},
    executionOrder: [],
    nodeExecutions: {},
    tasks: {},
    directives: {},
    directiveOrder: [],
    modelCalls: {},
    artifacts: {},
    toolCalls: {},
    effects: {},
    iterations: {},
    questions: {},
    approvals: {},
    reviews: {},
    controlRevision: 0,
    patches: {},
    currentCriteriaVersionId: null,
    limits: null,
    budget: emptyBudget(),
    progress: emptyProgress(),
    outputApprovalId: null,
    artifactReads: {},
    loopIterations: {},
    interruptedBy: null,
    output: null,
    decisionSettings: null,
    startedFrom: null,
    modelProfiles: {},
    startedAt: null,
    endedAt: null,
    decisions: {},
  };
}

/**
 * Applies the next committed event. Already-applied sequence numbers are ignored;
 * a skipped number throws, so the caller re-reads instead of guessing (OBS-002).
 */
export function applyEvent(projection: RunProjection, event: RunEvent): RunProjection {
  if (event.runSeq <= projection.lastSeq) return projection;
  if (event.runSeq !== projection.lastSeq + 1) {
    throw new ProjectionGapError(projection.lastSeq + 1, event.runSeq);
  }
  const next = reduce(projection, event);
  return {
    ...next,
    progress: applyProgressEvent(projection.progress, event, next),
    lastSeq: event.runSeq,
  };
}

function reduce(p: RunProjection, event: RunEvent): RunProjection {
  switch (event.type) {
    case 'run.started':
      return {
        ...p,
        corralId: event.payload.corralId,
        definitionHash: event.payload.definitionHash,
        mode: event.payload.mode,
        startedFrom: event.payload.startedFrom ?? null,
        startedAt: event.recordedAt,
        modelProfiles: Object.fromEntries(event.payload.modelProfiles.map((m) => [m.profile, m])),
        limits: event.payload.limits,
        ...(event.payload.autoRoute?.ultra?.version === 2 || event.payload.meeting
          ? { usageLimits: 'none' as const }
          : {}),
        currentCriteriaVersionId: event.payload.criteriaVersionId ?? null,
        decisionSettings: event.payload.decisions ?? null,
      };
    case 'run.state_changed': {
      const { to, reasonCode } = event.payload;
      const next = {
        ...p,
        status: to,
        statusReason: reasonCode,
        ...(TERMINAL_RUN_STATUSES.has(to) &&
        p.candidateComparison &&
        !['selected', 'no_acceptable_candidate'].includes(p.candidateComparison.status)
          ? {
              candidateComparison: {
                ...p.candidateComparison,
                status: 'interrupted' as const,
                candidates: p.candidateComparison.candidates.map((candidate) =>
                  ['pending', 'running'].includes(candidate.state)
                    ? {
                        ...candidate,
                        state: to === 'cancelled' ? ('cancelled' as const) : ('failed' as const),
                        reason: reasonCode,
                      }
                    : candidate,
                ),
              },
            }
          : {}),
        ...(TERMINAL_RUN_STATUSES.has(to) && p.endedAt === null
          ? { endedAt: event.recordedAt }
          : {}),
        ...(TERMINAL_RUN_STATUSES.has(to) && p.decisions
          ? {
              decisions: Object.fromEntries(
                Object.entries(p.decisions).map(([id, d]) => [
                  id,
                  d.status === 'requested' ? { ...d, status: 'not_collected' as const } : d,
                ]),
              ),
            }
          : {}),
      };
      if (to === 'pausing' && p.userPauseStartedAt === null) {
        return { ...next, userPauseStartedAt: event.recordedAt };
      }
      if (reasonCode !== 'resumed' || p.userPauseStartedAt === null) return next;
      const pausedMs = Math.max(0, Date.parse(event.recordedAt) - Date.parse(p.userPauseStartedAt));
      const extend = (deadline: string) => new Date(Date.parse(deadline) + pausedMs).toISOString();
      return {
        ...next,
        userPauseStartedAt: null,
        questions: Object.fromEntries(
          Object.entries(p.questions).map(([id, question]) => [
            id,
            question.status === 'open'
              ? { ...question, deadline: extend(question.deadline) }
              : question,
          ]),
        ),
        executions: Object.fromEntries(
          Object.entries(p.executions).map(([id, execution]) => [
            id,
            execution.waitingOn?.kind === 'message' && execution.waitingOn.deadline
              ? {
                  ...execution,
                  waitingOn: {
                    ...execution.waitingOn,
                    deadline: extend(execution.waitingOn.deadline),
                  },
                }
              : execution,
          ]),
        ),
      };
    }
    case 'task.created': {
      const { taskId, nodeId, roleId, contract } = event.payload;
      const task: TaskView = {
        taskId,
        nodeId,
        roleId,
        contract,
        status: 'queued',
        activeExecutionId: null,
        attemptCount: 0,
        submittedArtifactVersionIds: [],
      };
      return { ...p, tasks: { ...p.tasks, [taskId]: task } };
    }
    case 'candidate.comparison_changed':
      return {
        ...p,
        candidateComparison: event.payload,
        controlRevision: p.controlRevision + (event.commandId ? 1 : 0),
      };
    case 'execution.created':
      return executionCreated(p, event);
    case 'task.attempt_assigned':
      return updateTask(p, event.payload.taskId, {
        status: 'in_progress',
        activeExecutionId: event.payload.executionId,
        attemptCount: event.payload.attemptNo,
      });
    case 'execution.state_changed':
      return updateExecution(p, event.payload.executionId, {
        status: event.payload.to,
        activity: event.payload.activity,
        waitingOn: event.payload.waitingOn,
      });
    case 'execution.settled':
      return executionSettled(p, event);
    case 'model.request_prepared': {
      const { executionId, modelCallId, contextSnapshotId, profile } = event.payload;
      const call: ModelCallView = {
        modelCallId,
        executionId,
        contextSnapshotId,
        profile,
        configRevision: event.payload.configRevision,
        ...(event.payload.reasoning ? { reasoning: event.payload.reasoning } : {}),
        directiveIds: event.payload.directiveIds,
        inputArtifactVersionIds: event.payload.inputArtifactVersionIds,
        finished: false,
        usage: null,
        rawUsage: null,
        certainty: null,
        responseRef: null,
      };
      const execution = p.executions[executionId];
      const withCall = { ...p, modelCalls: { ...p.modelCalls, [modelCallId]: call } };
      if (!execution) return withCall;
      return updateExecution(withCall, executionId, {
        modelCallIds: [...execution.modelCallIds, modelCallId],
      });
    }
    case 'model.payload_recorded': {
      const call = p.modelCalls[event.payload.modelCallId];
      return call && event.payload.reasoning
        ? {
            ...p,
            modelCalls: {
              ...p.modelCalls,
              [call.modelCallId]: { ...call, reasoningWire: event.payload.reasoning },
            },
          }
        : p;
    }
    case 'model.finished': {
      return updateModelCall(p, event.payload.modelCallId, {
        finished: true,
        usage: event.payload.normalizedUsage,
        rawUsage: event.payload.rawUsage,
        certainty: event.payload.certainty,
        responseRef: event.payload.responseRef,
      });
    }
    case 'model.usage_reconciled': {
      const call = p.modelCalls[event.payload.modelCallId];
      if (!call) return p;
      const usage = event.payload.normalizedUsage;
      return updateModelCall(p, call.modelCallId, {
        usage: {
          inputTokens: call.usage?.inputTokens ?? usage.inputTokens,
          outputTokens: call.usage?.outputTokens ?? usage.outputTokens,
          cachedInputTokens: call.usage?.cachedInputTokens ?? usage.cachedInputTokens,
          reasoningTokens: call.usage?.reasoningTokens ?? usage.reasoningTokens,
        },
        rawUsage: event.payload.rawUsage ?? call.rawUsage,
        certainty:
          event.payload.certainty === 'unknown'
            ? (call.certainty ?? 'unknown')
            : event.payload.certainty,
      });
    }
    case 'directive.accepted': {
      const { directiveId, targetExecutionId, text } = event.payload;
      const directive: DirectiveView = {
        directiveId,
        targetExecutionId,
        text,
        status: 'queued',
        commandId: event.commandId ?? null,
        acceptedSeq: event.runSeq,
        contextSnapshotId: null,
        modelCallId: null,
        reason: null,
      };
      return {
        ...p,
        directives: { ...p.directives, [directiveId]: directive },
        directiveOrder: [...p.directiveOrder, directiveId],
      };
    }
    case 'directive.attached':
      return updateDirective(p, event.payload.directiveId, {
        status: 'attached_to_request',
        contextSnapshotId: event.payload.contextSnapshotId,
        modelCallId: event.payload.modelCallId,
      });
    case 'directive.dispatched':
      return updateDirective(p, event.payload.directiveId, { status: 'delivered' });
    case 'directive.undelivered':
      return updateDirective(p, event.payload.directiveId, {
        status: event.payload.status,
        reason: event.payload.reason,
      });
    case 'tool.requested': {
      const { toolCallId, executionId, name } = event.payload;
      const call: ToolCallView = {
        toolCallId,
        executionId,
        name,
        status: 'requested',
        reason: null,
      };
      return { ...p, toolCalls: { ...p.toolCalls, [toolCallId]: call } };
    }
    case 'tool.allowed':
    case 'tool.started': {
      const call = p.toolCalls[event.payload.toolCallId];
      if (!call) return p;
      return {
        ...p,
        toolCalls: {
          ...p.toolCalls,
          [call.toolCallId]: {
            ...call,
            phase: event.type === 'tool.started' ? 'running' : 'allowed',
            ...(event.type === 'tool.started' ? { effectId: event.payload.effectId } : {}),
          },
        },
      };
    }
    case 'tool.blocked': {
      const call = p.toolCalls[event.payload.toolCallId];
      if (!call) return p;
      const blocked: ToolCallView = { ...call, status: 'blocked', reason: event.payload.reason };
      return { ...p, toolCalls: { ...p.toolCalls, [call.toolCallId]: blocked } };
    }
    case 'tool.finished': {
      const call = p.toolCalls[event.payload.toolCallId];
      if (!call) return p;
      return {
        ...p,
        toolCalls: {
          ...p.toolCalls,
          [call.toolCallId]: {
            ...call,
            phase: event.payload.error ? 'failed' : 'finished',
            resultRef: event.payload.resultRef,
            reason: event.payload.error,
          },
        },
      };
    }
    case 'artifact.version_created': {
      const { artifactVersionId, ...rest } = event.payload;
      const call = rest.modelCallId ? p.modelCalls[rest.modelCallId] : undefined;
      const author = p.executions[rest.authorExecutionId];
      const artifact: ArtifactVersionView = {
        artifactVersionId,
        ...rest,
        submitted: false,
        configRevision: call?.configRevision ?? author?.configRevision ?? 0,
        criteriaVersionId: author?.criteriaVersionId ?? null,
        inputArtifactVersionIds: call?.inputArtifactVersionIds ?? [
          ...new Set(p.artifactReads[rest.authorExecutionId] ?? []),
        ],
      };
      return { ...p, artifacts: { ...p.artifacts, [artifactVersionId]: artifact } };
    }
    case 'task.submitted': {
      const { taskId, artifactVersionIds } = event.payload;
      const artifacts = { ...p.artifacts };
      for (const id of artifactVersionIds) {
        const artifact = artifacts[id];
        if (artifact) artifacts[id] = { ...artifact, submitted: true };
      }
      return updateTask({ ...p, artifacts }, taskId, {
        status: 'submitted',
        submittedArtifactVersionIds: artifactVersionIds,
      });
    }
    case 'task.completed':
      return updateTask(p, event.payload.taskId, { status: 'completed' });
    case 'output.finalized':
      return {
        ...p,
        output: {
          nodeId: event.payload.nodeId,
          artifactVersionIds: event.payload.artifactVersionIds,
        },
        outputApprovalId: event.payload.approvalId,
      };
    case 'approval.requested': {
      const { approvalId, kind, subjectVersionIds, criteriaVersionId } = event.payload;
      const approval: ApprovalView = {
        approvalId,
        kind,
        subjectVersionIds,
        criteriaVersionId,
        status: 'pending',
        ...(event.payload.tool ? { tool: event.payload.tool } : {}),
      };
      return { ...p, approvals: { ...p.approvals, [approvalId]: approval } };
    }
    case 'approval.resolved': {
      const approval = p.approvals[event.payload.approvalId];
      if (!approval) return p;
      const status = event.payload.decision === 'approve' ? 'approved' : 'rejected';
      return {
        ...p,
        approvals: { ...p.approvals, [approval.approvalId]: { ...approval, status } },
      };
    }
    case 'review.recorded': {
      const { reviewVersionId, targetVersionId, criteriaVersionId, verdict, issues } =
        event.payload;
      const review: ReviewView = {
        ...(event.payload.design ? { design: event.payload.design } : {}),
        stale: false,
        newCriteriaVersionId: null,
        reviewVersionId,
        targetVersionId,
        criteriaVersionId,
        verdict,
        issues: issues.map(({ criterionId, reason, severity }) => ({
          criterionId,
          reason,
          severity,
        })),
      };
      return { ...p, reviews: { ...p.reviews, [reviewVersionId]: review } };
    }
    case 'run.interrupted':
      return {
        ...p,
        interruptedBy: event.payload.backendSessionId,
        approvals: Object.fromEntries(
          Object.entries(p.approvals).map(([id, approval]) => [
            id,
            approval.status === 'pending' ? { ...approval, status: 'stale' as const } : approval,
          ]),
        ),
      };
    case 'effect.admitted': {
      const { effectId, kind, scope, epoch } = event.payload;
      const effect: EffectView = {
        effectId,
        kind,
        scope,
        epoch,
        dispatched: false,
        reservationId: event.payload.reservationId,
        status: 'admitted',
        outcome: null,
      };
      return { ...p, effects: { ...p.effects, [effectId]: effect } };
    }
    case 'effect.dispatch_observed': {
      const effect = p.effects[event.payload.effectId];
      return effect
        ? { ...p, effects: { ...p.effects, [effect.effectId]: { ...effect, dispatched: true } } }
        : p;
    }
    case 'effect.settled': {
      const effect = p.effects[event.payload.effectId];
      if (!effect) return p;
      const settled: EffectView = { ...effect, status: 'settled', outcome: event.payload.outcome };
      return { ...p, effects: { ...p.effects, [effect.effectId]: settled } };
    }
    case 'loop.iteration_started': {
      const { iterationId, loopNodeId, no, criteriaVersionId } = event.payload;
      const iteration: IterationView = {
        iterationId,
        loopNodeId,
        no,
        criteriaVersionId,
        outcome: null,
      };
      return {
        ...p,
        iterations: { ...p.iterations, [iterationId]: iteration },
        loopIterations: {
          ...p.loopIterations,
          [loopNodeId]: [...(p.loopIterations[loopNodeId] ?? []), iterationId],
        },
      };
    }
    case 'loop.iteration_finished': {
      const iteration = p.iterations[event.payload.iterationId];
      if (!iteration) return p;
      const finished: IterationView = { ...iteration, outcome: event.payload.outcome };
      return { ...p, iterations: { ...p.iterations, [iteration.iterationId]: finished } };
    }
    case 'message.question_created': {
      const { questionId, ...rest } = event.payload;
      const question: QuestionView = { questionId, ...rest, status: 'open', answer: null };
      return { ...p, questions: { ...p.questions, [questionId]: question } };
    }
    case 'message.answer_committed': {
      const question = p.questions[event.payload.questionId];
      if (!question) return p;
      const { responderExecutionId, body, evidenceRefs } = event.payload;
      const answered: QuestionView = {
        ...question,
        answer: { responderExecutionId, body, evidenceRefs },
      };
      return { ...p, questions: { ...p.questions, [question.questionId]: answered } };
    }
    case 'message.closed': {
      const question = p.questions[event.payload.questionId];
      if (!question) return p;
      const status = event.payload.outcome === 'answered' ? 'answered' : event.payload.outcome;
      return {
        ...p,
        questions: { ...p.questions, [question.questionId]: { ...question, status } },
      };
    }
    case 'artifact.read': {
      const { consumerExecutionId, resolvedVersionId } = event.payload;
      return {
        ...p,
        artifactReads: {
          ...p.artifactReads,
          [consumerExecutionId]: [
            ...(p.artifactReads[consumerExecutionId] ?? []),
            resolvedVersionId,
          ],
        },
      };
    }
    case 'task.blocked':
      return updateTask(p, event.payload.taskId, { status: 'blocked' });
    case 'review.stale': {
      const review = p.reviews[event.payload.reviewVersionId];
      return review
        ? {
            ...p,
            reviews: {
              ...p.reviews,
              [review.reviewVersionId]: {
                ...review,
                stale: true,
                newCriteriaVersionId: event.payload.newCriteriaVersionId,
              },
            },
          }
        : p;
    }
    case 'patch.committed': {
      const patch = event.payload;
      return {
        ...p,
        controlRevision: patch.controlRevision,
        patches: {
          ...p.patches,
          [patch.patchId]: { ...patch, executionIds: [], iterationIds: [] },
        },
        ...(patch.kind === 'criteria'
          ? {
              currentCriteriaVersionId: String(patch.after.criteriaVersionId),
              approvals: Object.fromEntries(
                Object.entries(p.approvals).map(([id, a]) => [
                  id,
                  a.status === 'pending' && !a.tool ? { ...a, status: 'stale' as const } : a,
                ]),
              ),
            }
          : {}),
        ...(patch.kind === 'run_limits' && p.limits
          ? { limits: { ...p.limits, ...patch.after } }
          : {}),
      };
    }
    case 'patch.activated': {
      const patch = p.patches[event.payload.patchId];
      if (!patch) return p;
      const activation =
        'executionId' in event.payload
          ? { executionIds: [...patch.executionIds, event.payload.executionId] }
          : { iterationIds: [...patch.iterationIds, event.payload.iterationId] };
      return { ...p, patches: { ...p.patches, [patch.patchId]: { ...patch, ...activation } } };
    }
    case 'runtime.checkpoint_created':
      return {
        ...p,
        runtimeCheckpoints: {
          ...p.runtimeCheckpoints,
          [event.payload.checkpointId]: event.payload,
        },
      };
    case 'runtime.checkpoint_skipped':
      return p;
    case 'context.compaction_changed':
      return { ...p, compactions: { ...p.compactions, [event.payload.commandId]: event.payload } };
    case 'work_plan.updated':
      return {
        ...p,
        workPlans: {
          ...p.workPlans,
          [event.payload.scope === 'team' ? 'team' : event.payload.executionId]: event.payload,
        },
      };
    case 'budget.reserved':
    case 'budget.settled':
      return { ...p, budget: applyBudgetEvent(p.budget, event) };
    // Committed facts that later phases project (review P5, Reins P6, budget P7). Until then
    // they are kept in the log only.
    case 'harness.loaded':
    case 'harness.simulated':
    case 'harness.tools_updated':
    case 'recipe.evaluated':
    case 'recipe.stopped':
    case 'harness.load_failed':
    case 'user_input.requested':
    case 'user_input.answered':
    case 'user_input.closed':
    case 'extension.ui_requested':
    case 'extension.ui_answered':
    case 'extension.ui_expired':
    case 'extension.ui_notified':
    case 'model.request_recorded':
    case 'skill.read':
    case 'limit.reached':
    case 'cancel.requested':
    case 'cancel.confirmed':
    case 'observation.late':
      return p;
    case 'decision.requested': {
      const { decisionId, provider, privacy, subject } = event.payload;
      const view: DecisionView = {
        decisionId,
        provider,
        privacy,
        executionId: subject.executionId,
        modelCallId: subject.modelCallId,
        status: 'requested',
        answer: null,
        probabilities: null,
        evidenceLevel: null,
        reason: null,
        latencyMs: null,
        readyBeforeDispatch: null,
        afterRequestFinished: null,
      };
      return { ...p, decisions: { ...(p.decisions ?? {}), [decisionId]: view } };
    }
    case 'decision.observed': {
      const current = p.decisions?.[event.payload.decisionId];
      if (!current) return p;
      const o = event.payload;
      return {
        ...p,
        decisions: {
          ...p.decisions,
          [o.decisionId]: {
            ...current,
            status: 'observed',
            answer: o.answer,
            probabilities: o.probabilities,
            evidenceLevel: o.evidenceLevel,
            latencyMs: o.latencyMs,
            readyBeforeDispatch: o.readyBeforeDispatch,
            afterRequestFinished: o.afterRequestFinished,
          },
        },
      };
    }
    case 'decision.failed': {
      const current = p.decisions?.[event.payload.decisionId];
      if (!current) return p;
      return {
        ...p,
        decisions: {
          ...p.decisions,
          [event.payload.decisionId]: {
            ...current,
            status: 'failed',
            reason: event.payload.reason,
            latencyMs: event.payload.latencyMs,
          },
        },
      };
    }
  }
}

function executionCreated(p: RunProjection, event: EventOf<'execution.created'>): RunProjection {
  const { executionId, nodeId, taskId, attemptNo, parentExecutionId, depth, iterationId } =
    event.payload;
  const execution: ExecutionView = {
    ...(event.payload.candidateId ? { candidateId: event.payload.candidateId } : {}),
    executionId,
    nodeId,
    taskId,
    attemptNo,
    parentExecutionId,
    previousExecutionId: event.payload.previousExecutionId ?? null,
    ...(event.payload.item ? { item: event.payload.item } : {}),
    depth,
    iterationId,
    modelProfile: event.payload.modelProfile,
    configRevision: event.payload.configRevision ?? 0,
    criteriaVersionId: event.payload.criteriaVersionId ?? p.currentCriteriaVersionId,
    status: 'queued',
    activity: null,
    waitingOn: null,
    modelCallIds: [],
    error: null,
  };
  return {
    ...p,
    executions: { ...p.executions, [executionId]: execution },
    executionOrder: [...p.executionOrder, executionId],
    nodeExecutions: {
      ...p.nodeExecutions,
      [nodeId]: [...(p.nodeExecutions[nodeId] ?? []), executionId],
    },
  };
}

function executionSettled(p: RunProjection, event: EventOf<'execution.settled'>): RunProjection {
  const { executionId, outcome, error } = event.payload;
  const settled = updateExecution(p, executionId, {
    status: outcome,
    activity: null,
    waitingOn: null,
    error: error ?? null,
  });
  const execution = settled.executions[executionId];
  const task = execution ? settled.tasks[execution.taskId] : undefined;
  if (!task || task.activeExecutionId !== executionId) return settled;
  const unfinished = task.status !== 'completed' && outcome !== 'succeeded';
  return updateTask(settled, task.taskId, {
    activeExecutionId: null,
    ...(unfinished ? { status: outcome === 'cancelled' ? 'cancelled' : 'failed' } : {}),
  });
}

function updateExecution(
  p: RunProjection,
  id: string,
  change: Partial<ExecutionView>,
): RunProjection {
  const current = p.executions[id];
  if (!current) return p;
  return { ...p, executions: { ...p.executions, [id]: { ...current, ...change } } };
}

function updateTask(p: RunProjection, id: string, change: Partial<TaskView>): RunProjection {
  const current = p.tasks[id];
  if (!current) return p;
  return { ...p, tasks: { ...p.tasks, [id]: { ...current, ...change } } };
}

function updateDirective(
  p: RunProjection,
  id: string,
  change: Partial<DirectiveView>,
): RunProjection {
  const current = p.directives[id];
  if (!current) return p;
  return { ...p, directives: { ...p.directives, [id]: { ...current, ...change } } };
}

function updateModelCall(
  p: RunProjection,
  id: string,
  change: Partial<ModelCallView>,
): RunProjection {
  const current = p.modelCalls[id];
  if (!current) return p;
  return { ...p, modelCalls: { ...p.modelCalls, [id]: { ...current, ...change } } };
}

/**
 * Directives directly applied to an artifact: those fixed into the snapshot of the model
 * request that produced it. Acceptance time is never used (RNS-010, INV-07).
 */
export function directDirectivesForArtifact(
  projection: RunProjection,
  artifactVersionId: string,
): string[] {
  const modelCallId = projection.artifacts[artifactVersionId]?.modelCallId;
  if (!modelCallId) return [];
  return (projection.modelCalls[modelCallId]?.directiveIds ?? []).filter(
    (id) =>
      projection.directives[id]?.status === 'delivered' &&
      projection.directives[id]?.modelCallId === modelCallId,
  );
}

/** Data paths only: direct request directives and indirect input version ancestry. */
export function artifactLineage(projection: RunProjection, artifactVersionId: string) {
  const artifact = projection.artifacts[artifactVersionId];
  const directDirectiveIds = directDirectivesForArtifact(projection, artifactVersionId);
  const indirect = new Set<string>();
  const visited = new Set<string>([artifactVersionId]);
  const walk = (id: string) => {
    if (visited.has(id)) return;
    visited.add(id);
    for (const directive of directDirectivesForArtifact(projection, id)) indirect.add(directive);
    for (const input of projection.artifacts[id]?.inputArtifactVersionIds ?? []) walk(input);
  };
  for (const id of artifact?.inputArtifactVersionIds ?? []) walk(id);
  return {
    directDirectiveIds,
    indirectDirectiveIds: [...indirect].filter((id) => !directDirectiveIds.includes(id)),
    inputArtifactVersionIds: artifact?.inputArtifactVersionIds ?? [],
    configRevision: artifact?.configRevision ?? 0,
    criteriaVersionId: artifact?.criteriaVersionId ?? null,
  };
}
