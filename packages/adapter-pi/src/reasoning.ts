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

/** The chat APIs Pi ships; a model on any other API (a test double) is given no levels. */
const PI_CHAT_APIS: ReadonlySet<string> = new Set([
  'openai-completions',
  'mistral-conversations',
  'openai-responses',
  'azure-openai-responses',
  'openai-codex-responses',
  'anthropic-messages',
  'bedrock-converse-stream',
  'google-generative-ai',
  'google-vertex',
  'pi-messages',
]);

/**
 * Serializers whose reasoning and output fields Corral has tested against Pi's payload and
 * compares in every request. Other Pi formats still get Pi's levels, but only as Pi's
 * `reasoning` option: Corral records the mapped level without checking the wire.
 */
function verifiedSerializer(model: Model<Api>): boolean {
  return (
    ['openai-responses', 'openai-codex-responses'].includes(model.api) ||
    (hasApi(model, 'anthropic-messages') && model.compat?.forceAdaptiveThinking === true) ||
    (hasApi(model, 'openai-completions') &&
      ((model.compat?.thinkingFormat === 'deepseek' &&
        model.compat.supportsReasoningEffort !== false) ||
        (model.compat?.thinkingFormat === 'openai' &&
          model.compat.supportsReasoningEffort === true &&
          model.thinkingLevelMap !== undefined)))
  );
}

/** Pi omits Google's thinking settings differently; its `off` rewrite would pick a level. */
const GOOGLE_APIS: ReadonlySet<string> = new Set(['google-generative-ai', 'google-vertex']);

/** Metadata and serializer identity pinned before any execution starts. */
export function modelReasoningCapabilities(model: Model<Api> | undefined): ReasoningCapabilities {
  if (!model) return { levels: [], providerDefault: false };
  const verified = verifiedSerializer(model);
  if (!verified && !(model.reasoning && PI_CHAT_APIS.has(model.api)))
    return { levels: [], providerDefault: false };
  const levels = model.reasoning ? getSupportedThinkingLevels(model) : [];
  const mapping = Object.fromEntries(
    levels.map((level) => [
      level,
      model.thinkingLevelMap?.[level] ?? (verified && level === 'off' ? 'none' : level),
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

/** An omitted role setting deliberately preserves the earlier serializer behavior. */
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
  if (hasApi(model, 'anthropic-messages') || GOOGLE_APIS.has(model.api))
    return { model, options: next };
  // Pi Codex adds `none` for omission unless off maps to null. Never mutate the catalog model.
  return {
    model: { ...model, thinkingLevelMap: { ...model.thinkingLevelMap, off: null } },
    options: next,
  };
}

/** Verify the final payload after extension hooks, before the provider can send it. */
/**
 * The output cap a request carries: the Coordinator's permit, lowered to the model's catalog
 * maximum. An unlimited run permits more than any model allows, so this is its real cap.
 */
export function requestOutputCap(
  model: { maxTokens?: number; contextWindow?: number; api?: string },
  permitted: number,
  inputTokens = 0,
): number {
  const cap = Math.min(
    permitted,
    model.maxTokens ?? permitted,
    (model.contextWindow ?? Number.MAX_SAFE_INTEGER) - inputTokens,
  );
  if (cap < (model.api?.startsWith('openai') ? 16 : 1))
    throw new Error('context leaves no supported output space');
  return cap;
}

/**
 * The output cap of a chat completions body. A model that names no field gets the one Pi
 * picks for its host; the cap is then read from whichever field is present, never both.
 */
function completionsCap(
  model: Model<'openai-completions'>,
  body: { max_tokens?: unknown; max_completion_tokens?: unknown },
) {
  const field = model.compat?.maxTokensField;
  if (field === 'max_tokens') return body.max_tokens;
  if (field === 'max_completion_tokens') return body.max_completion_tokens;
  if (body.max_tokens !== undefined && body.max_completion_tokens !== undefined)
    throw new Error('provider output limit differs from the Coordinator permit');
  return body.max_completion_tokens ?? body.max_tokens;
}

export function verifyReasoningWire(
  model: Model<Api>,
  payload: unknown,
  resolution: ReasoningResolution | undefined,
  maxOutputTokens?: number,
  auth?: ModelProfileSnapshot['auth'],
): ReasoningWire | undefined {
  if (!resolution) return undefined;
  if (!payload || typeof payload !== 'object') throw new Error('invalid provider payload');
  if (!verifiedSerializer(model)) {
    // A format Corral has not tested: the record is the mapped level, which may differ from
    // what Pi actually sends (features/model-connections.md).
    const level = resolution.resolved;
    return level === null
      ? { kind: 'omitted', value: null }
      : { kind: 'effort', value: model.thinkingLevelMap?.[level] ?? level };
  }
  const body = payload as {
    model?: unknown;
    reasoning?: { effort?: unknown };
    reasoning_effort?: unknown;
    thinking?: { type?: unknown };
    output_config?: { effort?: unknown };
    messages?: { role?: unknown; output_config?: { effort?: unknown } }[];
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
  if (hasApi(model, 'anthropic-messages')) {
    actual = body.output_config?.effort;
    const managed =
      model.compat?.supportsMidConvoEffort === true &&
      ((level !== 'off' && level !== null) || model.thinkingLevelMap?.off === null);
    if (managed) {
      // The top-level effort is cached with the prompt and stays fixed at "low" (an organization
      // cap may reject any higher level); the last system marker carries the effort of this reply.
      if (body.output_config?.effort !== 'low')
        throw new Error('provider reasoning differs from the Coordinator permit');
      const last = body.messages?.at(-1);
      actual = last?.role === 'system' ? last.output_config?.effort : undefined;
    }
    const enabled = level !== null && level !== 'off';
    expected = enabled
      ? (model.thinkingLevelMap?.[level] ?? (level === 'minimal' ? 'low' : level))
      : managed
        ? 'high'
        : null;
    if (
      body.thinking?.type !==
      (enabled || managed
        ? 'adaptive'
        : model.thinkingLevelMap?.off === null
          ? undefined
          : 'disabled')
    )
      throw new Error('provider thinking differs from the Coordinator permit');
  }
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
    const cap = hasApi(model, 'anthropic-messages')
      ? body.max_tokens
      : hasApi(model, 'openai-completions')
        ? completionsCap(model, body)
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
