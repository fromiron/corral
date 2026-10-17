import { z } from 'zod';
import { CancelScope, StartFrom } from './commands.ts';
import {
  DecisionFailureReason,
  DecisionPrivacy,
  DecisionQuestionKind,
  DecisionSubject,
  EffortFeatures,
  EffortLevel,
  EvidenceLevel,
  RunDecisionSettings,
} from './decisions.ts';
import { ItemRef, OutputContract, RunLimits } from './definition.ts';
import {
  ContentHash,
  EffectiveHarnessSnapshot,
  HarnessReport,
  HarnessToolsUpdate,
  ModelRequestRecord,
  ProviderPayloadRecord,
} from './harness.ts';
import { Identifier, SchemaVersion } from './ids.ts';
import { ReviewIssue } from './review.ts';
import { RecipeStopReason } from './review-recipe.ts';
import { ExecutionActivity, ExecutionStatus, ReviewVerdict, RunStatus } from './states.ts';

// RunEvent = envelope (contracts/event-envelope.schema.json) + a typed payload for each entry
// of contracts/event-catalog.json. Events are committed facts; commands are only intents.

const envelope = {
  schemaVersion: SchemaVersion,
  eventId: Identifier,
  runId: Identifier,
  runSeq: z.int().min(1).max(1_000_000),
  recordedAt: z.iso.datetime(),
  actor: z.strictObject({ kind: z.enum(['user', 'runtime', 'agent']), id: Identifier }),
  executionId: Identifier.optional(),
  taskId: Identifier.optional(),
  commandId: Identifier.optional(),
  causedByEventIds: z.array(Identifier).max(30),
};

const event = <T extends string, P extends z.ZodType>(type: T, payload: P) =>
  z.strictObject({ ...envelope, type: z.literal(type), payload });

const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const IsoTime = z.iso.datetime();
const Count = z.int().min(0);
const Ids = z.array(Identifier);

/** Structured wait reason (Technical-Design §6.2); never free text only. */
export const WaitingOn = z.strictObject({
  kind: z.enum(['children', 'message', 'approval', 'user']),
  targetIds: Ids,
  reasonCode: z.string().min(1),
  since: IsoTime,
  deadline: IsoTime.nullable(),
  required: z.boolean(),
});
export type WaitingOn = z.infer<typeof WaitingOn>;

export const ModelProfileSnapshot = z.strictObject({
  profile: Identifier,
  provider: Identifier.nullable(),
  modelId: z.string().min(1).nullable(),
  auth: z.enum(['oauth', 'api_key', 'mock']),
});
export type ModelProfileSnapshot = z.infer<typeof ModelProfileSnapshot>;

/** Provider-specific counts stay raw; normalized fields are null when not reported (INV-15). */
export const NormalizedUsage = z.strictObject({
  inputTokens: Count.nullable(),
  outputTokens: Count.nullable(),
  cachedInputTokens: Count.nullable(),
  reasoningTokens: Count.nullable(),
});
export type NormalizedUsage = z.infer<typeof NormalizedUsage>;

// ── run ──────────────────────────────────────────────────────────────────────
export const RunStarted = event(
  'run.started',
  z.strictObject({
    corralId: Identifier,
    definitionHash: Sha256Hex,
    inputHash: Sha256Hex,
    mode: z.enum(['mock', 'live']),
    modelProfiles: z.array(ModelProfileSnapshot),
    limits: RunLimits,
    criteriaVersionId: Identifier.optional(),
    /** Judgment settings fixed for the run (CR-003). Absent when the runtime has none. */
    decisions: RunDecisionSettings.optional(),
    /** The earlier version whose text this run's brief starts from (CR-007). */
    startedFrom: StartFrom.optional(),
    harnesses: z.record(Identifier, EffectiveHarnessSnapshot).optional(),
  }),
);
export const RunStateChanged = event(
  'run.state_changed',
  z.strictObject({ from: RunStatus, to: RunStatus, reasonCode: z.string().min(1) }),
);
export const RunInterrupted = event(
  'run.interrupted',
  z.strictObject({ previousStatus: RunStatus, backendSessionId: Identifier }),
);

