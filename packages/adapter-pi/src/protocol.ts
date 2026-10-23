import {
  CompactionReport,
  ContentHash,
  EffectiveHarnessSnapshot,
  ExtensionUiNotice,
  ExtensionUiRequest,
  ExtensionUiResult,
  HarnessReport,
  HarnessResource,
  HarnessToolsUpdate,
  Identifier,
  ImageInput,
  ItemRef,
  McpChallenge,
  MeetingRunOrigin,
  ModelRequestRecord,
  ProtectedContext,
  ProviderPayloadRecord,
  ReasoningCapabilities,
  ReasoningInput,
  ReasoningResolution,
  RegisteredMcpServer,
  ResourcePath,
  RuntimeCheckpointRecord,
  RuntimeCheckpointState,
  RuntimeContext,
  TaskBrief,
} from '@corral/contracts';
import { z } from 'zod';
import { EndpointSpec } from './endpoint.ts';

// Host ↔ worker frames (Technical-Design §7.4, C-017). Every frame names the protocol version
// and the execution the worker is bound to; the host checks both and drops the worker on any
// mismatch. Nothing the model writes decides which execution or permission a frame belongs to.
// Frames can carry an access token (`permit.apiKey`): they are never logged or stored.

export const PROTOCOL_VERSION = 6;
export const LEGACY_PROTOCOL_VERSION = 5;

const head = {
  protocolVersion: z.literal(LEGACY_PROTOCOL_VERSION),
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
  z.strictObject({ type: z.literal('ready'), protocolVersion: z.literal(LEGACY_PROTOCOL_VERSION) }),
  z.strictObject({ type: z.literal('get_protected_context'), ...head, requestId: RequestId }),
  z.strictObject({
    type: z.literal('checkpoint_context'),
    ...head,
    requestId: RequestId,
    value: RuntimeContext,
  }),
  z.strictObject({
    type: z.literal('prepare_request'),
    ...head,
    requestId: RequestId,
    record: ModelRequestRecord.optional(),
    reasoningInput: ReasoningInput.optional(),
  }),
  z.strictObject({
    type: z.literal('request_record'),
    ...head,
    requestId: RequestId,
    ...ProviderPayloadRecord.shape,
  }),
  z.strictObject({ type: z.literal('request_dispatched'), ...head, modelCallId: Identifier }),
  z.strictObject({
    type: z.literal('authorize_tool'),
    ...head,
    requestId: RequestId,
    name: z.string().min(1).max(64),
    args: z.record(z.string(), z.unknown()),
    parentToolCallId: Identifier.optional(),
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
    finalTextModelCallId: Identifier.optional(),
    outcome: z.enum(['succeeded', 'failed', 'cancelled']),
    error: z.string().max(500).optional(),
  }),
]);
export type WorkerFrame = z.infer<typeof WorkerFrame>;

// ── host → worker ────────────────────────────────────────────────────────────

