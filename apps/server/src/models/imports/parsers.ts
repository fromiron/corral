/** Read-only, deliberately non-executable import adapters. No env, command or plugin resolution. */
export const IMPORT_SOURCES = ['claude-code', 'codex', 'opencode', 'pi'] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];
export const MAX_IMPORT_BYTES = 1024 * 1024;
export interface ImportDraft {
  provider: string;
  model: string;
  baseUrl?: string;
  secret?: string;
  warnings: string[];
  unsupported?: string;
}
const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const str = (value: unknown) => (typeof value === 'string' ? value : undefined);

function key(value: unknown, warnings: string[]) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  if (/^(?:!|env:|\$|\{)|YOUR[_ -]|API_KEY$/.test(value) || /^[A-Z][A-Z0-9_]+$/.test(value)) {
    warnings.push('Credential references are not evaluated. Configure authentication in Corral.');
    return undefined;
  }
  if (value.length > 8192 || /[\r\n]/.test(value)) return undefined;
  return value;
}

/** Only scalar keys used by model configuration are parsed; unrelated TOML is ignored. */
function codexDocument(text: string) {
  const root: Record<string, unknown> = {};
  const providers: Record<string, unknown> = {};
  let target: Record<string, unknown> | undefined = root;
  const fields = new Set([
    'model',
    'model_provider',
    'model_reasoning_effort',
    'base_url',
    'wire_api',
    'env_key',
    'experimental_bearer_token',
  ]);
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      const match =
        /^\[model_providers\.(?:"([A-Za-z0-9_-]+)"|([A-Za-z0-9_-]+))\]\s*(?:#.*)?$/.exec(line);
      if (!match) {
        target = undefined;
        continue;
      }
      const name = match[1] ?? match[2] ?? '';
      if (Object.hasOwn(providers, name)) throw new Error('Duplicate model provider section.');
      target = {};
      Object.defineProperty(providers, name, { value: target, enumerable: true });
      continue;
    }
    const match = /^([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!target || !match?.[1] || !fields.has(match[1])) continue;
    const name = match[1];
    if (Object.hasOwn(target, name)) throw new Error('Duplicate model configuration field.');
    const quoted = /^(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*(?:#.*)?$/.exec(match[2] ?? '');
    if (!quoted) throw new Error('Model fields must use single-line quoted TOML strings.');
    target[name] = quoted[2] ?? JSON.parse(`"${quoted[1]}"`);
  }
  return { ...root, model_providers: providers };
}

export function parseModelImport(source: ImportSource, text: string): ImportDraft[] {
  if (Buffer.byteLength(text) > MAX_IMPORT_BYTES) throw new Error('Configuration exceeds 1 MiB.');
  let data: Record<string, unknown>;
  try {
    data = source === 'codex' ? codexDocument(text) : obj(JSON.parse(text.replace(/^\uFEFF/, '')));
  } catch {
    throw new Error('Configuration is malformed or uses unsupported model field syntax.');
  }
  const result: ImportDraft[] = [];
  function add(
    provider: string,
    model: unknown,
    baseUrl?: unknown,
    secret?: unknown,
    unsupported?: string,
  ) {
    if (typeof model !== 'string' || !model.trim()) return;
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(provider) || model.length > 200 || /[\r\n]/.test(model))
      throw new Error('Invalid provider or model identifier.');
    if (result.some((item) => item.provider === provider && item.model === model))
      throw new Error('Duplicate model identifier.');
    const warnings: string[] = [];
    const value = key(secret, warnings);
    let url = str(baseUrl);
    if (url) {
      warnings.push(
        'Custom endpoint reasoning and image capabilities are not imported. Review them in Corral model settings before use.',
      );
      try {
        const parsed = new URL(url);
        if (
          parsed.username ||
          parsed.password ||
          parsed.search ||
          parsed.hash ||
          !(
            parsed.protocol === 'https:' ||
            (parsed.protocol === 'http:' &&
              ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))
          )
        )
          throw new Error();
        url = parsed.href.replace(/\/$/, '');
      } catch {
        throw new Error(
          'Endpoint must use HTTPS or loopback HTTP without credentials, query or fragment.',
        );
      }
    }
    result.push({
      provider,
      model,
      ...(url ? { baseUrl: url } : {}),
      ...(value ? { secret: value } : {}),
      warnings,
      ...(unsupported ? { unsupported } : {}),
    });
    if (result.length > 100) throw new Error('Configuration contains more than 100 models.');
  }
  if (source === 'claude-code') {
    const env = obj(data.env);
    const base = str(env.ANTHROPIC_BASE_URL);
    const models = new Set([
      data.model ?? env.ANTHROPIC_MODEL,
      env.ANTHROPIC_DEFAULT_OPUS_MODEL,
      env.ANTHROPIC_DEFAULT_SONNET_MODEL,
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
    ]);
    for (const model of models)
      add(
        'anthropic',
        model,
        undefined,
        env.ANTHROPIC_API_KEY,
        base && base !== 'https://api.anthropic.com'
          ? 'Custom Anthropic endpoints are not supported by this importer.'
          : undefined,
      );
  } else if (source === 'codex') {
    const provider = str(data.model_provider) ?? 'openai';
    const config = obj(obj(data.model_providers)[provider]);
    add(
      provider,
      data.model,
      config.base_url,
      config.experimental_bearer_token ?? (config.env_key ? `env:${config.env_key}` : undefined),
      config.base_url &&
        config.wire_api &&
        config.wire_api !== 'chat' &&
        config.wire_api !== 'chat_completions'
        ? 'This endpoint requires a transport not supported by the compatible endpoint adapter.'
        : undefined,
    );
    if (data.model_reasoning_effort)
      result[0]?.warnings.push(
        'Choose reasoning for the next request in Corral; imported effort is not applied to running work.',
      );
  } else {
    const providers = obj(data[source === 'pi' ? 'providers' : 'provider']);
    const defaultModel = str(data.model);
    if (source === 'opencode' && defaultModel?.includes('/')) {
      const split = defaultModel.indexOf('/');
      const provider = defaultModel.slice(0, split);
      const config = obj(providers[provider]);
      const options = obj(config.options);
      add(
        provider,
        defaultModel.slice(split + 1),
        options.baseURL,
        options.apiKey,
        options.baseURL &&
          config.npm &&
          config.npm !== '@ai-sdk/openai-compatible' &&
          config.npm !== '@ai-sdk/openai'
          ? 'Custom endpoint transport is not OpenAI compatible.'
          : undefined,
      );
    }
    for (const [provider, raw] of Object.entries(providers)) {
      const config = obj(raw);
      const options = source === 'pi' ? config : obj(config.options);
      const models =
        source === 'pi'
          ? Array.isArray(config.models)
            ? config.models.map((m) => obj(m).id)
            : []
          : Object.keys(obj(config.models));
      for (const model of models) {
        if (source === 'opencode' && `${provider}/${model}` === defaultModel) continue;
        add(
          provider,
          model,
          options.baseUrl ?? options.baseURL,
          options.apiKey,
          (options.baseUrl || options.baseURL) &&
            (source === 'pi'
              ? config.api && config.api !== 'openai-completions'
              : config.npm &&
                !['@ai-sdk/openai-compatible', '@ai-sdk/openai'].includes(String(config.npm)))
            ? 'Custom endpoint transport is not OpenAI compatible.'
            : undefined,
        );
      }
    }
  }
  return result;
}
