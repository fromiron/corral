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
import { AddConnectionDialog, type AddConnectionStart } from './AddConnectionDialog.tsx';
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
vi.mock('./ModelImportPanel.tsx', () => ({
  ModelImportPanel: () => <p data-testid="import-face">import from another tool</p>,
}));

const entry = (providerId: string, name: string, methods: CatalogProvider['methods']) => ({
  providerId,
  name,
  endpoint: false,
  methods,
  models: [],
});
const catalog: CatalogProvider[] = [
  entry('openai', 'OpenAI', { oauth: true, apiKey: true }),
  entry('github-copilot', 'GitHub Copilot', { oauth: true, apiKey: false }),
  entry('mistral', 'Mistral', { oauth: false, apiKey: true }),
  entry('anthropic', 'Anthropic', { oauth: true, apiKey: true }),
];
const config: ModelConfig = {
  revision: 'r1',
  usingDefaults: false,
  modelProfiles: [],
  modelProviders: [],
};
const model = (provider: string, modelId: string): ModelProfileView => ({
  profileId: `${provider}:${modelId}`,
  source: 'connection',
  provider,
  providerName: provider,
  modelId,
  modelName: null,
  available: true,
  reasoning: false,
  contextWindow: 32_000,
  maxOutputTokens: 4096,
  method: 'api_key',
  keyConfigured: true,
  subscriptionSupported: null,
});

let root: Root;
let container: HTMLElement;
const onOpenChange = vi.fn();
let state: { providers: ProviderAuthView[]; profiles: ModelProfileView[]; config: ModelConfig };

const page = (start: AddConnectionStart) => (
  <IntlProvider locale="en" messages={messages} timeZone="UTC">
    <DesignKitProvider>
      <AddConnectionDialog
        open
        onOpenChange={onOpenChange}
        start={start}
        providers={state.providers}
        catalog={catalog}
        config={state.config}
        profiles={state.profiles}
      />
    </DesignKitProvider>
  </IntlProvider>
);
async function show(start: AddConnectionStart = { face: 'find' }) {
  await act(async () => root.render(page(start)));
  await settle();
}
const title = () => visibleText(document.body.querySelector('[role="dialog"] h2'));
// A face that leaves springs out for 120 ms; checks after a face change read the one that stays.
const faceSettles = () => settle(300);