// ── executions and tasks ─────────────────────────────────────────────────────
export const ExecutionCreated = event(
  'execution.created',
  z.strictObject({
    executionId: Identifier,
    parentExecutionId: Identifier.nullable(),
    previousExecutionId: Identifier.optional(),
    item: ItemRef.optional(),
    nodeId: Identifier,
    taskId: Identifier,
    attemptNo: z.int().min(1),
    depth: z.int().min(0).max(2),
    iterationId: Identifier.nullable(),
    modelProfile: Identifier,
    configRevision: z.int().min(0).optional(),
    criteriaVersionId: Identifier.optional(),
  }),
);
export const ExecutionStateChanged = event(
  'execution.state_changed',
  z.strictObject({
    executionId: Identifier,
    from: ExecutionStatus,
    to: ExecutionStatus,
    activity: ExecutionActivity.nullable(),
    waitingOn: WaitingOn.nullable(),
  }),
);
export const ExecutionSettled = event(
  'execution.settled',
  z.strictObject({
    executionId: Identifier,
    outcome: z.enum(['succeeded', 'failed', 'cancelled']),
    terminationMode: z.enum(['normal', 'forced', 'unconfirmed']),
    error: z.string().optional(),
  }),
);
export const TaskCreated = event(
  'task.created',
  z.strictObject({
    taskId: Identifier,
    nodeId: Identifier,
    roleId: Identifier,
    contract: OutputContract,
    dependsOnTaskIds: Ids,
  }),
);
export const TaskAttemptAssigned = event(
  'task.attempt_assigned',
  z.strictObject({ taskId: Identifier, executionId: Identifier, attemptNo: z.int().min(1) }),
);
export const TaskSubmitted = event(
  'task.submitted',
  z.strictObject({ taskId: Identifier, artifactVersionIds: Ids.min(1) }),
);
export const TaskCompleted = event(
  'task.completed',
  z.strictObject({ taskId: Identifier, completionEvidence: z.string().min(1) }),
);
export const TaskBlocked = event(
  'task.blocked',
  z.strictObject({
    taskId: Identifier,
    cause: z.string().min(1),
    requiredUserAction: z.enum(['restart_or_cancel', 'approve', 'none']),
  }),
);

// ── collaboration ────────────────────────────────────────────────────────────
export const QuestionCreated = event(
  'message.question_created',
  z.strictObject({
    questionId: Identifier,
    taskId: Identifier,
    senderExecutionId: Identifier,
    targetRoleId: Identifier,
    targetNodeId: Identifier,
    body: z.string().min(1).max(12000),
    artifactRefs: Ids,
    deadline: IsoTime,
  }),
);
export const AnswerCommitted = event(
  'message.answer_committed',
  z.strictObject({
    questionId: Identifier,
    responseTaskId: Identifier,
    responderExecutionId: Identifier,
    body: z.string().min(1).max(12000),
    evidenceRefs: Ids,
  }),
);
export const MessageClosed = event(
  'message.closed',
  z.strictObject({
    questionId: Identifier,
    outcome: z.enum(['answered', 'cancelled', 'timed_out']),
    answerRef: Identifier.nullable(),
  }),
);

