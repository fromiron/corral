import { z } from 'zod';
import { Identifier } from './ids.ts';
import { DecisionApiId, ReasoningLevel, ReasoningPolicy } from './reasoning.ts';

// Effort routing (features/effort-routing.md): the settings, the private call snapshot a worker
// sends with a request, and the record of how one request's reasoning was settled.

/** The levels automatic reasoning chooses from, weakest first. */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh'] as const;
export const EffortLevel = z.enum(EFFORT_LEVELS);
export type EffortLevel = z.infer<typeof EffortLevel>;

// ── settings ─────────────────────────────────────────────────────────────────

export const ROUTING_TIMEOUT_MIN_MS = 100;
export const ROUTING_TIMEOUT_MAX_MS = 10_000;
export const LOCAL_ROUTING_TIMEOUT_MS = 5_000;
export const API_ROUTING_TIMEOUT_MS = 3_000;

const CallerTimeoutMs = z.int().min(ROUTING_TIMEOUT_MIN_MS).max(ROUTING_TIMEOUT_MAX_MS);

export const RoutingFallback = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('provider-default') }),
  z.strictObject({ kind: z.literal('fixed'), effort: EffortLevel }),
]);
export type RoutingFallback = z.infer<typeof RoutingFallback>;

export const RoutingEngine = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('local'),
    device: z.strictObject({ kind: z.literal('cpu'), threads: z.int().min(1).max(256) }),
    callerTimeoutMs: CallerTimeoutMs,
  }),
  z.strictObject({
    kind: z.literal('api'),
    id: DecisionApiId,
    callerTimeoutMs: CallerTimeoutMs,
    /** The notice version the person agreed to; a different current notice sends nothing. */
    consentRevision: z.string().min(1).max(200),
  }),
]);
export type RoutingEngine = z.infer<typeof RoutingEngine>;

export const EffortRoutingSettings = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('off') }),
  z.strictObject({
    mode: z.literal('manual'),
    engine: RoutingEngine,
    fallback: RoutingFallback,
    /** Diagnostic only: `shadow` sends the baseline and observes a judgment separately. */
    application: z.enum(['active', 'shadow']).optional(),
  }),
]);
export type EffortRoutingSettings = z.infer<typeof EffortRoutingSettings>;

// ── call snapshot (worker → host, private) ───────────────────────────────────

/** The longest source a worker sends, in UTF-8 bytes; a longer one is cut and marked. */
export const SNAPSHOT_SOURCE_BYTES = 8 * 1024;

const SnapshotText = z.strictObject({
  text: z.string().max(SNAPSHOT_SOURCE_BYTES),
  /** The original length in UTF-8 bytes, present only when the worker cut the text. */
  originalBytes: z.int().min(0).optional(),
});
export type SnapshotText = z.infer<typeof SnapshotText>;

export const ToolCallStatus = z.enum(['completed', 'failed', 'pending']);
export type ToolCallStatus = z.infer<typeof ToolCallStatus>;

/**
 * What a worker read from the request context it settled, once: the current request without
 * Corral's assignment metadata or state message, the latest assistant step with every tool call
 * and its result, and a few earlier replies. No hidden reasoning, images or keys.
 */
export const CallSnapshotInput = z.strictObject({
  request: SnapshotText.nullable(),
  /** Images in the request message; they are never sent to a routing engine. */
  requestImages: z.int().min(0).max(256),
  /** The text of the latest assistant message after the request: its plan or diagnosis. */
  previousAssistant: SnapshotText.nullable(),
  /** Every tool call of that message, in order, with the last result for each call. */
  toolCalls: z
    .array(
      z.strictObject({
        toolCallId: z.string().min(1).max(256),
        name: z.string().min(1).max(128),
        args: SnapshotText,
        result: SnapshotText.nullable(),
        status: ToolCallStatus,
      }),
    )
    .max(64),
  /** Earlier assistant replies, oldest first. */
  earlierReplies: z.array(SnapshotText).max(3),
  /** Parent questions already in the request context. */
  presentQuestionIds: z.array(Identifier).max(256),
});
export type CallSnapshotInput = z.infer<typeof CallSnapshotInput>;

/** The request a worker prepares, beyond its context record. */
export const RequestPreparation = z.strictObject({
  logicalRequestId: Identifier.optional(),
  /** A transport retry of this same request: the model call that failed. */
  retryOfModelCallId: Identifier.optional(),
  snapshot: CallSnapshotInput.optional(),
});
export type RequestPreparation = z.infer<typeof RequestPreparation>;

// ── resolution record ────────────────────────────────────────────────────────

export const RoutingFallbackReason = z.enum([
  'unavailable',
  'not-ready',
  'busy',
  'timeout',
  'invalid-response',
  'insufficient-context',
  'tokenizer-error',
  'token-count-mismatch',
  'unsupported-model',
  'transport-error',
  'daemon-crash',
  'consent-required',
  'resource-conflict',
]);
export type RoutingFallbackReason = z.infer<typeof RoutingFallbackReason>;

