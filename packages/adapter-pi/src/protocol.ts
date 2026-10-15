import { Identifier } from '@corral/contracts';
import { z } from 'zod';

// Host ↔ worker frames (Technical-Design §7.4, C-017). Every frame names the protocol version
// and the execution the worker is bound to; the host checks both and drops the worker on any
// mismatch. Nothing the model writes decides which execution or permission a frame belongs to.
// Frames can carry an access token (`permit.apiKey`): they are never logged or stored.

export const PROTOCOL_VERSION = 1;

const head = {
  protocolVersion: z.literal(PROTOCOL_VERSION),
  executionId: Identifier,
};
const RequestId = z.string().regex(/^req_\d{1,9}$/);
const Text = z.string().max(4 * 1024 * 1024);
const Count = z.int().min(0).nullable();

export const WorkerUsage = z.strictObject({
  inputTokens: Count,
  outputTokens: Count,
  cachedInputTokens: Count,
  reasoningTokens: Count,
});

// ── worker → host ────────────────────────────────────────────────────────────

export const WorkerFrame = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('ready'), protocolVersion: z.literal(PROTOCOL_VERSION) }),
  z.strictObject({ type: z.literal('prepare_request'), ...head, requestId: RequestId }),
  z.strictObject({
    type: z.literal('authorize_tool'),
    ...head,
    requestId: RequestId,
    name: z.string().min(1).max(64),
    args: z.record(z.string(), z.unknown()),
  }),
  z.strictObject({
    type: z.literal('execute_tool'),
    ...head,
    requestId: RequestId,
    toolCallId: Identifier,
  }),
  z.strictObject({
    type: z.literal('observe'),
    ...head,
    modelCallId: Identifier,
    text: Text,
    usage: WorkerUsage,
    rawUsage: z.record(z.string(), z.unknown()).nullable(),
  }),
  z.strictObject({
    type: z.literal('stream'),
    ...head,
    modelCallId: Identifier,
    chunkIndex: z.int().min(0),
    text: Text,
  }),
  z.strictObject({
    type: z.literal('settled'),
    ...head,
    outcome: z.enum(['succeeded', 'failed', 'cancelled']),
    error: z.string().max(500).optional(),
  }),
]);
export type WorkerFrame = z.infer<typeof WorkerFrame>;

// ── host → worker ────────────────────────────────────────────────────────────

export const WorkerTool = z.enum([
  'write_artifact',
  'submit_result',
  'spawn_subagents',
  'await_tasks',
  'ask',
  'reply',
  'read_artifact',
]);
export type WorkerTool = z.infer<typeof WorkerTool>;

export const StartFrame = z.strictObject({
  type: z.literal('start'),
  ...head,
  model: z.strictObject({ provider: Identifier, modelId: z.string().min(1).max(200) }),
  role: z.strictObject({
    name: z.string().min(1),
    prompt: z.string().min(1),
    outputContract: z.string().min(1),
  }),
  inputs: z.array(
    z.strictObject({
      name: z.string().min(1),
      artifactVersionId: Identifier.nullable(),
      text: Text,
    }),
  ),
  /** The criteria version reviews must name, and the Loop round (null outside a Loop). */
  criteriaVersionId: Identifier,
  round: z.int().min(1).nullable(),
  /** Tools this execution may propose. The host still checks every call. */
  tools: z.array(WorkerTool),
  /** Why the execution exists: its own step, a delegated task, or a question to answer. */
  assignment: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('scheduled') }),
    z.strictObject({ kind: z.literal('delegated'), brief: Text }),
    z.strictObject({ kind: z.literal('question'), questionId: Identifier, body: Text }),
  ]),
  /** Callable nodes it may delegate to or ask, as named in the definition. */
  delegateTo: z.array(z.strictObject({ nodeId: Identifier, label: z.string() })),
  askTo: z.array(z.strictObject({ nodeId: Identifier, label: z.string() })),
});

export const HostFrame = z.discriminatedUnion('type', [
  StartFrame,
  z.strictObject({
    type: z.literal('permit'),
    ...head,
    requestId: RequestId,
    modelCallId: Identifier,
    maxOutputTokens: z.int().min(1),
    directives: z.array(z.strictObject({ directiveId: Identifier, text: Text })),
    /** Access token for this request only; refresh tokens never leave the host. */
    apiKey: z.string().min(1).nullable(),
  }),
  z.strictObject({
    type: z.literal('refused'),
    ...head,
    requestId: RequestId,
    reason: z.string().min(1).max(500),
  }),
  z.strictObject({
    type: z.literal('tool_authorization'),
    ...head,
    requestId: RequestId,
    ok: z.boolean(),
    toolCallId: Identifier,
    reason: z.string().max(500).optional(),
  }),
  z.strictObject({
    type: z.literal('tool_result'),
    ...head,
    requestId: RequestId,
    ok: z.boolean(),
    result: z.record(z.string(), z.unknown()).optional(),
    reason: z.string().max(500).optional(),
  }),
  z.strictObject({ type: z.literal('cancel'), ...head, reason: z.string().min(1).max(500) }),
]);
export type HostFrame = z.infer<typeof HostFrame>;
export type StartFrame = z.infer<typeof StartFrame>;