// ── artifacts and review ─────────────────────────────────────────────────────
export const ArtifactVersionCreated = event(
  'artifact.version_created',
  z.strictObject({
    artifactId: Identifier,
    version: z.int().min(1),
    artifactVersionId: Identifier,
    parentVersionId: Identifier.nullable(),
    name: z.string().min(1),
    contract: OutputContract,
    contentHash: Sha256Hex,
    byteLength: z
      .int()
      .min(0)
      .max(1024 * 1024),
    authorExecutionId: Identifier,
    modelCallId: Identifier.nullable(),
    contextSnapshotId: Identifier.nullable(),
  }),
);
export const ArtifactRead = event(
  'artifact.read',
  z.strictObject({
    requestedRef: z.string().min(1),
    resolvedVersionId: Identifier,
    consumerExecutionId: Identifier,
  }),
);
export const ReviewRecorded = event(
  'review.recorded',
  z.strictObject({
    reviewVersionId: Identifier,
    targetVersionId: Identifier,
    criteriaVersionId: Identifier,
    verdict: ReviewVerdict,
    issues: z.array(ReviewIssue).max(20),
  }),
);
export const ReviewStale = event(
  'review.stale',
  z.strictObject({
    reviewVersionId: Identifier,
    newCriteriaVersionId: Identifier,
    cause: z.string().min(1),
  }),
);
const recipeHead = {
  loopNodeId: Identifier,
  recipeId: Identifier,
  revision: z.int().min(1),
  recipeHash: ContentHash,
  criteriaVersionId: Identifier,
};
export const RecipeEvaluated = event(
  'recipe.evaluated',
  z.strictObject({
    ...recipeHead,
    iterationId: Identifier,
    candidateVersionId: Identifier,
    reviewVersionId: Identifier,
    checkReportIds: Ids,
    tree: z
      .string()
      .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
      .nullable(),
    verdict: ReviewVerdict,
  }),
);
export const RecipeStopped = event(
  'recipe.stopped',
  z.strictObject({
    ...recipeHead,
    reason: RecipeStopReason,
    candidateVersionId: Identifier.nullable(),
  }),
);
export const LoopIterationStarted = event(
  'loop.iteration_started',
  z.strictObject({
    loopNodeId: Identifier,
    iterationId: Identifier,
    no: z.int().min(1).max(10),
    pinnedCarryInputs: Ids,
    criteriaVersionId: Identifier,
  }),
);
export const LoopIterationFinished = event(
  'loop.iteration_finished',
  z.strictObject({
    loopNodeId: Identifier,
    iterationId: Identifier,
    outcome: z.enum(['pass', 'revise', 'inconclusive', 'cap_reached', 'cancelled']),
    submittedVersionIds: Ids,
  }),
);
export const ApprovalRequested = event(
  'approval.requested',
  z.strictObject({
    approvalId: Identifier,
    kind: z.enum(['final_output', 'loop_cap', 'user_action']),
    subjectVersionIds: Ids,
    criteriaVersionId: Identifier.nullable(),
    tool: z
      .strictObject({
        purpose: z.enum(['check', 'lsp']).optional(),
        executionId: Identifier,
        attemptNo: z.int().min(1),
        effectId: Identifier,
        toolCallId: Identifier,
        bodyRef: Identifier,
        fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
        targetTree: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
        deadline: z.iso.datetime(),
      })
      .optional(),
  }),
);
export const ApprovalResolved = event(
  'approval.resolved',
  z.strictObject({
    approvalId: Identifier,
    decision: z.enum(['approve', 'reject']),
    actor: Identifier,
    subjectVersionIds: Ids,
    reason: z.enum(['cancelled', 'timeout', 'execution_ended']).optional(),
  }),
);
export const OutputFinalized = event(
  'output.finalized',
  z.strictObject({
    nodeId: Identifier,
    artifactVersionIds: Ids.min(1),
    approvalId: Identifier.nullable(),
  }),
);

// ── Reins ────────────────────────────────────────────────────────────────────
export const DirectiveAccepted = event(
  'directive.accepted',
  z.strictObject({
    directiveId: Identifier,
    targetExecutionId: Identifier,
    text: z.string().min(1).max(12000),
  }),
);
export const DirectiveAttached = event(
  'directive.attached',
  z.strictObject({
    directiveId: Identifier,
    contextSnapshotId: Identifier,
    modelCallId: Identifier,
  }),
);
export const DirectiveDispatched = event(
  'directive.dispatched',
  z.strictObject({
    directiveId: Identifier,
    modelCallId: Identifier,
    executionEpoch: z.int().min(1),
  }),
);
export const DirectiveUndelivered = event(
  'directive.undelivered',
  z.strictObject({
    directiveId: Identifier,
    status: z.enum(['not_delivered', 'expired', 'delivery_unknown']),
    reason: z.string().min(1),
  }),
);
export const PatchCommitted = event(
  'patch.committed',
  z.strictObject({
    patchId: Identifier,
    kind: z.enum(['node_future', 'loop_limit', 'run_limits', 'criteria']),
    scope: z.strictObject({ nodeId: Identifier.nullable() }),
    before: z.record(z.string(), z.unknown()),
    after: z.record(z.string(), z.unknown()),
    controlRevision: z.int().min(1),
  }),
);
export const PatchActivated = event(
  'patch.activated',
  z.union([
    z.strictObject({ patchId: Identifier, executionId: Identifier }),
    z.strictObject({ patchId: Identifier, iterationId: Identifier }),
  ]),
);
export const CancelRequested = event(
  'cancel.requested',
  z.strictObject({ scope: CancelScope, fenceSeq: z.int().min(1), reason: z.string().min(1) }),
);
export const CancelConfirmed = event(
  'cancel.confirmed',
  z.strictObject({ scope: CancelScope, settlementRefs: Ids, forced: z.boolean() }),
);

