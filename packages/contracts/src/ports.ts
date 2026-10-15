import type { AgentRole, InputBindingKind } from './definition.ts';
import type { CommandError } from './errors.ts';
import type { ModelProfileSnapshot } from './events.ts';

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
  | 'effect';

export interface IdFactory {
  next(kind: IdKind): string;
}

// Agent adapter port (Technical-Design §7.2). Workers never decide domain state;
// every effect goes through the host, which is backed by the Coordinator.

export interface ResolvedInput {
  name: string;
  kind: InputBindingKind;
  artifactVersionId: string | null;
  text: string;
}

export interface AgentStartInput {
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
  inputs: ResolvedInput[];
}

export interface DeliveredDirective {
  directiveId: string;
  text: string;
}

export interface RequestPermit {
  modelCallId: string;
  contextSnapshotId: string;
  profile: string;
  maxOutputTokens: number;
  /** Directives fixed into this request's snapshot, in delivery order. */
  directives: DeliveredDirective[];
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
  prepareModelRequest(): Promise<RequestPermit>;
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
  outcome: 'succeeded' | 'failed' | 'cancelled';
  error?: string;
}

export interface AgentHandle {
  cancel(reason: string): Promise<void>;
  waitForSettlement(): Promise<AgentSettlement>;
}

export interface AgentAdapter {
  start(input: AgentStartInput, host: AgentHost): Promise<AgentHandle>;
}
