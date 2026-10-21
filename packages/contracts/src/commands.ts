import { z } from 'zod';
import {
  ImageAttachment,
  ImageAttachments,
  TextAttachment,
  TextAttachments,
} from './attachments.ts';
import { AutoRoute } from './auto-team.ts';
import { CorralDefinition, RunInput } from './definition.ts';
import { ContentHash, ExtensionUiValue, HarnessOverrides, PermissionMode } from './harness.ts';
import { Identifier, SchemaVersion } from './ids.ts';
import { ReasoningPolicy, RoleRunOverrides } from './reasoning.ts';
import { UserAnswers } from './user-input.ts';

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
const nodeFuture = {
  kind: z.literal('node_future'),
  nodeId: Identifier,
  reasoning: ReasoningPolicy.optional(),
};
export const PatchPayload = z.union([
  z.strictObject({
    ...nodeFuture,
    modelProfile: Identifier.optional(),
    prompt: z.string().min(1).optional(),
    reasoning: ReasoningPolicy,
  }),
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

export const AnswerExtensionUiCommand = z.strictObject({
  ...requiredRevision,
  type: z.literal('answer_extension_ui'),
  payload: z.strictObject({
    requestId: Identifier,
    executionId: Identifier,
    attemptNo: z.int().min(1),
    value: ExtensionUiValue,
  }),
});
export type AnswerExtensionUiCommand = z.infer<typeof AnswerExtensionUiCommand>;

export const AnswerUserCommand = z.strictObject({
  ...requiredRevision,
  type: z.literal('answer_user'),
  payload: z.strictObject({
    requestId: Identifier,
    executionId: Identifier,
    attemptNo: z.int().min(1),
    schemaHash: ContentHash,
    answers: UserAnswers,
  }),
});
export type AnswerUserCommand = z.infer<typeof AnswerUserCommand>;

export const CompactContextCommand = z.strictObject({
  ...requiredRevision,
  type: z.literal('compact_context'),
  payload: z.strictObject({ executionId: Identifier, attemptNo: z.int().min(1) }),
});
export type CompactContextCommand = z.infer<typeof CompactContextCommand>;

export const RunCommand = z.discriminatedUnion('type', [
  CompactContextCommand,
  AnswerExtensionUiCommand,
  AnswerUserCommand,
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
/**
 * Start from a version of an earlier Run (CR-007): its text is copied into the new brief. The
 * new Run never refers to the old Run's versions.
 */
export const StartFrom = z.strictObject({ runId: Identifier, artifactVersionId: Identifier });
export type StartFrom = z.infer<typeof StartFrom>;

/** A path inside the work folder: relative, no `..`, no drive or leading slash (CR-016). */
const ReferencePath = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (path) =>
      !/^([/\\]|[A-Za-z]:)/.test(path) &&
      !path.includes('\\') &&
      !path.split('/').some((part) => part === '..' || part === '.'),
    'a reference path is relative to the work folder',
  );

/**
 * CR-016: what a person pointed at with `@`. A reference never grants a tool or a path; the run
 * reads files only through the tools its roles already have. A result is copied at this version.
 */
export const RunReference = z.discriminatedUnion('kind', [
  ImageAttachment,
  TextAttachment,
  z.strictObject({
    kind: z.literal('file'),
    path: ReferencePath,
    lines: z
      .strictObject({ start: z.int().min(1), end: z.int().min(1) })
      .refine((l) => l.end >= l.start, 'lines end before they start')
      .optional(),
  }),
  z.strictObject({ kind: z.literal('folder'), path: ReferencePath }),
  z.strictObject({ kind: z.literal('result'), runId: Identifier, artifactVersionId: Identifier }),
  z.strictObject({ kind: z.literal('run'), runId: Identifier }),
  z.strictObject({ kind: z.literal('role'), roleId: Identifier }),
]);
export type RunReference = z.infer<typeof RunReference>;
export const RunReferences = z
  .array(RunReference)
  .max(20)
  .refine(
    (refs) =>
      TextAttachments.safeParse(refs.filter((ref) => ref.kind === 'text_attachment')).success &&
      ImageAttachments.safeParse(refs.filter((ref) => ref.kind === 'image_attachment')).success,
    'invalid attachment count or duplicates',
  );

export const StartRunRequest = z.strictObject({
  permissionMode: PermissionMode.optional(),
  schemaVersion: SchemaVersion,
  commandId: Identifier,
  definition: CorralDefinition,
  mode: z.enum(['mock', 'live']),
  startFrom: StartFrom.optional(),
  /** The work session this run continues (CR-011); recorded with the run, not in its snapshot. */
  sessionId: Identifier.optional(),
  references: RunReferences.optional(),
  harnessOverrides: HarnessOverrides.optional(),
  roleOverrides: RoleRunOverrides.optional(),
  /** The auto choice this run's definition came from (CR-024); set by the runtime's starter. */
  autoRoute: AutoRoute.optional(),
});
export type StartRunRequest = z.infer<typeof StartRunRequest>;

/**
 * POST /api/v1/runs (API-Contract §1): start a run from a saved definition revision. The
 * runtime resolves and snapshots the definition; `input` replaces the saved brief and criteria.
 */
export const CreateRunRequest = z.strictObject({
  permissionMode: PermissionMode.optional(),
  schemaVersion: SchemaVersion,
  commandId: Identifier,
  corralId: Identifier,
  definitionRevision: z.int().min(1),
  input: RunInput.optional(),
  mode: z.enum(['mock', 'live']),
  startFrom: StartFrom.optional(),
  sessionId: Identifier.optional(),
  references: RunReferences.optional(),
  harnessOverrides: HarnessOverrides.optional(),
  roleOverrides: RoleRunOverrides.optional(),
});
export type CreateRunRequest = z.infer<typeof CreateRunRequest>;