// ── effects, tools, models, budget ───────────────────────────────────────────
export const EffectAdmitted = event(
  'effect.admitted',
  z.strictObject({
    effectId: Identifier,
    kind: z.enum(['model_request', 'tool', 'spawn', 'decision']),
    scope: Identifier,
    epoch: z.int().min(1),
    reservationId: Identifier.nullable(),
  }),
);
export const EffectDispatchObserved = event(
  'effect.dispatch_observed',
  z.strictObject({ effectId: Identifier, providerRequestId: z.string().min(1).nullable() }),
);
export const EffectSettled = event(
  'effect.settled',
  z.strictObject({
    effectId: Identifier,
    outcome: z.enum(['succeeded', 'failed', 'cancelled', 'unknown']),
  }),
);
export const ToolRequested = event(
  'tool.requested',
  z.strictObject({
    executionId: Identifier,
    toolCallId: Identifier,
    name: z.string().min(1),
    /** Validated arguments; large values are replaced by size and hash. */
    validatedArgs: z.record(z.string(), z.unknown()),
  }),
);
export const ToolAllowed = event(
  'tool.allowed',
  z.strictObject({
    executionId: Identifier,
    toolCallId: Identifier,
    policyVersion: z.string().min(1),
  }),
);
export const ToolBlocked = event(
  'tool.blocked',
  z.strictObject({ executionId: Identifier, toolCallId: Identifier, reason: z.string().min(1) }),
);
export const ToolStarted = event(
  'tool.started',
  z.strictObject({
    executionId: Identifier,
    toolCallId: Identifier,
    effectId: Identifier,
    management: z.literal('unmanaged_native').optional(),
  }),
);
export const ToolFinished = event(
  'tool.finished',
  z.strictObject({
    executionId: Identifier,
    toolCallId: Identifier,
    resultRef: Identifier.nullable(),
    error: z.string().min(1).nullable(),
  }),
);
export const ModelRequestPrepared = event(
  'model.request_prepared',
  z.strictObject({
    executionId: Identifier,
    modelCallId: Identifier,
    contextSnapshotId: Identifier,
    profile: Identifier,
    configRevision: z.int().min(0),
    directiveIds: Ids,
    inputArtifactVersionIds: Ids,
  }),
);
export const ModelFinished = event(
  'model.finished',
  z.strictObject({
    executionId: Identifier,
    modelCallId: Identifier,
    responseRef: Identifier.nullable(),
    rawUsage: z.record(z.string(), z.unknown()).nullable(),
    normalizedUsage: NormalizedUsage,
    certainty: z.enum(['reported', 'estimated', 'unknown']),
  }),
);
export const ModelUsageReconciled = event(
  'model.usage_reconciled',
  ModelFinished.shape.payload.omit({ responseRef: true }),
);
export const BudgetReserved = event(
  'budget.reserved',
  z.strictObject({
    reservationId: Identifier,
    modelCallId: Identifier.nullable(),
    amount: z.strictObject({ outputTokens: Count, modelCalls: Count }),
    scope: Identifier,
  }),
);
export const BudgetSettled = event(
  'budget.settled',
  z.strictObject({
    reservationId: Identifier,
    actual: z.strictObject({ outputTokens: Count.nullable() }),
    unknownOutstanding: Count,
  }),
);
export const LimitReached = event(
  'limit.reached',
  z.strictObject({
    limitKind: z.enum([
      'model_calls',
      'output_tokens',
      'spawns',
      'questions',
      'depth',
      'loop_iterations',
      'deadline',
      'no_progress',
      'decision_calls',
    ]),
    used: Count,
    reserved: Count,
    max: Count,
  }),
);
export const ObservationLate = event(
  'observation.late',
  z.strictObject({
    originalEventType: z.string().min(1),
    originalRef: Identifier.nullable(),
    whyIgnored: z.string().min(1),
  }),
);

// ── decisions (CR-003, observe only) ─────────────────────────────────────────
const decisionHead = {
  decisionId: Identifier,
  questionKind: DecisionQuestionKind,
  questionVersion: z.int().min(1),
  provider: z.string().min(1),
  subject: DecisionSubject,
};
export const DecisionRequested = event(
  'decision.requested',
  z.strictObject({
    ...decisionHead,
    privacy: DecisionPrivacy,
    inputHash: Sha256Hex,
    features: EffortFeatures,
  }),
);
export const DecisionObserved = event(
  'decision.observed',
  z.strictObject({
    ...decisionHead,
    answer: EffortLevel,
    probabilities: z
      .strictObject({
        low: z.number(),
        medium: z.number(),
        high: z.number(),
        xhigh: z.number(),
      })
      .nullable(),
    evidenceLevel: EvidenceLevel,
    latencyMs: Count,
    /** The judgment was ready before the request it is about was sent. */
    readyBeforeDispatch: z.boolean(),
    afterRequestFinished: z.boolean(),
  }),
);
export const DecisionFailed = event(
  'decision.failed',
  z.strictObject({ ...decisionHead, reason: DecisionFailureReason, latencyMs: Count }),
);

