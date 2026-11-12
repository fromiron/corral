import type { AgentRole, InputBindingKind, ItemRef, TaskBrief } from './definition.ts';
import type {
  EffortLevel,
  ReasoningResolution,
  RequestPreparation,
  RoutingFallbackReason,
  SettledBasis,
} from './effort-routing.ts';
import type { CommandError } from './errors.ts';
import type { DirectiveOrigin, ModelProfileSnapshot } from './events.ts';
import type {
  CompactionReport,
  EffectiveHarnessSnapshot,
  ExtensionUiNotice,
  ExtensionUiRequest,
  ExtensionUiResult,
  HarnessReport,
  HarnessToolsUpdate,
  ModelRequestRecord,
  ProtectedContext,
  ProviderPayloadRecord,
} from './harness.ts';
import type { MeetingRunOrigin } from './meeting.ts';
import type { McpChallenge } from './project-tools.ts';
import type {
  RuntimeCheckpointRecord,
  RuntimeCheckpointState,
  RuntimeContext,
} from './runtime-checkpoints.ts';
import type { SessionConversation } from './session-continuity.ts';

// Injectable runtime ports. Types only.

export interface Clock {
  /** Wall time in ISO-8601 UTC, for records. */
  nowIso(): string;
  /** Monotonic milliseconds, for timeouts. */
  monotonicMs(): number;
}

export type IdKind =
  | 'run'
  | 'event'
  | 'task'
  | 'execution'
  | 'model_call'
  | 'context_snapshot'
  | 'directive'
  | 'tool_call'
  | 'artifact'
  | 'artifact_version'
  | 'criteria_version'
  | 'iteration'
  | 'effect'
  | 'question'
  | 'approval'
  | 'decision'
  | 'preparation'
  | 'route';

export interface IdFactory {
  next(kind: IdKind): string;
}

/** Deadlines (question timeouts). Injected so tests decide when time passes. */
export interface Scheduler {
  /** Runs `fn` once after `ms`; the returned function cancels it. */
  after(ms: number, fn: () => void): () => void;
}

// Agent adapter port. Workers never decide domain state;
// every effect goes through the host, which is backed by the Coordinator.

export interface ResolvedInput {
  name: string;
  kind: InputBindingKind;
  artifactVersionId: string | null;
  /** Immutable host input body, readable with read_artifact without claiming artifact authorship. */
  sourceRef?: string;
  text: string;
}

/** Why this execution exists. */
export type Assignment =
  | { kind: 'scheduled' }
  | { kind: 'delegated'; brief: string; parentExecutionId: string }
  | { kind: 'question'; questionId: string; body: string; askerExecutionId: string };

/** A callable node this execution may delegate to or ask (capability links). */
export interface CallableTarget {
  nodeId: string;
  label: string;
  /** The current parent execution, not a new callable responder. */
  delivery?: 'parent';
}

export interface AgentStartInput {
  sessionId?: string;
  /** Host-owned provenance for a conversational response, never inferred from the role. */
  meeting?: MeetingRunOrigin;
  resumeContext?: RuntimeCheckpointState;
  /** the session's earlier requests and answers, for an execution given the brief. */
  conversation?: SessionConversation;
  images?: ImageInput[];
  taskBrief?: TaskBrief;
  runId: string;
  executionId: string;
  taskId: string;
  nodeId: string;
  attemptNo: number;
  role: AgentRole;
  modelProfile: string;
  /** Simulated agents or real model calls; fixed for the whole run. */
  mode: 'mock' | 'live';
  /** The model the profile resolved to when the run started (run.started). */
  model: ModelProfileSnapshot;
  /** 0 for scheduled steps; children and responders are one deeper than their caller. */
  depth: number;
  /** The Loop round this execution belongs to (1-based), or null outside a Loop. */
  round: number | null;
  /** The completion criteria version the run works against; reviews must name it. */
  criteriaVersionId: string;
  teamPlanOwner?: boolean;
  assignment: Assignment;
  item?: ItemRef;
  capabilities: {
    delegateTo: CallableTarget[];
    askTo: CallableTarget[];
    replyToChildren?: boolean;
  };
  inputs: ResolvedInput[];
  /** Resolved at Run start, never a mutable profile lookup inside the worker. */
  harness?: EffectiveHarnessSnapshot;
}