export const WorkerTool = z.enum([
  'search',
  'read_document',
  'write_artifact',
  'generate_image',
  'preview_file',
  'preview_app',
  'preview_action',
  'list_files',
  'read_file',
  'write_file',
  'delete_file',
  'move_file',
  'run_command',
  'read_hashline',
  'edit_hashline',
  'submit_result',
  'ask_user',
  'update_plan',
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
  meeting: MeetingRunOrigin.optional(),
  reasoningCapabilities: ReasoningCapabilities.optional(),
  model: z.strictObject({
    contextWindow: z.int().min(1).max(10_000_000).optional(),
    provider: Identifier,
    modelId: z.string().min(1).max(200),
    auth: z.enum(['oauth', 'api_key', 'mock']).optional(),
    /** An OpenAI-compatible endpoint's non-secret definition (CR-005); absent for pi-ai's own. */
    endpoint: EndpointSpec.optional(),
  }),
  role: z.strictObject({
    name: z.string().min(1),
    prompt: z.string().min(1),
    outputContract: z.string().min(1),
    imageProfile: Identifier.optional(),
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
  taskBrief: TaskBrief.optional(),
  resumeContext: RuntimeCheckpointState.optional(),
  images: z.array(ImageInput).max(3).optional(),
  teamPlanOwner: z.boolean().optional(),
  round: z.int().min(1).nullable(),
  item: ItemRef.optional(),
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
  askTo: z.array(
    z.strictObject({
      nodeId: Identifier,
      label: z.string(),
      delivery: z.literal('parent').optional(),
    }),
  ),
  replyToChildren: z.boolean().optional(),
});

export const HostFrame = z.discriminatedUnion('type', [
  StartFrame,
  z.strictObject({
    type: z.literal('runtime_checkpoint'),
    ...head,
    requestId: RequestId,
    value: RuntimeCheckpointRecord.nullable(),
  }),
  z.strictObject({
    type: z.literal('protected_context'),
    ...head,
    requestId: RequestId,
    value: ProtectedContext.nullable(),
  }),
  z.strictObject({ type: z.literal('directive'), ...head, directiveId: Identifier, text: Text }),
  z.strictObject({
    type: z.literal('reprepare'),
    ...head,
    requestId: RequestId,
    directives: z.array(z.strictObject({ directiveId: Identifier, text: Text })),
  }),
  z.strictObject({ type: z.literal('ack'), ...head, requestId: RequestId }),
  z.strictObject({
    type: z.literal('permit'),
    reasoning: ReasoningResolution.optional(),
    ...head,
    requestId: RequestId,
    modelCallId: Identifier,
    maxOutputTokens: z.int().min(1),
    directives: z.array(z.strictObject({ directiveId: Identifier, text: Text })),
    parentQuestions: z
      .array(
        z.strictObject({
          questionId: Identifier,
          senderExecutionId: Identifier,
          body: Text,
          artifactRefs: z.array(Identifier),
          deadline: z.string().min(1),
        }),
      )
      .optional(),
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

/** Private IPC configuration. Never persisted in run events or exports. */
export const SdkResources = z.strictObject({
  cwd: z.string().min(1).optional(),
  mcp: z
    .array(z.strictObject({ server: RegisteredMcpServer, fingerprint: ContentHash }))
    .max(16)
    .optional(),
  bundles: z
    .array(
      z.strictObject({
        root: z.string().min(1),
        hash: ContentHash,
        files: HarnessResource.shape.files,
      }),
    )
    .max(64),
  extensions: z
    .array(
      z.strictObject({ path: z.string().min(1), hash: ContentHash, source: z.string().min(1) }),
    )
    .max(64),
  skills: z
    .array(
      z.strictObject({
        name: Identifier,
        description: z.string().max(1000),
        hash: ContentHash,
        entry: ResourcePath,
        mode: z.enum(['auto', 'explicit', 'mandatory']),
        content: z.string().max(64 * 1024),
      }),
    )
    .max(64),
  startupCommands: z.array(z.string().min(1).max(1000)).max(16),
});
export type SdkResources = z.infer<typeof SdkResources>;
const sdkHead = { protocolVersion: z.literal(PROTOCOL_VERSION), executionId: Identifier };
export const SdkStartFrame = StartFrame.extend({
  ...sdkHead,
  compaction: z
    .strictObject({ reserveTokens: z.int().min(0), keepRecentTokens: z.int().min(0) })
    .optional(),
  tools: z.array(
    z.union([WorkerTool, z.enum(['read', 'edit', 'write', 'run_check', 'lsp_query'])]),
  ),
  harness: EffectiveHarnessSnapshot,
  resources: SdkResources,
});
export type SdkStartFrame = z.infer<typeof SdkStartFrame>;
export const SdkWorkerFrame = z.union([
  z.strictObject({
    type: z.literal('compaction_report'),
    ...sdkHead,
    requestId: RequestId,
    report: CompactionReport,
  }),
  z.strictObject({
    type: z.literal('mcp_authorization'),
    ...sdkHead,
    requestId: RequestId,
    serverId: Identifier,
    challenge: McpChallenge.optional(),
  }),
  z.strictObject({
    type: z.literal('ui_request'),
    ...sdkHead,
    requestId: RequestId,
    request: ExtensionUiRequest,
  }),
  z.strictObject({ type: z.literal('ui_cancel'), ...sdkHead, requestId: RequestId }),
  z.strictObject({
    type: z.literal('ui_notice'),
    ...sdkHead,
    requestId: RequestId,
    notice: ExtensionUiNotice,
  }),
  ...WorkerFrame.options.map((frame) =>
    frame.extend({ protocolVersion: z.literal(PROTOCOL_VERSION) }),
  ),
  z.strictObject({
    type: z.literal('prepare_request'),
    ...sdkHead,
    requestId: RequestId,
    ...ModelRequestRecord.shape,
    reasoningInput: ReasoningInput.optional(),
  }),
  z.strictObject({
    type: z.literal('request_dispatched'),
    ...sdkHead,
    requestId: RequestId,
    modelCallId: Identifier,
  }),
  z.strictObject({
    type: z.literal('harness_report'),
    ...sdkHead,
    requestId: RequestId,
    report: HarnessReport,
  }),
  z.strictObject({
    type: z.literal('harness_tools'),
    ...sdkHead,
    requestId: RequestId,
    update: HarnessToolsUpdate,
  }),
  z.strictObject({
    type: z.literal('native_tool_start'),
    ...sdkHead,
    requestId: RequestId,
    toolCallId: Identifier,
    argsHash: ContentHash,
  }),
  z.strictObject({
    type: z.literal('native_tool_finish'),
    ...sdkHead,
    requestId: RequestId,
    toolCallId: Identifier,
    outcome: z.enum(['succeeded', 'failed']),
  }),
]);
export type SdkWorkerFrame = z.infer<typeof SdkWorkerFrame>;
export const SdkHostFrame = z.union([
  z.strictObject({ type: z.literal('compact'), ...sdkHead, commandId: Identifier }),
  z.strictObject({
    type: z.literal('mcp_authorization'),
    ...sdkHead,
    requestId: RequestId,
    token: z.string().max(16000).optional(),
  }),
  z.strictObject({
    type: z.literal('ui_answer'),
    ...sdkHead,
    requestId: RequestId,
    result: ExtensionUiResult,
  }),
  ...HostFrame.options
    .filter((frame) => frame.shape.type.value !== 'start')
    .map((frame) => frame.extend({ protocolVersion: z.literal(PROTOCOL_VERSION) })),
  SdkStartFrame,
]);
export type SdkHostFrame = z.infer<typeof SdkHostFrame>;
