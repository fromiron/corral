import type {
  DecisionPrivacy,
  DecisionQuestionKind,
  DecisionSubject,
  EffortFeatures,
  EffortLevel,
} from './decisions.ts';
import type { AgentRole, InputBindingKind, ItemRef, TaskBrief } from './definition.ts';
import type { CommandError } from './errors.ts';
import type { ModelProfileSnapshot } from './events.ts';
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
import type { ReasoningInput, ReasoningResolution } from './reasoning.ts';
import type {
  RuntimeCheckpointRecord,
  RuntimeCheckpointState,
  RuntimeContext,
} from './runtime-checkpoints.ts';
import type { SessionConversation } from './session-continuity.ts';

// Injectable runtime ports (Implementation Plan §4, CRL-DEV-002). Types only.

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
  | 'preparation';

export interface IdFactory {
  next(kind: IdKind): string;
}

/** Deadlines (question timeouts). Injected so tests decide when time passes. */
export interface Scheduler {
  /** Runs `fn` once after `ms`; the returned function cancels it. */
  after(ms: number, fn: () => void): () => void;
}

// Agent adapter port (Technical-Design §7.2). Workers never decide domain state;
// every effect goes through the host, which is backed by the Coordinator.

export interface ResolvedInput {
  name: string;
  kind: InputBindingKind;
  artifactVersionId: string | null;
  /** Immutable host input body, readable with read_artifact without claiming artifact authorship. */
  sourceRef?: string;
  text: string;
}

/** Why this execution exists (Spec §7.2, Technical-Design §8). */
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
  candidateId?: string;
  candidateComparison?: true;
  resumeContext?: RuntimeCheckpointState;
  /** CR-054: the session's earlier requests and answers, for an execution given the brief. */
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
  /** Open child questions addressed to this exact current execution. */
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

/** A piece of model output while it streams. Transient: never stored (ADR-011). */
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
    reasoningInput?: ReasoningInput,
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
  /** Records the request and decides on it; nothing runs (Technical-Design §7.3). */
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
}

export interface AgentAdapter {
  start(input: AgentStartInput, host: AgentHost): Promise<AgentHandle>;
}

// ── decision providers (CR-003, ADR-025) ───────────────────────────────────

/** The question a provider gets for one model request. The excerpt never reaches events. */
export interface EffortQuestion {
  questionKind: 'reasoning_effort';
  questionVersion: 1;
  candidates: readonly EffortLevel[];
  subject: DecisionSubject & { runId: string };
  input: {
    features: EffortFeatures;
    /** Brief, assignment, question and delivered directives, at most 1,500 characters. */
    excerpt: string;
  };
}

/**
 * Answers decision questions. Declares what it answers; the Coordinator never sends anything
 * else. `decide` returns the raw answer, which the Coordinator validates (DecisionAnswer).
 */
export interface DecisionProvider {
  id: string;
  version: string;
  privacy: DecisionPrivacy;
  timeoutMs: number;
  questions: readonly { kind: DecisionQuestionKind; version: number }[];
  /** True, or why it cannot answer right now (not installed, unsupported platform, …). */
  available(): true | string;
  decide(question: EffortQuestion, cancellation: DecisionCancellation): Promise<unknown>;
  /** Local apply path; a complete turn/tool-step input, not the observer excerpt. */
  decideRequest?(input: ReasoningInput, cancellation: DecisionCancellation): Promise<unknown>;
}

/** Set when the judgment is no longer wanted (timeout, cancelled execution, run ended). */
export interface DecisionCancellation {
  readonly aborted: boolean;
  onCancel(fn: () => void): () => void;
}

import type { ImageInput } from './attachments.ts';