export interface DeliveredDirective {
  directiveId: string;
  text: string;
  /** Who made it; a worker wraps each origin in its own heading (features/reins.md). */
  origin: DirectiveOrigin;
}

/** Agent-originated questions; they never carry human directive or approval authority. */
export interface ParentQuestionMessage {
  questionId: string;
  senderExecutionId: string;
  body: string;
  artifactRefs: string[];
  deadline: string;
}

export interface RequestPermit {
  reasoning?: ReasoningResolution;
  modelCallId: string;
  contextSnapshotId: string;
  profile: string;
  maxOutputTokens: number;
  /** Directives fixed into this request's snapshot, in delivery order. */
  directives: DeliveredDirective[];
  /**
   * Open child questions for this execution that the request context does not hold yet. They
   * were part of the routing input; the worker appends exactly these.
   */
  parentQuestions?: ParentQuestionMessage[];
}

/** Token counts as the provider reported them; null when it did not (never 0 by default). */
export interface ModelUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens?: number | null;
  reasoningTokens?: number | null;
}

export type AgentObservation = {
  kind: 'model_completed';
  modelCallId: string;
  text: string;
  usage: ModelUsage;
  /** Provider usage exactly as reported, when available. */
  rawUsage?: Record<string, unknown>;
  /** The response was cut by an interrupt; its text is interrupted output, not an answer. */
  interrupted?: true;
};

export interface ToolProposal {
  name: string;
  args: Record<string, unknown>;
  parentToolCallId?: string;
}

export type ToolOutcome =
  | { ok: true; toolCallId: string; result: Record<string, unknown> }
  | { ok: false; toolCallId: string; error: CommandError };

export type ToolAuthorization =
  | { ok: true; toolCallId: string }
  | { ok: false; toolCallId: string; error: CommandError };

/** A live piece of model output. A bounded private display prefix may be saved outside the event log. */
export interface TextDelta {
  modelCallId: string;
  chunkIndex: number;
  text: string;
}

export interface AgentHost {
  checkpointContext?(context: RuntimeContext): Promise<RuntimeCheckpointRecord | null>;
  protectedContext?(): ProtectedContext;
  reportCompaction?(report: CompactionReport): Promise<void>;
  prepareModelRequest(
    record?: ModelRequestRecord,
    preparation?: RequestPreparation,
  ): Promise<RequestPermit>;
  /** SDK-only: unsupported hosts must refuse SDK execution. */
  reportHarness?(report: HarnessReport): Promise<void>;
  simulateHarness?(): Promise<void>;
  updateHarnessTools?(update: HarnessToolsUpdate): Promise<void>;
  mcpAuthorization?(serverId: string, challenge?: McpChallenge): Promise<string | undefined>;
  requestExtensionUi?(
    request: ExtensionUiRequest,
    cancellation?: DecisionCancellation,
  ): Promise<ExtensionUiResult>;
  notifyExtensionUi?(notice: ExtensionUiNotice): Promise<void>;
  recordProviderPayload?(record: ProviderPayloadRecord): Promise<void>;
  pendingDirectives?(): DeliveredDirective[];
  beginNativeTool?(toolCallId: string, argsHash: string): Promise<void>;
  finishNativeTool?(toolCallId: string, outcome: 'succeeded' | 'failed'): Promise<void>;
  /** Reports local transport dispatch; a prepared request alone is never delivery. */
  modelRequestDispatched?(modelCallId: string): Promise<void>;
  /** Authorizes and runs a tool in one step, for agents without a separate tool phase. */
  invokeTool(proposal: ToolProposal): Promise<ToolOutcome>;
  /** Records the request and decides on it; nothing runs. */
  authorizeTool(proposal: ToolProposal): Promise<ToolAuthorization>;
  /** Runs an authorized call, at most once. Only this records `tool.started`. */
  executeTool(toolCallId: string): Promise<ToolOutcome>;
  observe(observation: AgentObservation): Promise<void>;
  streamText(delta: TextDelta): void;
}

