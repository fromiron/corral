import { z } from 'zod';
import { OutputContract, RunLimits } from './definition.ts';
import { Identifier, SchemaVersion } from './ids.ts';
import { ExecutionActivity, ExecutionStatus, RunStatus } from './states.ts';

// RunEvent = envelope (contracts/event-envelope.schema.json) + typed payload.
// P0 covers the events of a linear mock run and directive delivery; C-005 completes the catalog.

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

export const RunStarted = event(
  'run.started',
  z.strictObject({
    corralId: Identifier,
    definitionHash: Sha256Hex,
    mode: z.enum(['mock', 'live']),
    limits: RunLimits,
  }),
);
export const RunStateChanged = event(
  'run.state_changed',
  z.strictObject({ from: RunStatus, to: RunStatus, reasonCode: z.string().min(1) }),
);
export const TaskCreated = event(
  'task.created',
  z.strictObject({
    taskId: Identifier,
    nodeId: Identifier,
    roleId: Identifier,
    contract: OutputContract,
    dependsOnTaskIds: z.array(Identifier),
  }),
);
export const ExecutionCreated = event(
  'execution.created',
  z.strictObject({
    executionId: Identifier,
    parentExecutionId: Identifier.nullable(),
    nodeId: Identifier,
    taskId: Identifier,
    attemptNo: z.int().min(1),
    depth: z.int().min(0).max(2),
    iterationId: Identifier.nullable(),
    modelProfile: Identifier,
  }),
);
export const TaskAttemptAssigned = event(
  'task.attempt_assigned',
  z.strictObject({ taskId: Identifier, executionId: Identifier, attemptNo: z.int().min(1) }),
);
export const ExecutionStateChanged = event(
  'execution.state_changed',
  z.strictObject({
    executionId: Identifier,
    from: ExecutionStatus,
    to: ExecutionStatus,
    activity: ExecutionActivity.nullable(),
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
export const ModelRequestPrepared = event(
  'model.request_prepared',
  z.strictObject({
    executionId: Identifier,
    modelCallId: Identifier,
    contextSnapshotId: Identifier,
    profile: Identifier,
    configRevision: z.int().min(0),
    directiveIds: z.array(Identifier),
    inputArtifactVersionIds: z.array(Identifier),
  }),
);
export const ModelFinished = event(
  'model.finished',
  z.strictObject({
    executionId: Identifier,
    modelCallId: Identifier,
    usage: z.strictObject({
      inputTokens: z.int().min(0).nullable(),
      outputTokens: z.int().min(0).nullable(),
    }),
    certainty: z.enum(['reported', 'estimated', 'unknown']),
  }),
);
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
  z.strictObject({ directiveId: Identifier, modelCallId: Identifier }),
);
export const DirectiveUndelivered = event(
  'directive.undelivered',
  z.strictObject({
    directiveId: Identifier,
    status: z.enum(['not_delivered', 'expired', 'delivery_unknown']),
    reason: z.string().min(1),
  }),
);
export const ToolRequested = event(
  'tool.requested',
  z.strictObject({ executionId: Identifier, toolCallId: Identifier, name: z.string().min(1) }),
);
export const ToolBlocked = event(
  'tool.blocked',
  z.strictObject({ executionId: Identifier, toolCallId: Identifier, reason: z.string().min(1) }),
);
export const ArtifactVersionCreated = event(
  'artifact.version_created',
  z.strictObject({
    artifactId: Identifier,
    version: z.int().min(1),
    artifactVersionId: Identifier,
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
export const TaskSubmitted = event(
  'task.submitted',
  z.strictObject({ taskId: Identifier, artifactVersionIds: z.array(Identifier).min(1) }),
);
export const TaskCompleted = event(
  'task.completed',
  z.strictObject({ taskId: Identifier, completionEvidence: z.string().min(1) }),
);
export const OutputFinalized = event(
  'output.finalized',
  z.strictObject({
    nodeId: Identifier,
    artifactVersionIds: z.array(Identifier).min(1),
    approvalId: Identifier.nullable(),
  }),
);

export const RunEvent = z.discriminatedUnion('type', [
  RunStarted,
  RunStateChanged,
  TaskCreated,
  ExecutionCreated,
  TaskAttemptAssigned,
  ExecutionStateChanged,
  ExecutionSettled,
  ModelRequestPrepared,
  ModelFinished,
  DirectiveAccepted,
  DirectiveAttached,
  DirectiveDispatched,
  DirectiveUndelivered,
  ToolRequested,
  ToolBlocked,
  ArtifactVersionCreated,
  TaskSubmitted,
  TaskCompleted,
  OutputFinalized,
]);
export type RunEvent = z.infer<typeof RunEvent>;
export type RunEventType = RunEvent['type'];
export type EventOf<T extends RunEventType> = Extract<RunEvent, { type: T }>;
export type EventPayload<T extends RunEventType> = EventOf<T>['payload'];

/** Transient text delta (ADR-011). Never persisted, never part of the projection. */
export interface StreamFrame {
  runId: string;
  modelCallId: string;
  chunkIndex: number;
  text: string;
}
