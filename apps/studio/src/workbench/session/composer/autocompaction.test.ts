import { ApiError, type ModelConfig, type ModelProfileView, type ModelsApi } from '@corral/client';
import type { ProfileContextPolicy } from '@corral/contracts';
import { createTranslator } from 'use-intl';
import { expect, it, vi } from 'vitest';
import en from '../../../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { autoCompaction } from './commands.ts';

// workbench.md `/autocompaction`: the context window of the model the composer has chosen, set
// with a value, cleared with `off`, shown without one; refused with a reason, changing nothing.

const policy = (
  contextWindow: number,
  source: ProfileContextPolicy['sources']['contextWindow'],
): ProfileContextPolicy => ({
  version: 2,
  contextWindow,
  reserveTokens: 16_384,
  keepRecentTokens: 20_000,
  explicit: source === 'profile' || source === 'model',
  configRevision: 'r1',
  baseContextWindow: 500_000,
  baseSource: 'catalog',
  sources: { contextWindow: source, reserveTokens: 'adaptive', keepRecentTokens: 'adaptive' },
  warnings: [],
});

const view = (patch: Partial<ModelProfileView>): ModelProfileView => ({
  profileId: 'openai:gpt-6-luna',
  source: 'connection',
  provider: 'openai',
  providerName: 'OpenAI',
  modelId: 'gpt-6-luna',
  modelName: 'GPT-6 Luna',
  available: true,
  reasoning: false,
  contextWindow: 500_000,
  contextPolicy: policy(500_000, 'catalog'),
  maxOutputTokens: 4096,
  method: 'oauth',
  keyConfigured: true,
  subscriptionSupported: null,
  ...patch,
});

const config: ModelConfig = {
  revision: 'r1',
  usingDefaults: false,
  modelProfiles: [],
  modelProviders: [],
  modelContextWindows: [],
};

function setup(
  options: {
    modelProfile?: string;
    lists?: ModelProfileView[][];
    save?: ModelsApi['setModelContextWindow'];
    config?: ModelConfig;
  } = {},
) {
  const lists = options.lists ?? [[view({})]];
  let read = 0;
  const models = {
    profiles: vi.fn(async () => lists[Math.min(read++, lists.length - 1)] ?? []),
    config: vi.fn(async () => options.config ?? config),
    saveConfig: vi.fn(async () => ({ ...(options.config ?? config), revision: 'r2' })),
    setModelContextWindow: vi.fn(
      options.save ?? (async () => ({ modelContextWindows: [], revision: 'r2' })),
    ),
  };
  const deps = {
    models,
    modelProfile: options.modelProfile ?? 'openai:gpt-6-luna',
    tc: createTranslator({ locale: 'en', messages: en, namespace: 'Composer' }) as never,
    sourceName: createTranslator({
      locale: 'en',
      messages: en,
      namespace: 'ProfileContext',
    }) as never,
    setError: vi.fn(),
    setNotice: vi.fn(),
  };
  const last = (fn: { mock: { calls: unknown[][] } }) => fn.mock.calls.at(-1)?.[0];
  return { deps, models, error: () => last(deps.setError), notice: () => last(deps.setNotice) };
}

it('200k sets 200,000 for the chosen model and says the next run uses it, not as an error', async () => {
  const set = setup({
    lists: [
      [view({})],
      [view({ contextWindow: 200_000, contextPolicy: policy(200_000, 'model') })],
    ],
  });
  await autoCompaction(set.deps, '200k');
  expect(set.models.setModelContextWindow).toHaveBeenCalledWith({
    revision: 'r1',
    provider: 'openai',
    model: 'gpt-6-luna',
    contextWindow: 200_000,
  });
  expect(set.notice()).toBe('GPT-6 Luna: context window 200,000 from the next run');
  expect(set.error()).toBeNull();
});

it('1M sets 1,000,000 and off clears the value; the window shown after is the one in effect', async () => {
  const million = setup();
  await autoCompaction(million.deps, '1M');
  expect(million.models.setModelContextWindow).toHaveBeenCalledWith(
    expect.objectContaining({ contextWindow: 1_000_000 }),
  );
  const off = setup({
    lists: [
      [view({ contextWindow: 200_000, contextPolicy: policy(200_000, 'model') })],
      [view({})],
    ],
  });
  await autoCompaction(off.deps, 'OFF');
  expect(off.models.setModelContextWindow).toHaveBeenCalledWith(
    expect.objectContaining({ model: 'gpt-6-luna', contextWindow: null }),
  );
  expect(off.notice()).toBe('GPT-6 Luna: context window 500,000 from the next run');
});

