import type { AgentRole, InputBindingKind } from './definition.ts';
import type { CommandError } from './errors.ts';

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
  | 'artifact_version';

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
  role: AgentRole;
  modelProfile: string;
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

export interface ModelUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

export type AgentObservation = {
  kind: 'model_completed';
  modelCallId: string;
  text: string;
  usage: ModelUsage;
};

export interface ToolProposal {
  name: string;
  args: Record<string, unknown>;
}

export type ToolOutcome =
  | { ok: true; toolCallId: string; result: Record<string, unknown> }
  | { ok: false; toolCallId: string; error: CommandError };

export interface AgentHost {
  prepareModelRequest(): Promise<RequestPermit>;
  invokeTool(proposal: ToolProposal): Promise<ToolOutcome>;
  observe(observation: AgentObservation): Promise<void>;
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
