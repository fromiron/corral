// @vitest-environment jsdom
import {
  ApiError,
  type CatalogProvider,
  type ModelConfig,
  type ModelProfileView,
  type ModelsApi,
  type ProviderAuthView,
} from '@corral/client';
import { DesignKitProvider } from '@corral/react/design-kit';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { ModelConnections } from './ModelConnections.tsx';
import {
  all,
  click,
  control,
  field,
  provider,
  settle,
  stubBrowser,
  type,
  visibleText,
} from './modelTestDom.ts';

const fixture = vi.hoisted(() => ({ models: {} as Partial<ModelsApi>, refresh: vi.fn() }));
vi.mock('../services.tsx', () => ({
  useServices: () => ({ mode: 'server', live: true, models: fixture.models }),
}));
vi.mock('../workbench/modelSettings.tsx', () => ({
  useModelSettingsRefresh: () => fixture.refresh,
}));
vi.mock('../workbench/SettingsLifecycle.tsx', () => ({
  useSettingsForm: () => async () => true,
  useSettingsTask: () => async (task: () => Promise<unknown>) => task(),
}));

const view = (patch: Partial<ModelProfileView>): ModelProfileView => ({
  profileId: `${patch.provider}:${patch.modelId}`,
  source: 'connection',
  provider: 'openai',
  providerName: 'OpenAI',
  modelId: 'gpt-6',
  modelName: null,
  available: true,
  reasoning: false,
  imageInput: false,
  contextWindow: 128_000,
  maxOutputTokens: 4096,
  method: 'oauth',
  keyConfigured: true,
  subscriptionSupported: null,
  ...patch,
});

const config: ModelConfig = {
  revision: 'r1',
  usingDefaults: false,
  modelProfiles: [{ id: 'model-a', provider: 'openai', model: 'gpt-6-luna' }],
  modelProviders: [
    {
      id: 'hive',
      name: 'Hive',
      baseUrl: 'https://api.hive.example/v1',
      access: 'api_key',
      models: [],
    },
  ],
};

const providers: ProviderAuthView[] = [
  provider({
    providerId: 'openai',
    name: 'OpenAI',
    signedIn: true,
    method: 'oauth',
    subscription: true,
    source: 'corral',
    modelCount: 14,
    expiresAt: '2026-11-12T08:00:00Z',
  }),
  provider({
    providerId: 'anthropic',
    name: 'Anthropic',
    methods: { oauth: true, apiKey: true },
    signedIn: true,
    method: 'api_key',
    source: 'corral',
    modelCount: 44,
  }),
  provider({
    providerId: 'google',
    name: 'Google',
    methods: { oauth: false, apiKey: true },
    signedIn: true,
    method: 'api_key',
    source: 'environment',
    modelCount: 12,
  }),
  provider({ providerId: 'mistral', name: 'Mistral', methods: { oauth: false, apiKey: true } }),
  provider({
    providerId: 'hive',
    name: 'Hive',
    endpoint: 'api.hive.example',
    methods: { oauth: false, apiKey: true },
    signedIn: true,
    method: 'api_key',
    source: 'corral',
    modelCount: 2,
    modelFetch: { kind: 'authentication', status: 401, fetchedAt: '2026-11-11T00:00:00Z' },
  }),
];

const profiles: ModelProfileView[] = [
  view({ profileId: 'model-a', source: 'profile', modelId: 'gpt-6-luna', modelName: 'GPT-6 Luna' }),
  ...Array.from({ length: 13 }, (_, i) =>
    view({
      modelId: `gpt-6-${i}`,
      modelName: `GPT-6 Mini ${i}`,
      reasoning: i === 0,
      imageInput: i === 0,
      reasoningCapabilities: { providerDefault: true, levels: ['low', 'medium', 'high'] },
    }),
  ),
  view({
    provider: 'hive',
    providerName: 'Hive',
    modelId: 'deepseek-v4',
    modelName: null,
    reasoning: true,
    // The levels are the server's, for the address the endpoint is on.
    reasoningCapabilities: {
      providerDefault: true,
      levels: ['off', 'minimal', 'low', 'medium', 'high'],
    },
  }),
  view({ provider: 'hive', providerName: 'Hive', modelId: 'qwen-4', modelName: null }),
];

const catalog: CatalogProvider[] = [
  {
    providerId: 'hive',
    name: 'Hive',
    endpoint: true,
    methods: { oauth: false, apiKey: true },
    models: ['deepseek-v4', 'qwen-4'].map((id) => ({
      id,
      name: id,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      limits: {
        contextWindow: { value: 128_000, source: id === 'qwen-4' ? 'catalog' : 'config' },
        maxOutput: { value: 4096, source: 'default' },
        reasoning: { value: id === 'deepseek-v4', source: 'response' },
        imageInput: { value: false, source: 'default' },
      },
    })),
  },
];