export interface AgentSettlement {
  /** Clean final text with no attempted tools; the Coordinator may accept it for a meeting. */
  finalTextModelCallId?: string;
  outcome: 'succeeded' | 'failed' | 'cancelled';
  error?: string;
  terminationMode?: 'normal' | 'forced' | 'unconfirmed';
}

export interface AgentHandle {
  requestCompaction?(commandId: string): void;
  cancel(reason: string): Promise<void>;
  waitForSettlement(): Promise<AgentSettlement>;
  pushDirective?(directive: DeliveredDirective): void;
  /** Cuts the model response in flight, if any, so the directive rides the next request. */
  interrupt?(directive: DeliveredDirective): void;
}

export interface AgentAdapter {
  start(input: AgentStartInput, host: AgentHost): Promise<AgentHandle>;
}

// Effort routing engines (features/effort-routing.md). The host owns the deadline and the
// resolution; an engine only counts, judges once and reports when its work physically ended.

/** The fixed question, with the criteria of the candidate levels only. */
export interface EffortQuestion {
  type: 'choice';
  instructions: string;
  criteria: Partial<Record<EffortLevel, string>>;
}

export interface RoutingBackend {
  readonly kind: 'local' | 'api';
  /** The engine a judgment would use now; a different one never reuses an earlier result. */
  identity(): string | null;
  /** Reserves the engine for one judgment without waiting; a refusal names the fallback reason. */
  admit(): { ok: true; lease: RoutingLease } | { ok: false; reason: RoutingFallbackReason };
}

export interface RoutingLease {
  /** The engine artifact and instance, or the API and its model. */
  readonly identity: string;
  readonly frame: 'd1-exact' | 'api-bounded';
  readonly device: { actual: string | null; host: string | null; threads: number | null } | null;
  /** Size of a state text in the frame's unit; Local counts with the model's tokenizer. */
  countState(text: string, signal: DecisionCancellation): Promise<number>;
  /** Size of the whole engine input for this state and question, in the same unit. */
  countInput(
    state: string,
    question: EffortQuestion,
    signal: DecisionCancellation,
  ): Promise<number>;
  /** Sends the judgment once. The lease ends when the flight settles. */
  start(request: RouterRequest): RoutingFlight;
  /** Ends a lease that never started a flight. */
  release(): void;
}

export interface RouterRequest {
  routeId: string;
  state: string;
  question: EffortQuestion;
  candidates: EffortLevel[];
  /** What is left of the host's deadline; engines never compare clocks across processes. */
  remainingMs: number;
  /** The counted engine input; Local refuses a response whose usage differs. */
  inputUnits: number;
  /**
   * Set when the host stops waiting (deadline, cancellation). An API closes its connection; that
   * does not mean the remote stopped. Local inference runs to its physical end.
   */
  signal: DecisionCancellation;
  /** The run effect an API call belongs to; its call record names it. Set by the host. */
  owner?: RouterOwner;
}

export interface RouterOwner {
  runId: string;
  executionId: string;
  attemptNo: number;
  effectId: string;
}

/** An engine answer before validation. */
export interface RouterResponse {
  choice: string;
  probabilities?: Record<string, number>;
  inputTokens: number | null;
  billableUnits: number | null;
}

export interface RoutingFlight {
  /** Rejects with an error whose `reason` names a fallback reason. Settles before `settled`. */
  result: Promise<RouterResponse>;
  /** The physical end: a complete native response, the owned child's exit, or a closed remote. */
  settled: Promise<{ basis: SettledBasis; finishedAtMs: number }>;
}

/** Set when a pending answer is no longer wanted (timeout, cancelled execution, run ended). */
export interface DecisionCancellation {
  readonly aborted: boolean;
  onCancel(fn: () => void): () => void;
}

import type { ImageInput } from './attachments.ts';
