import {
  type Clock,
  canonicalJson,
  type DecisionCancellation,
  EffortRoutingSettings,
  type ModelProfileSnapshot,
  type ReasoningLevel,
  type ReasoningPolicy,
  type ReasoningResolution,
  type RouteRecord,
  type RoutingBackend,
  type RoutingEngine,
  type RoutingFallback,
  type Scheduler,
} from '@corral/contracts';
import { fixedReasoning } from '../reasoning.ts';
import { type CallSnapshot, SERIALIZER_VERSION } from './frame.ts';
import {
  effortQuestion,
  QUESTION_VERSION,
  questionHash,
  routingCandidates,
  sha256Hex,
} from './question.ts';
import { type RouteOutcome, route, type SettledFacts } from './resolver.ts';

export { judge } from './arbiter.ts';
export { type CallSnapshot, callSnapshot, excerpt, FRAME_LIMITS, packFrame } from './frame.ts';
export { effortQuestion, QUESTION_VERSION, routingCandidates } from './question.ts';
export { type RouteOutcome, route, type SettledFacts } from './resolver.ts';

/** Where the Coordinator reads effort routing; absent means Off. */
export interface EffortRoutingDeps {
  /** The current settings, read at each preparation. */
  settings(): EffortRoutingSettings;
  /** The chosen engine, or null when it cannot run here. Never another engine. */
  backend(engine: RoutingEngine): RoutingBackend | null;
}

export const ROUTING_OFF: EffortRoutingSettings = { mode: 'off' };

export function routingRevision(settings: EffortRoutingSettings): string {
  return sha256Hex(canonicalJson(EffortRoutingSettings.parse(settings)));
}

export interface ReasoningPreparation {
  preparationId: string;
  policy: ReasoningPolicy | undefined;
  compaction: boolean;
  model: ModelProfileSnapshot;
  settings: EffortRoutingSettings;
  backend: (engine: RoutingEngine) => RoutingBackend | null;
  snapshot: CallSnapshot;
  /** The request context hash; without one nothing is reused. */
  contextHash: string | null;
  /** The settled route of the model call this request retries, if the worker named one. */
  retryOf: StoredRoute | null;
  routeId: () => string;
  clock: Clock;
  timers: Scheduler | undefined;
  cancellation: DecisionCancellation;
}

/** A settled route kept for an explicit transport retry of the same request. */
export interface StoredRoute {
  key: string;
  resolution: ReasoningResolution;
}

export interface Shadow {
  routeId: string;
  baseline: ReasoningLevel | null;
  /** Judges after the baseline went out; never changes it. */
  observe(cancellation: DecisionCancellation): Promise<RouteOutcome>;
}

export type PreparedReasoning =
  | {
      kind: 'ready';
      resolution: ReasoningResolution | undefined;
      /** Present when an explicit retry of this request may reuse the resolution. */
      stored: StoredRoute | null;
      settled: Promise<SettledFacts> | null;
      shadow: Shadow | null;
    }
  | { kind: 'cancelled' };

const fallbackLevel = (fallback: RoutingFallback, levels: readonly ReasoningLevel[]) =>
  fallback.kind === 'fixed' && levels.includes(fallback.effort) ? fallback.effort : null;

/**
 * Settles one request's reasoning (features/effort-routing.md#요청마다의-판정-순서): fixed levels
 * and the provider default as asked; automatic compaction on the internal medium policy;
 * automatic requests with Off on the provider default; with Manual, the chosen engine once.
 */