export const InsufficientContextReason = z.enum([
  'missing-request',
  'required-source-missing',
  'required-content-over-budget',
  'comparison-operand-missing',
  'unsupported-modality',
  'packing-budget-exhausted',
]);
export type InsufficientContextReason = z.infer<typeof InsufficientContextReason>;

export const ProbabilityMeaning = z.enum(['choice-distribution', 'not-provided']);
export const EffortProbabilities = z.partialRecord(EffortLevel, z.number().min(0).max(1));
export type EffortProbabilities = z.infer<typeof EffortProbabilities>;

const Ms = z.number().min(0).nullable();
const Version = z.string().min(1).max(100);

export const RoutingFrameRecord = z.strictObject({
  kind: z.enum(['d1-exact', 'api-bounded']),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  /** State size in the frame's unit: d1 tokens, or UTF-8 bytes for an API frame. */
  stateUnits: z.int().min(0),
  /** The whole engine input in the same unit. */
  inputUnits: z.int().min(0),
  included: z.int().min(0),
  omitted: z.int().min(0),
  truncated: z.int().min(0),
});
export type RoutingFrameRecord = z.infer<typeof RoutingFrameRecord>;

/** One judgment attempt: present for every automatic request under Manual. */
export const RouteRecord = z.strictObject({
  routeId: Identifier,
  engine: z.enum(['local', 'api', 'none']),
  application: z.enum(['active', 'shadow']),
  settingsRevision: z.string().regex(/^[a-f0-9]{64}$/),
  candidates: z.array(EffortLevel).max(4),
  recommended: EffortLevel.nullable(),
  fallback: z
    .strictObject({
      reason: RoutingFallbackReason,
      insufficient: InsufficientContextReason.optional(),
      target: RoutingFallback,
      /** The fixed fallback is not a level this model supports: the provider default went. */
      targetUnsupported: z.literal(true).optional(),
    })
    .optional(),
  /** No supported candidate: the provider default went and no engine was asked. */
  noSupportedLevel: z.literal(true).optional(),
  probabilities: EffortProbabilities.nullable(),
  probabilityMeaning: ProbabilityMeaning.nullable(),
  engineIdentity: z.string().min(1).max(300).nullable(),
  questionVersion: Version,
  questionHash: z.string().regex(/^[a-f0-9]{64}$/),
  serializerVersion: Version,
  frame: RoutingFrameRecord.nullable(),
  timing: z.strictObject({
    deadlineMs: z.int().min(0),
    packMs: Ms,
    countMs: Ms,
    engineMs: Ms,
    callerWaitMs: Ms,
  }),
  device: z
    .strictObject({
      requested: z.literal('cpu'),
      actual: z.string().min(1).max(100).nullable(),
      host: z.string().min(1).max(200).nullable(),
      threads: z.int().min(1).max(256).nullable(),
    })
    .nullable(),
  usage: z.strictObject({
    inputTokens: z.int().min(0).nullable(),
    billableUnits: z.number().min(0).nullable(),
  }),
  /** The preparation whose settled result this explicit transport retry reuses. */
  reusedFrom: Identifier.optional(),
});
export type RouteRecord = z.infer<typeof RouteRecord>;

/**
 * How one request's reasoning was settled. `resolved` is the level the request carries; null is
 * the provider default, which sends no reasoning field.
 */
export const ReasoningResolution = z.strictObject({
  preparationId: Identifier,
  requested: ReasoningPolicy,
  resolved: ReasoningLevel.nullable(),
  source: z.enum([
    'router',
    'single-level',
    'fallback',
    'off',
    'fixed',
    'provider-default',
    'internal-policy',
    'reused',
  ]),
  route: RouteRecord.optional(),
});
export type ReasoningResolution = z.infer<typeof ReasoningResolution>;

// ── engine-side records ──────────────────────────────────────────────────────

export const SettledBasis = z.enum([
  'native-response-complete',
  'owned-child-exit',
  'remote-transport-closed',
]);
export type SettledBasis = z.infer<typeof SettledBasis>;

/** Physical end of one engine call, recorded apart from the request's resolution. */
export const ReasoningSettledPayload = z.strictObject({
  executionId: Identifier,
  routeId: Identifier,
  basis: SettledBasis,
  physicalOccupiedMs: Ms,
  lateResult: z.boolean(),
  /** A valid recommendation that arrived after the request had settled: record only. */
  lateSelected: EffortLevel.nullable(),
});

/** A Shadow judgment observed after the baseline request went out. */
export const ReasoningObservedPayload = z.strictObject({
  executionId: Identifier,
  routeId: Identifier,
  modelCallId: Identifier,
  baseline: ReasoningLevel.nullable(),
  selected: EffortLevel.nullable(),
  skipped: z.union([RoutingFallbackReason, z.literal('cancelled')]).nullable(),
  insufficient: InsufficientContextReason.optional(),
  probabilities: EffortProbabilities.nullable(),
  probabilityMeaning: ProbabilityMeaning.nullable(),
  engineIdentity: z.string().min(1).max(300).nullable(),
  frame: RoutingFrameRecord.nullable(),
  timing: z.strictObject({ packMs: Ms, countMs: Ms, engineMs: Ms }),
});
