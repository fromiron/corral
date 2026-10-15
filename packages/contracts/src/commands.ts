import { z } from 'zod';
import { CorralDefinition } from './definition.ts';
import { Identifier, SchemaVersion } from './ids.ts';

// Commands from contracts/command.schema.json. A command is an intent; the Coordinator
// decides whether it becomes events (Technical-Design §5.2).

const base = {
  schemaVersion: SchemaVersion,
  commandId: Identifier,
  runId: Identifier,
};
const ControlRevision = z.int().min(0).max(1_000_000);
/** Optional for steer/pause/resume/cancel; required where a stale view would be harmful. */
const optionalRevision = { ...base, expectedControlRevision: ControlRevision.optional() };
const requiredRevision = { ...base, expectedControlRevision: ControlRevision };

export const SteerCommand = z.strictObject({
  ...optionalRevision,
  type: z.literal('steer'),
  payload: z.strictObject({
    targetExecutionId: Identifier,
    text: z.string().min(1).max(12000),
    delivery: z.literal('next_request'),
  }),
});
export type SteerCommand = z.infer<typeof SteerCommand>;

const RunScope = z.strictObject({ scope: z.literal('run') });

export const PauseCommand = z.strictObject({
  ...optionalRevision,
  type: z.literal('pause'),
  payload: RunScope,
});
export type PauseCommand = z.infer<typeof PauseCommand>;

export const ResumeCommand = z.strictObject({
  ...optionalRevision,
  type: z.literal('resume'),
  payload: RunScope,
});
export type ResumeCommand = z.infer<typeof ResumeCommand>;

export const CancelScope = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('run') }),
  z.strictObject({ kind: z.literal('execution'), executionId: Identifier }),
  z.strictObject({ kind: z.literal('task'), taskId: Identifier }),
]);
export type CancelScope = z.infer<typeof CancelScope>;

export const CancelCommand = z.strictObject({
  ...optionalRevision,
  type: z.literal('cancel'),
  payload: z.strictObject({ scope: CancelScope, reason: z.string().min(1) }),
});
export type CancelCommand = z.infer<typeof CancelCommand>;

// A future-node patch must change something; only model profile and prompt are patchable
// (RNS-009: no structure, permission or tool changes during a run).
const nodeFuture = { kind: z.literal('node_future'), nodeId: Identifier };
export const PatchPayload = z.union([
  z.strictObject({ ...nodeFuture, modelProfile: Identifier, prompt: z.string().min(1).optional() }),
  z.strictObject({ ...nodeFuture, modelProfile: Identifier.optional(), prompt: z.string().min(1) }),
  z.strictObject({
    kind: z.literal('loop_limit'),
    nodeId: Identifier,
    maxIterations: z.int().min(1).max(10),
  }),
  z.strictObject({
    kind: z.literal('run_limits'),
    changes: z
      .strictObject({
        maxSpawns: z.int().min(1).max(32).optional(),
        maxModelCalls: z.int().min(1).max(100).optional(),
        maxOutputTokens: z.int().min(1).max(256000).optional(),
      })
      .refine((changes) => Object.keys(changes).length > 0, 'at least one limit must change')
      .meta({ minProperties: 1 }),
  }),
  z.strictObject({
    kind: z.literal('criteria'),
    baseCriteriaVersionId: Identifier,
    criteria: z.array(z.string().min(1)).min(1).max(20),
  }),
]);
export type PatchPayload = z.infer<typeof PatchPayload>;

export const PatchCommand = z.strictObject({
  ...requiredRevision,
  type: z.literal('patch'),
  payload: PatchPayload,
});
export type PatchCommand = z.infer<typeof PatchCommand>;

export const ResolveApprovalCommand = z.strictObject({
  ...requiredRevision,
  type: z.literal('resolve_approval'),
  payload: z.strictObject({
    approvalId: Identifier,
    decision: z.enum(['approve', 'reject']),
    subjectVersionId: Identifier,
  }),
});
export type ResolveApprovalCommand = z.infer<typeof ResolveApprovalCommand>;

export const RestartTaskCommand = z.strictObject({
  ...requiredRevision,
  type: z.literal('restart_task'),
  payload: z.strictObject({
    taskId: Identifier,
    previousExecutionId: Identifier,
    instruction: z.string().min(1),
  }),
});
export type RestartTaskCommand = z.infer<typeof RestartTaskCommand>;

export const RunCommand = z.discriminatedUnion('type', [
  SteerCommand,
  PauseCommand,
  ResumeCommand,
  CancelCommand,
  PatchCommand,
  ResolveApprovalCommand,
  RestartTaskCommand,
]);
export type RunCommand = z.infer<typeof RunCommand>;
export type RunCommandType = RunCommand['type'];

/** POST /runs: start a run from a validated definition snapshot. */
export const StartRunRequest = z.strictObject({
  schemaVersion: SchemaVersion,
  commandId: Identifier,
  definition: CorralDefinition,
  mode: z.enum(['mock', 'live']),
});
export type StartRunRequest = z.infer<typeof StartRunRequest>;