export function prepareReasoning(
  input: ReasoningPreparation,
): PreparedReasoning | Promise<PreparedReasoning> {
  const { policy, preparationId, settings } = input;
  const levels = input.model.reasoning?.levels ?? [];
  const ready = (
    resolution: ReasoningResolution | undefined,
    extra: Partial<Omit<Extract<PreparedReasoning, { kind: 'ready' }>, 'kind' | 'resolution'>> = {},
  ): PreparedReasoning => ({
    kind: 'ready',
    resolution,
    stored: null,
    settled: null,
    shadow: null,
    ...extra,
  });
  const manual = settings.mode === 'manual' ? settings : null;
  const shadowing = manual?.application === 'shadow';
  const revision = routingRevision(settings);
  const candidates = routingCandidates(levels);
  const question = effortQuestion(candidates);
  const shadowOf = (baseline: ReasoningLevel | null): Shadow | null => {
    if (!manual || !shadowing || candidates.length < 2) return null;
    const routeId = input.routeId();
    return {
      routeId,
      baseline,
      observe: (cancellation) =>
        route({
          routeId,
          engine: manual.engine,
          backend: input.backend(manual.engine),
          snapshot: input.snapshot,
          candidates,
          clock: input.clock,
          timers: input.timers,
          cancellation,
        }),
    };
  };

  if (!policy) return ready(undefined);
  const fixed = fixedReasoning(policy, preparationId);
  if (fixed) return ready(fixed, { shadow: shadowOf(fixed.resolved) });
  const requested = { mode: 'auto' } as const;
  if (input.compaction)
    return ready({
      preparationId,
      requested,
      resolved: levels.includes('medium') ? 'medium' : null,
      source: 'internal-policy',
    });
  if (!manual) return ready({ preparationId, requested, resolved: null, source: 'off' });

  const engineKind = manual.engine.kind;
  const backend = input.backend(manual.engine);
  const key = input.contextHash
    ? sha256Hex(
        canonicalJson({
          contextHash: input.contextHash,
          model: { provider: input.model.provider, modelId: input.model.modelId },
          capability: input.model.reasoning ?? null,
          settings: revision,
          engine: backend?.identity() ?? null,
          question: QUESTION_VERSION,
          serializer: SERIALIZER_VERSION,
          candidates,
        }),
      )
    : null;
  if (key && input.retryOf?.key === key && input.retryOf.resolution.route)
    return ready(
      {
        ...input.retryOf.resolution,
        preparationId,
        source: 'reused',
        route: {
          ...input.retryOf.resolution.route,
          reusedFrom: input.retryOf.resolution.preparationId,
        },
      },
      { stored: input.retryOf },
    );

  const routeId = input.routeId();
  const base = (outcome: RouteOutcome | null): RouteRecord => ({
    routeId,
    engine: outcome ? engineKind : 'none',
    application: shadowing ? 'shadow' : 'active',
    settingsRevision: revision,
    candidates,
    recommended: outcome?.kind === 'selected' ? outcome.effort : null,
    probabilities: outcome?.probabilities ?? null,
    probabilityMeaning: outcome?.probabilityMeaning ?? null,
    engineIdentity: outcome?.engineIdentity ?? null,
    questionVersion: QUESTION_VERSION,
    questionHash: questionHash(question),
    serializerVersion: SERIALIZER_VERSION,
    frame: outcome?.frame ?? null,
    timing: {
      deadlineMs: manual.engine.callerTimeoutMs,
      packMs: outcome?.timing.packMs ?? null,
      countMs: outcome?.timing.countMs ?? null,
      engineMs: outcome?.timing.engineMs ?? null,
      callerWaitMs: outcome?.timing.callerWaitMs ?? null,
    },
    device:
      engineKind === 'local'
        ? {
            requested: 'cpu',
            actual: outcome?.device?.actual ?? null,
            host: outcome?.device?.host ?? null,
            threads: outcome?.device?.threads ?? null,
          }
        : null,
    usage: outcome?.usage ?? { inputTokens: null, billableUnits: null },
  });
  const settledKey = (resolution: ReasoningResolution) => (key ? { key, resolution } : null);

  if (candidates.length === 0) {
    const resolution: ReasoningResolution = {
      preparationId,
      requested,
      resolved: null,
      source: 'provider-default',
      route: { ...base(null), noSupportedLevel: true },
    };
    return ready(resolution, { stored: settledKey(resolution) });
  }
  if (candidates.length === 1) {
    const resolution: ReasoningResolution = {
      preparationId,
      requested,
      resolved: candidates[0]!,
      source: 'single-level',
      route: base(null),
    };
    return ready(resolution, { stored: settledKey(resolution) });
  }
  const fallback = (outcome: RouteOutcome | null): ReasoningResolution => {
    const target = manual.fallback;
    const resolved = fallbackLevel(target, levels);
    return {
      preparationId,
      requested,
      resolved,
      source: 'fallback',
      route: {
        ...base(outcome),
        ...(outcome?.reason
          ? {
              fallback: {
                reason: outcome.reason,
                ...(outcome.insufficient ? { insufficient: outcome.insufficient } : {}),
                target,
                ...(target.kind === 'fixed' && resolved === null
                  ? { targetUnsupported: true as const }
                  : {}),
              },
            }
          : {}),
      },
    };
  };
  if (shadowing) {
    const resolution = fallback(null);
    return ready(resolution, { shadow: shadowOf(resolution.resolved) });
  }
  // Only a real judgment waits; every other request settles without yielding.
  return route({
    routeId,
    engine: manual.engine,
    backend,
    snapshot: input.snapshot,
    candidates,
    clock: input.clock,
    timers: input.timers,
    cancellation: input.cancellation,
  }).then((outcome): PreparedReasoning => {
    if (outcome.kind === 'cancelled') return { kind: 'cancelled' };
    const resolution: ReasoningResolution =
      outcome.kind === 'selected'
        ? {
            preparationId,
            requested,
            resolved: outcome.effort!,
            source: 'router',
            route: base(outcome),
          }
        : fallback(outcome);
    return ready(resolution, { stored: settledKey(resolution), settled: outcome.settled });
  });
}
