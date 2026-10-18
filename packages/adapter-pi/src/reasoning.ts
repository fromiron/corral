import { createHash } from 'node:crypto';
import {
  canonicalJson,
  type ReasoningCapabilities,
  type ReasoningResolution,
  type ReasoningWire,
} from '@corral/contracts';
import {
  type Api,
  getSupportedThinkingLevels,
  type Model,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai';

/** Metadata and serializer identity pinned before any execution starts. */
export function modelReasoningCapabilities(model: Model<Api> | undefined): ReasoningCapabilities {
  if (!model || !['openai-responses', 'openai-codex-responses'].includes(model.api))
    return { levels: [], providerDefault: false };
  const levels = model.reasoning ? getSupportedThinkingLevels(model) : [];
  const mapping = Object.fromEntries(
    levels.map((level) => [
      level,
      model.thinkingLevelMap?.[level] ?? (level === 'off' ? 'none' : level),
    ]),
  );
  const capabilities = { levels, providerDefault: true, api: model.api, mapping };
  const identity = createHash('sha256')
    .update(
      canonicalJson({
        ...capabilities,
        model: model.id,
        provider: model.provider,
        serializer: 'pi-1.3.0',
      }),
    )
    .digest('hex');
  return { ...capabilities, identity };
}
export function assertReasoningCapabilities(
  model: Model<Api>,
  expected: ReasoningCapabilities | undefined,
) {
  if (expected?.identity && modelReasoningCapabilities(model).identity !== expected.identity)
    throw new Error('model reasoning capabilities changed since run start');
}

/** An omitted role setting deliberately preserves the pre-CR-021 serializer behavior. */
export function reasoningRequest(
  model: Model<Api>,
  options: SimpleStreamOptions | undefined,
  resolution: ReasoningResolution | undefined,
) {
  if (!resolution) return { model, options: { ...options } };
  const next = { ...options };
  delete next.reasoning;
  if (resolution.resolved !== null) {
    if (resolution.resolved !== 'off') next.reasoning = resolution.resolved;
    return { model, options: next };
  }
  // Pi Codex adds `none` for omission unless off maps to null. Never mutate the catalog model.
  return {
    model: { ...model, thinkingLevelMap: { ...model.thinkingLevelMap, off: null } },
    options: next,
  };
}

/** Verify the final payload after extension hooks, before the provider can send it. */
export function verifyReasoningWire(
  model: Model<Api>,
  payload: unknown,
  resolution: ReasoningResolution | undefined,
): ReasoningWire | undefined {
  if (!resolution) return undefined;
  if (!payload || typeof payload !== 'object') throw new Error('invalid provider payload');
  const body = payload as { reasoning?: { effort?: unknown }; reasoning_effort?: unknown };
  const actual = body.reasoning?.effort ?? body.reasoning_effort;
  const level = resolution.resolved;
  const expected =
    level === null
      ? null
      : model.thinkingLevelMap?.[level] === null
        ? null
        : (model.thinkingLevelMap?.[level] ?? (level === 'off' ? 'none' : level));
  if (expected === null ? actual !== undefined : actual !== expected)
    throw new Error('provider reasoning differs from the Coordinator permit');
  return {
    kind: actual === undefined ? 'omitted' : 'effort',
    value: typeof actual === 'string' ? actual : null,
  };
}
