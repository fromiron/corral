import type { DecisionCancellation, Scheduler } from '@corral/contracts';
import type { HelperCommand, HelperLauncher } from '../engine/helper.ts';

export type DecisionBackend = 'cpu' | 'gpu';
export type DecisionLevel = 'low' | 'medium' | 'high' | 'xhigh';
export type FourScores = readonly [number, number, number, number];

export type DecisionInput = {
  /** Already formatted with the exact trained, thinking-disabled chat template. */
  prompt: string;
  /** Absent means no clipping. Explicit budgets retain first128 + the remaining tail. */
  inputBudget?: number;
} & ({ op: 'effort' } | { op: 'meeting'; participantIds: readonly string[] });

export interface DecisionRequestOptions {
  /** Absolute milliseconds from the injected clock; includes queueing and startup. */
  deadlineMs: number;
  signal?: AbortSignal;
  cancellation?: DecisionCancellation;
}

export interface DecisionInputMetadata {
  originalPromptTokens: number;
  usedPromptTokens: number;
  inputBudget: number | null;
  inputTruncated: boolean;
  inputTokenFingerprint: string;
  inputTokenFingerprintAlgorithm: 'fnv1a64-le-u32';
}

export type DecisionResult = DecisionInputMetadata & {
  release: string;
  backend: DecisionBackend;
} & (
    | {
        op: 'effort';
        level: DecisionLevel;
        logits: FourScores;
        /** Uncalibrated four-way first-token softmax, not complete-label likelihood. */
        probabilities: FourScores;
      }
    | { op: 'meeting'; participantIds: string[] }
  );

export type DecisionEngineState =
  | 'idle'
  | 'starting'
  | 'loaded'
  | 'warming'
  | 'ready'
  | 'stopping'
  | 'error'
  | 'closed';

export type DecisionErrorCode =
  | 'cancelled'
  | 'timeout'
  | 'closed'
  | 'unavailable'
  | 'queue_full'
  | 'startup_failed'
  | 'startup_timeout'
  | 'helper_failed'
  | 'invalid_request'
  | 'invalid_budget'
  | 'input_too_long'
  | 'invalid_response';

export interface DecisionEngineStatus {
  state: DecisionEngineState;
  requestedBackend: DecisionBackend;
  actualBackend: DecisionBackend | null;
  release: string;
  /** Available calibration artifact identity; the engine does not apply calibration. */
  calibrationVersion: string | null;
  error: DecisionErrorCode | null;
}

export interface DecisionEngineOptions {
  /** Supplied by an artifact owner after install/hash checks; never downloaded by this engine. */
  command: HelperCommand;
  backend: DecisionBackend;
  release: string;
  calibrationVersion?: string;
  contextTokens: number;
  /** Non-empty, caller-owned deterministic non-sensitive inputs, never user requests. */
  warmup: readonly DecisionInput[];
  launch?: HelperLauncher;
  now?: () => number;
  timers?: Scheduler;
  startupTimeoutMs?: number;
  retryDelayMs?: number;
  queueLimit?: number;
}
