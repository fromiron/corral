import { createHash } from 'node:crypto';
import {
  canonicalJson,
  type ModelProfileSnapshot,
  type ReasoningCapabilities,
  type ReasoningResolution,
  type ReasoningWire,
} from '@corral/contracts';
import {
  type Api,
  getSupportedThinkingLevels,
  hasApi,
  type Model,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai';

/** Metadata and serializer identity pinned before any execution starts. */
export function modelReasoningCapabilities(model: Model<Api> | undefined): ReasoningCapabilities {
  if (
    !model ||
    !(
      ['openai-responses', 'openai-codex-responses'].includes(model.api) ||
      (hasApi(model, 'openai-completions') &&
        ((model.compat?.thinkingFormat === 'deepseek' &&
          model.compat.supportsReasoningEffort !== false) ||
          (model.compat?.thinkingFormat === 'openai' &&
            model.compat.supportsReasoningEffort === true &&
            model.thinkingLevelMap !== undefined)))
    )
  )
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
        compat: model.compat ?? null,
        thinkingLevelMap: model.thinkingLevelMap ?? null,
        maxTokens: model.maxTokens,
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
  maxOutputTokens?: number,
  auth?: ModelProfileSnapshot['auth'],
): ReasoningWire | undefined {
  if (!resolution) return undefined;
  if (!payload || typeof payload !== 'object') throw new Error('invalid provider payload');
  const body = payload as {
    model?: unknown;
    reasoning?: { effort?: unknown };
    reasoning_effort?: unknown;
    thinking?: { type?: unknown };
    input?: { type?: unknown; reasoning?: { effort?: unknown } }[];
    max_output_tokens?: unknown;
    max_tokens?: unknown;
    max_completion_tokens?: unknown;
  };
  let actual = model.api === 'openai-completions' ? body.reasoning_effort : body.reasoning?.effort;
  if (
    hasApi(model, 'openai-responses') &&
    model.compat?.supportsMidConvoEffort === true &&
    Array.isArray(body.input)
  ) {
    const update = body.input.findLast((item) => item?.type === 'configuration_update');
    if (update) {
      if (body.reasoning?.effort !== 'medium' || typeof update.reasoning?.effort !== 'string')
        throw new Error('provider reasoning differs from the Coordinator permit');
      actual = update.reasoning.effort;
    }
  }
  const level = resolution.resolved;
  let expected =
    level === null
      ? null
      : model.thinkingLevelMap?.[level] === null
        ? null
        : (model.thinkingLevelMap?.[level] ?? (level === 'off' ? 'none' : level));
  if (hasApi(model, 'openai-completions') && model.compat?.thinkingFormat === 'deepseek') {
    const thinking = level === null ? undefined : level === 'off' ? 'disabled' : 'enabled';
    if (body.thinking?.type !== thinking)
      throw new Error('provider thinking differs from the Coordinator permit');
    if (level === 'off') expected = null;
  }
  if (expected === null ? actual !== undefined : actual !== expected)
    throw new Error('provider reasoning differs from the Coordinator permit');
  if (maxOutputTokens !== undefined) {
    if (body.model !== model.id)
      throw new Error('provider model differs from the Coordinator permit');
    const cap = hasApi(model, 'openai-completions')
      ? model.compat?.maxTokensField === 'max_tokens'
        ? body.max_tokens
        : body.max_completion_tokens
      : body.max_output_tokens;
    const unsupported =
      model.api === 'openai-codex-responses' ||
      (hasApi(model, 'openai-responses') &&
        (model.compat?.supportsMaxOutputTokens === false ||
          (auth === 'oauth' &&
            model.provider === 'openai' &&
            model.baseUrl === 'https://api.openai.com/v1')));
    if (
      cap === undefined
        ? !unsupported
        : !Number.isSafeInteger(cap) || Number(cap) < 1 || Number(cap) > maxOutputTokens
    )
      throw new Error('provider output limit differs from the Coordinator permit');
  }
  return {
    kind: actual === undefined ? 'omitted' : 'effort',
    value: typeof actual === 'string' ? actual : null,
  };
}