export const HarnessLoaded = event('harness.loaded', HarnessReport.options[0].omit({ ok: true }));
export const HarnessToolsUpdated = event(
  'harness.tools_updated',
  HarnessToolsUpdate.omit({ expectedRevision: true }).extend({ revision: z.int().min(2) }),
);
export const HarnessLoadFailed = event(
  'harness.load_failed',
  HarnessReport.options[1].omit({ ok: true }),
);
export const ModelRequestRecorded = event(
  'model.request_recorded',
  ModelRequestRecord.extend({ modelCallId: Identifier, snapshotHash: ContentHash }),
);
export const ModelPayloadRecorded = event('model.payload_recorded', ProviderPayloadRecord);

const uiTarget = { requestId: Identifier, executionId: Identifier, attemptNo: z.int().min(1) };
export const ExtensionUiRequested = event(
  'extension.ui_requested',
  z.strictObject({
    ...uiTarget,
    kind: z.enum(['select', 'confirm', 'input']),
    bodyRef: Identifier,
    bodyHash: ContentHash,
    deadline: z.iso.datetime(),
  }),
);
export const ExtensionUiAnswered = event(
  'extension.ui_answered',
  z.strictObject({ ...uiTarget, answerRef: Identifier, answerHash: ContentHash }),
);
export const ExtensionUiExpired = event(
  'extension.ui_expired',
  z.strictObject({ ...uiTarget, reason: z.enum(['timeout', 'cancelled', 'execution_ended']) }),
);
export const ExtensionUiNotified = event(
  'extension.ui_notified',
  z.strictObject({
    executionId: Identifier,
    kind: z.enum(['notify', 'status', 'unsupported']),
    key: z.string().min(1).max(100),
    level: z.enum(['info', 'warning', 'error']),
    bodyRef: Identifier,
    bodyHash: ContentHash,
  }),
);

export const RunEvent = z.discriminatedUnion('type', [
  ExtensionUiRequested,
  ExtensionUiAnswered,
  ExtensionUiExpired,
  ExtensionUiNotified,
  HarnessLoaded,
  HarnessToolsUpdated,
  HarnessLoadFailed,
  ModelRequestRecorded,
  ModelPayloadRecorded,
  RunStarted,
  RunStateChanged,
  RunInterrupted,
  ExecutionCreated,
  ExecutionStateChanged,
  ExecutionSettled,
  TaskCreated,
  TaskAttemptAssigned,
  TaskSubmitted,
  TaskCompleted,
  TaskBlocked,
  QuestionCreated,
  AnswerCommitted,
  MessageClosed,
  ArtifactVersionCreated,
  ArtifactRead,
  ReviewRecorded,
  RecipeEvaluated,
  RecipeStopped,
  ReviewStale,
  LoopIterationStarted,
  LoopIterationFinished,
  ApprovalRequested,
  ApprovalResolved,
  DirectiveAccepted,
  DirectiveAttached,
  DirectiveDispatched,
  DirectiveUndelivered,
  PatchCommitted,
  PatchActivated,
  EffectAdmitted,
  EffectDispatchObserved,
  EffectSettled,
  ToolRequested,
  ToolAllowed,
  ToolBlocked,
  ToolStarted,
  ToolFinished,
  ModelRequestPrepared,
  ModelFinished,
  ModelUsageReconciled,
  BudgetReserved,
  BudgetSettled,
  LimitReached,
  CancelRequested,
  CancelConfirmed,
  ObservationLate,
  OutputFinalized,
  DecisionRequested,
  DecisionObserved,
  DecisionFailed,
]);
export type RunEvent = z.infer<typeof RunEvent>;
export type RunEventType = RunEvent['type'];
export type EventOf<T extends RunEventType> = Extract<RunEvent, { type: T }>;
export type EventPayload<T extends RunEventType> = EventOf<T>['payload'];

export const RUN_EVENT_TYPES: readonly RunEventType[] = RunEvent.options.map(
  (option) => option.shape.type.value,
);

/** Transient text delta (ADR-011). Never persisted, never part of the projection. */
export interface StreamFrame {
  runId: string;
  modelCallId: string;
  chunkIndex: number;
  text: string;
}