it('without a value it shows the window in effect and where it comes from, changing nothing', async () => {
  const shown = setup({
    lists: [[view({ contextWindow: 200_000, contextPolicy: policy(200_000, 'model') })]],
  });
  await autoCompaction(shown.deps, undefined);
  expect(shown.models.setModelContextWindow).not.toHaveBeenCalled();
  expect(shown.notice()).toBe('GPT-6 Luna: context window 200,000 (per-model override)');
  const unknown = setup({ lists: [[view({ contextWindow: null, contextPolicy: undefined })]] });
  await autoCompaction(unknown.deps, undefined);
  expect(unknown.notice()).toBe('GPT-6 Luna: the context window is not known');
});

it('a chosen profile that sets its own window has that value changed or cleared, and shown', async () => {
  const owned = view({
    profileId: 'model-a',
    source: 'profile',
    contextWindow: 120_000,
    contextPolicy: policy(120_000, 'profile'),
  });
  const saved = {
    ...config,
    modelProfiles: [
      {
        id: 'model-a',
        provider: 'openai',
        model: 'gpt-6-luna',
        contextWindow: 120_000,
        compaction: { reserveTokens: 25_000 },
      },
      { id: 'model-b', provider: 'openai', model: 'gpt-6-sol' },
    ],
    modelContextWindows: [{ provider: 'openai', model: 'gpt-6-luna', contextWindow: 300_000 }],
  };
  const set = setup({ modelProfile: 'model-a', lists: [[owned]], config: saved });
  await autoCompaction(set.deps, '200k');
  expect(set.models.setModelContextWindow).not.toHaveBeenCalled();
  expect(set.models.saveConfig).toHaveBeenCalledWith({
    revision: 'r1',
    modelProfiles: [{ ...saved.modelProfiles[0], contextWindow: 200_000 }, saved.modelProfiles[1]],
    modelProviders: [],
  });
  expect(set.notice()).toBe('GPT-6 Luna: context window 200,000 from the next run');
  expect(set.error()).toBeNull();
  const cleared = setup({ modelProfile: 'model-a', lists: [[owned]], config: saved });
  await autoCompaction(cleared.deps, 'off');
  expect(cleared.models.saveConfig).toHaveBeenCalledWith({
    revision: 'r1',
    modelProfiles: [
      {
        id: 'model-a',
        provider: 'openai',
        model: 'gpt-6-luna',
        compaction: { reserveTokens: 25_000 },
      },
      saved.modelProfiles[1],
    ],
    modelProviders: [],
  });
  expect(cleared.notice()).toBe('GPT-6 Luna: context window 300,000 from the next run');
  const shown = setup({ modelProfile: 'model-a', lists: [[owned]] });
  await autoCompaction(shown.deps, undefined);
  expect(shown.notice()).toBe('GPT-6 Luna: context window 120,000 (profile override)');
});

it('a value it cannot read, or no chosen model, is refused with a reason and nothing is read or written', async () => {
  const unreadable = setup();
  await autoCompaction(unreadable.deps, '200x');
  expect(unreadable.error()).toBe('Write a size like 200000, 200k or 1m, or off to clear it.');
  expect(unreadable.models.profiles).not.toHaveBeenCalled();
  expect(unreadable.models.setModelContextWindow).not.toHaveBeenCalled();
  const none = setup({ modelProfile: 'model-a' });
  await autoCompaction(none.deps, '200k');
  expect(none.error()).toBe('Choose a model first.');
  expect(none.models.setModelContextWindow).not.toHaveBeenCalled();
  const offline = setup();
  await autoCompaction({ ...offline.deps, models: null }, '200k');
  expect(offline.error()).toBe('Choose a model first.');
});

it('a changed config is read again and the save tried once more; a refusal shows the server’s reason', async () => {
  const save = vi
    .fn()
    .mockRejectedValueOnce(new ApiError(409, 'REVISION_CONFLICT', 'the config changed'))
    .mockResolvedValue({ modelContextWindows: [], revision: 'r3' });
  const retried = setup({ save });
  retried.models.config
    .mockResolvedValueOnce(config)
    .mockResolvedValueOnce({ ...config, revision: 'r2' });
  await autoCompaction(retried.deps, '200k');
  expect(save).toHaveBeenCalledTimes(2);
  expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ revision: 'r2' }));
  expect(retried.error()).toBeNull();

  const again = vi.fn(async () => {
    throw new ApiError(409, 'REVISION_CONFLICT', 'the config changed');
  });
  const twice = setup({ save: again });
  await autoCompaction(twice.deps, '200k');
  expect(again).toHaveBeenCalledTimes(2);
  expect(twice.error()).toBe('the config changed');

  const refused = setup({
    save: async () => {
      throw new ApiError(400, 'SCHEMA_INVALID', 'modelProfiles.2: context policy requires …');
    },
  });
  await autoCompaction(refused.deps, '10000');
  expect(refused.error()).toBe('modelProfiles.2: context policy requires …');
  expect(refused.notice()).toBeNull();
});
