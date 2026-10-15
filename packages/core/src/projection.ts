import type {
  DirectiveStatus,
  EventOf,
  ExecutionActivity,
  ExecutionStatus,
  OutputContract,
  RunEvent,
  RunStatus,
  TaskStatus,
  WaitingOn,
} from '@corral/contracts';

// Read model rebuilt only from committed events (INV-14). The same reducer runs in the
// coordinator and in every client, so a replayed log and a live view cannot drift.

export interface ExecutionView {
  executionId: string;
  nodeId: string;
  taskId: string;
  attemptNo: number;
  parentExecutionId: string | null;
  depth: number;
  iterationId: string | null;
  modelProfile: string;
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
  modelCallId: string;
  executionId: string;
  contextSnapshotId: string;
  profile: string;
  directiveIds: string[];
  inputArtifactVersionIds: string[];
  finished: boolean;
  usage: { inputTokens: number | null; outputTokens: number | null } | null;
  certainty: 'reported' | 'estimated' | 'unknown' | null;
}

export interface ArtifactVersionView {
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
}

export interface ToolCallView {
  toolCallId: string;
  executionId: string;
  name: string;
  status: 'requested' | 'blocked';
  reason: string | null;
}

export interface EffectView {
  effectId: string;
  kind: 'model_request' | 'tool' | 'spawn';
  scope: string;
  epoch: number;
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
  status: 'pending' | 'approved' | 'rejected';
}

export interface ReviewView {
  reviewVersionId: string;
  targetVersionId: string;
  criteriaVersionId: string;
  verdict: 'pass' | 'revise' | 'inconclusive';
  issues: { criterionId: string; reason: string; severity: 'required' | 'advisory' }[];
}

export interface RunProjection {
  runId: string;
  corralId: string | null;
  definitionHash: string | null;
  mode: 'mock' | 'live' | null;
  status: RunStatus;
  statusReason: string | null;
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
  /** Reviews as recorded by the runtime (C-027), in order. */
  reviews: Record<string, ReviewView>;
  /** Bumped by control changes (patches, P6); approvals and patches must name it. */
  controlRevision: number;
  /** The final approval behind the output, when the Output required one. */
  outputApprovalId: string | null;
  /** Versions each execution read through read_artifact, in order. */
  artifactReads: Record<string, string[]>;
  /** Iteration ids per Loop node, in round order. */
  loopIterations: Record<string, string[]>;
  /** Set when a backend restart ended the run (RUN-007). */
  interruptedBy: string | null;
  output: { nodeId: string; artifactVersionIds: string[] } | null;
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
    outputApprovalId: null,
    artifactReads: {},
    loopIterations: {},
    interruptedBy: null,
    output: null,
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
  return { ...reduce(projection, event), lastSeq: event.runSeq };
}

function reduce(p: RunProjection, event: RunEvent): RunProjection {
  switch (event.type) {
    case 'run.started':
      return {
        ...p,
        corralId: event.payload.corralId,
        definitionHash: event.payload.definitionHash,
        mode: event.payload.mode,
      };
    case 'run.state_changed':
      return { ...p, status: event.payload.to, statusReason: event.payload.reasonCode };
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
        directiveIds: event.payload.directiveIds,
        inputArtifactVersionIds: event.payload.inputArtifactVersionIds,
        finished: false,
        usage: null,
        certainty: null,
      };
      const execution = p.executions[executionId];
      const withCall = { ...p, modelCalls: { ...p.modelCalls, [modelCallId]: call } };
      if (!execution) return withCall;
      return updateExecution(withCall, executionId, {
        modelCallIds: [...execution.modelCallIds, modelCallId],
      });
    }
    case 'model.finished': {
      const { inputTokens, outputTokens } = event.payload.normalizedUsage;
      return updateModelCall(p, event.payload.modelCallId, {
        finished: true,
        usage: { inputTokens, outputTokens },
        certainty: event.payload.certainty,
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
    case 'tool.blocked': {
      const call = p.toolCalls[event.payload.toolCallId];
      if (!call) return p;
      const blocked: ToolCallView = { ...call, status: 'blocked', reason: event.payload.reason };
      return { ...p, toolCalls: { ...p.toolCalls, [call.toolCallId]: blocked } };
    }
    case 'artifact.version_created': {
      const { artifactVersionId, ...rest } = event.payload;
      const artifact: ArtifactVersionView = { artifactVersionId, ...rest, submitted: false };
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
      return { ...p, interruptedBy: event.payload.backendSessionId };
    case 'effect.admitted': {
      const { effectId, kind, scope, epoch } = event.payload;
      const effect: EffectView = {
        effectId,
        kind,
        scope,
        epoch,
        status: 'admitted',
        outcome: null,
      };
      return { ...p, effects: { ...p.effects, [effectId]: effect } };
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
    // Committed facts that later phases project (review P5, Reins P6, budget P7). Until then
    // they are kept in the log only.
    case 'task.blocked':
    case 'review.stale':
    case 'patch.committed':
    case 'patch.activated':
    case 'effect.dispatch_observed':
    case 'tool.allowed':
    case 'tool.started':
    case 'tool.finished':
    case 'budget.reserved':
    case 'budget.settled':
    case 'limit.reached':
    case 'cancel.requested':
    case 'cancel.confirmed':
    case 'observation.late':
      return p;
  }
}

function executionCreated(p: RunProjection, event: EventOf<'execution.created'>): RunProjection {
  const { executionId, nodeId, taskId, attemptNo, parentExecutionId, depth, iterationId } =
    event.payload;
  const execution: ExecutionView = {
    executionId,
    nodeId,
    taskId,
    attemptNo,
    parentExecutionId,
    depth,
    iterationId,
    modelProfile: event.payload.modelProfile,
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
  return projection.modelCalls[modelCallId]?.directiveIds ?? [];
}