beforeEach(() => {
  stubBrowser();
  state = {
    providers: [provider({ providerId: 'openai', signedIn: true, method: 'oauth', modelCount: 3 })],
    profiles: [],
    config,
  };
  // The page re-reads every list after a change; here it renders again with the current state,
  // inside the act of whatever called it.
  fixture.refresh = vi.fn(async () => {
    root.render(page(currentStart));
  });
  fixture.models = {};
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
let currentStart: AddConnectionStart = { face: 'find' };
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('Add connection', () => {
  it('finds a provider, marks the connected ones, and offers an address and an import', async () => {
    await show();
    expect(title()).toBe('Add connection');
    const search = field('Search providers');
    expect(search).toBeDefined();
    const rows = () =>
      all('[data-directory-row]').map((el) => visibleText(el).split(' ').slice(0, 2).join(' '));
    expect(rows()[0]).toBe('OpenAI-compatible address');
    // Connected providers are marked; methods are what the server reports for each provider.
    const openai = all('[data-directory-row]').find((el) =>
      visibleText(el).startsWith('OpenAI Subscription'),
    );
    expect(visibleText(openai)).toBe('OpenAI Subscription · API key');
    expect(openai?.textContent).toContain('Connected');
    const anthropic = all('[data-directory-row]').find((el) =>
      visibleText(el).startsWith('Anthropic'),
    );
    expect(visibleText(anthropic)).toBe('Anthropic Subscription · API key');
    await type(search, 'copilot');
    expect(rows()).toEqual(['GitHub Copilot']);
    await type(search, 'zzz');
    expect(document.body.textContent).toContain('No provider matches “zzz”.');
    await type(search, '');
    await click(control('Import from another tool’s settings'));
    await faceSettles();
    expect(title()).toBe('Import settings');
    expect(document.body.querySelector('[data-testid="import-face"]')).not.toBeNull();
    await click(control('Back'));
    await faceSettles();
    expect(title()).toBe('Add connection');
  });

  it('signs in on the provider page with a device code, then shows the models found', async () => {
    const login = { state: 'waiting' as const, authUrl: null, userCode: null, error: null };
    fixture.models = {
      startLogin: vi.fn(async () => login),
      cancelLogin: vi.fn(async () => []),
    };
    state.providers = [];
    currentStart = { face: 'connect', providerId: 'github-copilot' };
    await show(currentStart);
    expect(fixture.models.startLogin).toHaveBeenCalledWith('github-copilot');
    expect(title()).toBe('GitHub Copilot');
    expect(document.body.textContent).toContain('Preparing sign-in');
    // The poll reports the provider page and the code to enter there.
    state.providers = [
      provider({
        providerId: 'github-copilot',
        name: 'GitHub Copilot',
        methods: { oauth: true, apiKey: false },
        login: {
          state: 'waiting',
          authUrl: 'https://github.example/login/device',
          userCode: 'WDJB-MJHT',
          error: null,
        },
      }),
    ];
    await show(currentStart);
    const open = control('Open GitHub Copilot sign-in') as HTMLAnchorElement;
    expect(open.href).toBe('https://github.example/login/device');
    expect(open.rel).toContain('noopener');
    // The code is shown to type on that page, with a copy control.
    const code = all('button').find((button) => button.textContent?.includes('WDJB-MJHT'));
    expect(code?.getAttribute('aria-label')).toBe('Copy');
    expect(code?.getAttribute('aria-labelledby')).toContain(code?.id);
    // A device code needs no pasted address.
    expect(control('Paste the address instead')).toBeUndefined();

    state.providers = [
      provider({
        providerId: 'github-copilot',
        name: 'GitHub Copilot',
        methods: { oauth: true, apiKey: false },
        signedIn: true,
        method: 'oauth',
        modelCount: 2,
      }),
    ];
    state.profiles = [model('github-copilot', 'gpt-6'), model('github-copilot', 'claude-opus')];
    await show(currentStart);
    await faceSettles();
    expect(document.body.querySelector('[role="status"]')?.textContent).toContain('2 models ready');
    expect(all('li').map((li) => visibleText(li))).toEqual(['gpt-6', 'claude-opus']);
    await click(control('Done'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(fixture.models.cancelLogin).not.toHaveBeenCalled();
  });

  it('takes the final address when the sign-in callback does not arrive, and cancels on Back', async () => {
    fixture.models = {
      startLogin: vi.fn(async () => ({
        state: 'waiting' as const,
        authUrl: 'https://auth.example/authorize',
        userCode: null,
        error: null,
      })),
      submitRedirect: vi.fn(async () => true),
      cancelLogin: vi.fn(async () => []),
    };
    state.providers = [
      provider({
        providerId: 'openai',
        login: {
          state: 'waiting',
          authUrl: 'https://auth.example/authorize',
          userCode: null,
          error: null,
        },
      }),
    ];
    currentStart = { face: 'connect', providerId: 'openai' };
    await show(currentStart);
    // OpenAI has both methods: the person chooses; subscription comes first.
    expect(control('Subscription')?.getAttribute('aria-selected')).toBe('true');
    await click(control('Paste the address instead'));
    await type(field('Address the browser stopped on'), 'http://127.0.0.1:1455/cb?code=x');
    await click(control('Use this address'));
    expect(fixture.models.submitRedirect).toHaveBeenCalledWith(
      'openai',
      'http://127.0.0.1:1455/cb?code=x',
    );
    // The pasted address is not shown again.
    expect(all<HTMLInputElement>('input').some((input) => input.value.includes('code=x'))).toBe(
      false,
    );
    await click(control('Back'));
    await faceSettles();
    expect(fixture.models.cancelLogin).toHaveBeenCalledWith('openai');
    expect(title()).toBe('Add connection');
  });

  it('stays on the connect face when sign-in fails and says what to do', async () => {
    fixture.models = {
      startLogin: vi.fn(async () => ({
        state: 'waiting' as const,
        authUrl: null,
        userCode: null,
        error: null,
      })),
      cancelLogin: vi.fn(async () => []),
    };
    state.providers = [
      provider({
        providerId: 'github-copilot',
        name: 'GitHub Copilot',
        methods: { oauth: true, apiKey: false },
        login: { state: 'failed', authUrl: null, userCode: null, error: 'the code expired' },
      }),
    ];
    currentStart = { face: 'connect', providerId: 'github-copilot' };
    await show(currentStart);
    expect(title()).toBe('GitHub Copilot');
    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(
      'Sign-in didn’t finish: the code expired',
    );
    await click(control('Try again'));
    expect(fixture.models.startLogin).toHaveBeenCalledTimes(2);
  });

  it('saves an API key and shows the refusal reason the server gives', async () => {
    fixture.models = {
      setApiKey: vi
        .fn()
        .mockRejectedValueOnce(
          new ApiError(
            501,
            'COMMAND_NOT_SUPPORTED',
            'Cloudflare Workers AI needs an account id as well as a key.',
          ),
        )
        .mockResolvedValue([]),
    };
    state.providers = [];
    currentStart = { face: 'connect', providerId: 'mistral' };
    await show(currentStart);
    const key = field('API key');
    await type(key, 'sk-test');
    await click(control('Connect'));
    expect(fixture.models.setApiKey).toHaveBeenCalledWith('mistral', 'sk-test', 'r1');
    // The key step stays, with the server's reason as it gave it.
    expect(title()).toBe('Mistral');
    expect(field('API key')).toBeDefined();
    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(
      'Cloudflare Workers AI needs an account id as well as a key.',
    );
    state.providers = [
      provider({
        providerId: 'mistral',
        name: 'Mistral',
        methods: { oauth: false, apiKey: true },
        signedIn: true,
        method: 'api_key',
        modelCount: 1,
      }),
    ];
    state.profiles = [model('mistral', 'mistral-large')];
    await click(control('Connect'));
    await faceSettles();
    expect(document.body.querySelector('[role="status"]')?.textContent).toContain('1 model ready');
    // The key is never shown after entry.
    expect(all<HTMLInputElement>('input').some((input) => input.value === 'sk-test')).toBe(false);
  });

  it('adds an endpoint from only an address and a key, then lists what it fetched', async () => {
    const saved: ModelConfig = {
      ...config,
      revision: 'r2',
      modelProviders: [
        {
          id: 'local-server',
          name: 'Local server',
          baseUrl: 'http://127.0.0.1:11434/v1',
          access: 'api_key',
          models: [],
        },
      ],
    };
    fixture.models = {
      saveConfig: vi.fn(async () => saved),
      setApiKey: vi.fn(async () => []),
      refreshEndpointModels: vi
        .fn()
        .mockResolvedValueOnce({
          kind: 'authentication',
          status: 401,
          fetchedAt: '2026-11-11T00:00:00Z',
          modelCount: 0,
        })
        .mockResolvedValue({
          kind: 'connected',
          status: 200,
          fetchedAt: '2026-11-11T00:00:00Z',
          modelCount: 2,
        }),
    };
    currentStart = { face: 'address' };
    await show(currentStart);
    expect(title()).toBe('OpenAI-compatible address');
    await type(field('Address'), 'http://192.168.0.9/v1');
    await click(control('Connect'));
    // An http address off this computer is refused before anything is saved.
    expect(fixture.models.saveConfig).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Use https, or http only on this computer');
    await type(field('Name'), 'Local server');
    await type(field('Address'), 'http://127.0.0.1:11434/v1');
    await type(field('API key'), 'sk-local');
    await click(control('Connect'));
    expect(fixture.models.saveConfig).toHaveBeenCalledWith({
      revision: 'r1',
      modelProfiles: [],
      modelProviders: [
        {
          id: 'local-server',
          name: 'Local server',
          baseUrl: 'http://127.0.0.1:11434/v1',
          access: 'api_key',
          models: [],
        },
      ],
    });
    expect(fixture.models.setApiKey).toHaveBeenCalledWith('local-server', 'sk-local', 'r2');
    expect(fixture.models.refreshEndpointModels).toHaveBeenCalledWith('local-server', 'r2');
    // The fetch was refused: stay here with the category and the next step.
    expect(title()).toBe('OpenAI-compatible address');
    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(
      'The address refused the key. Enter the key again.',
    );
    // Trying again edits the endpoint that was saved instead of adding another.
    state.config = saved;
    state.profiles = [model('local-server', 'llama-4'), model('local-server', 'qwen-4')];
    await type(field('API key'), 'sk-local-2');
    await click(control('Connect'));
    expect(fixture.models.saveConfig).toHaveBeenCalledTimes(1);
    expect(fixture.models.setApiKey).toHaveBeenLastCalledWith('local-server', 'sk-local-2', 'r2');
    await faceSettles();
    expect(document.body.querySelector('[role="status"]')?.textContent).toContain('2 models ready');
  });
});