let root: Root;
let container: HTMLElement;
const onMakeProfile = vi.fn();
const onOpenProfile = vi.fn();

async function show(
  list = providers,
  {
    models = profiles,
    settings = config,
  }: { models?: ModelProfileView[]; settings?: ModelConfig } = {},
) {
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <DesignKitProvider>
          <ModelConnections
            providers={list}
            catalog={catalog}
            profiles={models}
            config={settings}
            onMakeProfile={onMakeProfile}
            onOpenProfile={onOpenProfile}
          />
        </DesignKitProvider>
      </IntlProvider>,
    ),
  );
}
const row = (name: string) =>
  all('article[data-connection]').find((el) => el.getAttribute('aria-label') === name);
const toggle = (name: string) => click(row(name)?.querySelector('[data-connection-row]'));
const live = () =>
  container.querySelector('[role="status"][aria-live="polite"]')?.textContent ?? '';
const hive = (patch: Partial<ProviderAuthView> = {}) =>
  provider({
    providerId: 'hive',
    name: 'Hive',
    endpoint: 'api.hive.example',
    methods: { oauth: false, apiKey: true },
    signedIn: true,
    method: 'api_key',
    source: 'corral',
    modelCount: 2,
    modelFetch: { kind: 'connected', status: 200, fetchedAt: '2026-11-11T00:00:00Z' },
    ...patch,
  });
const unused: ModelConfig = { ...config, modelProfiles: [] };
const fetched = {
  kind: 'connected' as const,
  status: 200,
  fetchedAt: '2026-11-11T00:00:00Z',
  modelCount: 2,
};

beforeEach(() => {
  stubBrowser();
  fixture.refresh = vi.fn(async () => {});
  fixture.models = {};
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('Connections tab', () => {
  it('shows each connection as one line: the method and count, or the one thing to do', async () => {
    await show();
    // Rows that need the person come first, then the connected ones, each by name.
    expect(all('article[data-connection]').map((el) => el.getAttribute('aria-label'))).toEqual([
      'Hive',
      'Mistral',
      'Anthropic',
      'Google',
      'OpenAI',
    ]);
    expect(visibleText(row('OpenAI'))).toBe('OpenAI Subscription · 14 models');
    expect(visibleText(row('Anthropic'))).toBe('Anthropic API key · 44 models');
    expect(visibleText(row('Google'))).toBe('Google Environment key · 12 models');
    // Nothing to do about a token's expiry, so it is not on the row.
    expect(container.textContent).not.toMatch(/valid until|expires/i);
    expect(visibleText(row('Mistral'))).toBe('Mistral Not connected Connect');
    expect(control('Connect: Mistral')).toBeDefined();
    expect(visibleText(row('Hive'))).toBe('Hive Key refused Enter the key again');
    // The page shows the list and one Add action; no description paragraph.
    expect(control('Add connection')).toBeDefined();
    expect(all('p', container).filter((p) => visibleText(p).length > 40)).toEqual([]);
  });

  it('a connected provider expands into its models, with a filter for a long list', async () => {
    await show();
    await click(row('OpenAI')?.querySelector('[data-connection-row]'));
    const list = all('ul').find((el) => el.getAttribute('aria-label') === 'Models of OpenAI');
    expect(list).toBeDefined();
    // The named profile's model and the 13 connected ones.
    expect(all('li', list).length).toBe(14);
    const mini = all('li', list).find((li) => visibleText(li).startsWith('GPT-6 Mini 0'));
    expect(mini?.querySelector('[data-mark="context"]')?.textContent).toBe('128k');
    expect(mini?.querySelector('[data-mark="reasoning"]')).not.toBeNull();
    expect(mini?.querySelector('[data-mark="image"]')).not.toBeNull();
    // A model a profile already uses opens that profile instead of making another.
    await click(control('Open profile model-a'));
    expect(onOpenProfile).toHaveBeenCalledWith('model-a');
    await click(control('Make a profile for GPT-6 Mini 3'));
    expect(onMakeProfile).toHaveBeenCalledWith('openai', 'gpt-6-3');

    const filter = field('Filter models', row('OpenAI'));
    expect(filter).toBeDefined();
    await type(filter, 'mini 1');
    expect(all('li', list).map((li) => visibleText(li).split(' ').slice(0, 4).join(' '))).toEqual([
      'GPT-6 Mini 1 128k',
      'GPT-6 Mini 10 128k',
      'GPT-6 Mini 11 128k',
      'GPT-6 Mini 12 128k',
    ]);
    expect(control('Disconnect OpenAI')).toBeDefined();
  });

  it('a connection kept only for the profiles that use it says so, not "no models"', async () => {
    // The borrowed Codex sign-in, still named by a profile after Corral's own OpenAI sign-in.
    const codex = provider({
      providerId: 'openai-codex',
      name: 'Codex CLI',
      methods: { oauth: true, apiKey: false },
      signedIn: true,
      method: 'oauth',
      source: 'codex-cli',
      modelCount: 0,
    });
    const named = {
      ...config,
      modelProfiles: [{ id: 'old-codex', provider: 'openai-codex', model: 'gpt-6' }],
    };
    await act(async () =>
      root.render(
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <DesignKitProvider>
            <ModelConnections
              providers={[codex]}
              catalog={catalog}
              profiles={profiles}
              config={named}
              onMakeProfile={onMakeProfile}
              onOpenProfile={onOpenProfile}
            />
          </DesignKitProvider>
        </IntlProvider>,
      ),
    );
    expect(visibleText(row('Codex CLI'))).toBe('Codex CLI Used by old-codex');
  });

  it("an endpoint's values say where they came from unless the config set them", async () => {
    fixture.models = {
      refreshEndpointModels: vi.fn(async () => ({
        kind: 'connected' as const,
        status: 200,
        fetchedAt: '2026-11-11T00:00:00Z',
        modelCount: 2,
      })),
    };
    await show();
    await click(row('Hive')?.querySelector('[data-connection-row]'));
    const hive = row('Hive');
    const qwen = all('li', hive).find((li) => visibleText(li).startsWith('qwen-4'));
    const deepseek = all('li', hive).find((li) => visibleText(li).startsWith('deepseek-v4'));
    expect(qwen?.querySelector('[data-mark="context"]')?.getAttribute('title')).toContain(
      'from models.dev',
    );
    expect(deepseek?.querySelector('[data-mark="context"]')?.getAttribute('title')).not.toContain(
      '(',
    );
    expect(deepseek?.querySelector('[data-mark="reasoning"]')?.getAttribute('title')).toContain(
      'from the address',
    );
    expect(deepseek?.querySelector('[data-mark="reasoning"]')?.getAttribute('title')).toContain(
      'Off, Minimal, Low, Medium, High',
    );
    expect(control('Edit address')).toBeDefined();
    expect(control('Remove Hive')).toBeDefined();
    await click(control('Refresh models'));
    await settle();
    expect(fixture.models.refreshEndpointModels).toHaveBeenCalledWith('hive', 'r1');
    expect(fixture.refresh).toHaveBeenCalled();
  });
  it('offers Disconnect only for a sign-in or key Corral holds itself', async () => {
    const borrowed = provider({
      providerId: 'openai-codex',
      name: 'Codex CLI',
      methods: { oauth: true, apiKey: false },
      signedIn: true,
      method: 'oauth',
      source: 'codex-cli',
      modelCount: 0,
    });
    await show([...providers, borrowed]);
    const offered = async (name: string) => {
      await toggle(name);
      const found = control(`Disconnect ${name}`, row(name));
      await toggle(name);
      return found !== undefined;
    };
    expect(await offered('OpenAI')).toBe(true);
    expect(await offered('Anthropic')).toBe(true);
    // A key from the environment and a borrowed login are not Corral's to remove.
    expect(await offered('Google')).toBe(false);
    await toggle('Codex CLI');
    expect(control('Disconnect Codex CLI')).toBeUndefined();
    expect(control('Sign in to Corral instead', row('Codex CLI'))).toBeDefined();
  });

  it('removes an endpoint from the config first and its key only after that is saved', async () => {
    const calls: string[] = [];
    fixture.models = {
      saveConfig: vi.fn(async () => {
        calls.push('saveConfig');
        return { ...unused, modelProviders: [] };
      }),
      logout: vi.fn(async () => {
        calls.push('logout');
        return [];
      }),
    };
    await show([hive()], { settings: unused });
    await toggle('Hive');
    await click(control('Remove Hive'));
    await settle();
    expect(calls).toEqual(['saveConfig', 'logout']);
    expect(fixture.models.saveConfig).toHaveBeenCalledWith({
      revision: 'r1',
      modelProfiles: [],
      modelProviders: [],
    });
  });

  it('keeps the key of an endpoint whose removal was not saved', async () => {
    fixture.models = {
      saveConfig: vi.fn(async () => {
        throw new ApiError(409, 'REVISION_CONFLICT', 'the config changed');
      }),
      config: vi.fn(async () => {
        throw new Error('offline');
      }),
      logout: vi.fn(async () => []),
    };
    await show([hive()], { settings: unused });
    await toggle('Hive');
    await click(control('Remove Hive'));
    await settle();
    expect(fixture.models.logout).not.toHaveBeenCalled();
    expect(row('Hive')?.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('refuses to remove an endpoint a profile uses and names the profiles', async () => {
    fixture.models = { saveConfig: vi.fn(), logout: vi.fn() };
    await show([hive()], {
      settings: { ...config, modelProfiles: [{ id: 'fast', provider: 'hive', model: 'qwen-4' }] },
    });
    await toggle('Hive');
    await click(control('Remove Hive'));
    expect(fixture.models.saveConfig).not.toHaveBeenCalled();
    expect(fixture.models.logout).not.toHaveBeenCalled();
    expect(row('Hive')?.querySelector('[role="alert"]')?.textContent).toBe('Used by fast');
  });

  it('refreshes models again on the new revision when only the revision moved', async () => {
    fixture.models = {
      refreshEndpointModels: vi
        .fn()
        .mockRejectedValueOnce(new ApiError(409, 'REVISION_CONFLICT', 'the config changed'))
        .mockResolvedValue(fetched),
      config: vi.fn(async () => ({ ...config, revision: 'r2' })),
    };
    await show();
    await toggle('Hive');
    await click(control('Refresh models'));
    await settle();
    expect(fixture.models.refreshEndpointModels).toHaveBeenLastCalledWith('hive', 'r2');
    expect(row('Hive')?.querySelector('[role="alert"]')).toBeNull();
  });

  it('does not say an action failed when only reading the lists after it failed', async () => {
    fixture.models = { refreshEndpointModels: vi.fn(async () => fetched) };
    fixture.refresh = vi.fn(async () => {
      throw new Error('offline');
    });
    await show();
    await toggle('Hive');
    await click(control('Refresh models'));
    await settle();
    expect(row('Hive')?.querySelector('[role="alert"]')).toBeNull();
  });

  it('clears the model filter when the list folds or shrinks below the filter', async () => {
    await show();
    await toggle('OpenAI');
    const list = () => all('ul').find((el) => el.getAttribute('aria-label') === 'Models of OpenAI');
    await type(field('Filter models', row('OpenAI')), 'mini 1');
    expect(all('li', list()).length).toBe(4);
    await toggle('OpenAI');
    await toggle('OpenAI');
    expect(field('Filter models', row('OpenAI'))?.value).toBe('');
    expect(all('li', list()).length).toBe(14);
    // Filtered again, then the list shrinks below the filter: no hidden filter stays applied.
    await type(field('Filter models', row('OpenAI')), 'mini 12');
    expect(all('li', list()).length).toBe(1);
    await show(providers, { models: profiles.slice(0, 5) });
    expect(field('Filter models', row('OpenAI'))).toBeUndefined();
    expect(all('li', list()).length).toBe(5);
    // One row keeps the list's tab stop.
    expect(all('[data-model-action]', list()).filter((el) => el.tabIndex === 0)).toHaveLength(1);
  });

  it('keeps the list’s tab stop on a row that is still there when the list shrinks', async () => {
    await show();
    await toggle('OpenAI');
    const list = () => all('ul').find((el) => el.getAttribute('aria-label') === 'Models of OpenAI');
    const actions = () => all('[data-model-action]', list());
    actions()[10]?.focus();
    await act(async () => {
      actions()[10]?.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    });
    await show(providers, { models: profiles.slice(0, 4) });
    expect(actions().filter((el) => el.tabIndex === 0)).toHaveLength(1);
  });

  it('announces a connection that changed, not every row on first load or a busy action', async () => {
    const pending = new Promise<never>(() => {});
    fixture.models = { refreshEndpointModels: vi.fn(() => pending) };
    await show();
    expect(live()).toBe('');
    await toggle('Hive');
    await click(control('Refresh models'));
    expect(live()).toBe('');
  });

  it('lists only models the connection can call, by the pickers’ rule', async () => {
    await show(providers, {
      models: [
        ...profiles,
        view({ modelId: 'gpt-6-pro', modelName: 'GPT-6 Pro', subscriptionSupported: false }),
      ],
    });
    await toggle('OpenAI');
    expect(row('OpenAI')?.textContent).not.toContain('GPT-6 Pro');
  });
});
