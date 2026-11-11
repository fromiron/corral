// @vitest-environment jsdom
import type {
  CatalogProvider,
  LoginView,
  ModelConfig,
  ModelsApi,
  ProviderAuthView,
} from '@corral/client';
import { DesignKitProvider } from '@corral/react/design-kit';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import {
  act,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  StrictMode,
  useState,
} from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { SettingsLeavePrompt, SettingsLifecycle } from '../workbench/SettingsLifecycle.tsx';
import { AddConnectionDialog, type AddConnectionStart } from './AddConnectionDialog.tsx';
import { ModelConnections } from './ModelConnections.tsx';
import { click, control, field, provider, settle, stubBrowser, type } from './modelTestDom.ts';

// The add-connection dialog and the Connections tab with the real settings lifecycle: the leave
// guard and the settings tasks are the ones the app uses, not stand-ins.

const fixture = vi.hoisted(() => ({
  // One object for the whole test, as the app's services are: the lifecycle keys its tasks on it.
  services: { mode: 'server', live: true, models: {} as Partial<ModelsApi> },
  refresh: vi.fn(),
}));
vi.mock('../services.tsx', () => ({ useServices: () => fixture.services }));
vi.mock('../workbench/modelSettings.tsx', () => ({
  useModelSettingsRefresh: () => fixture.refresh,
}));

const entry = (providerId: string, name: string, methods: CatalogProvider['methods']) => ({
  providerId,
  name,
  endpoint: false,
  methods,
  models: [],
});
const catalog: CatalogProvider[] = [
  entry('github-copilot', 'GitHub Copilot', { oauth: true, apiKey: false }),
  entry('anthropic', 'Anthropic', { oauth: true, apiKey: true }),
];
const config: ModelConfig = {
  revision: 'r1',
  usingDefaults: false,
  modelProfiles: [],
  modelProviders: [],
};
const waiting: LoginView = {
  state: 'waiting',
  authUrl: 'https://auth.example/authorize',
  userCode: null,
  error: null,
};

/** A promise settled from the test. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

let content: () => ReactNode = () => null;
const view: { redraw: Dispatch<SetStateAction<number>> } = { redraw: () => {} };
function Shell() {
  const [, redraw] = useState(0);
  view.redraw = redraw;
  return (
    <SettingsLifecycle>
      {content()}
      <SettingsLeavePrompt />
    </SettingsLifecycle>
  );
}

let reactRoot: Root;
let container: HTMLElement;
async function mount(node: () => ReactNode, strict = false) {
  content = node;
  const root = createRootRoute({ component: Shell });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: '/settings/models' }),
    ]),
    history: createMemoryHistory({ initialEntries: ['/settings/models'] }),
  });
  const app = <RouterProvider router={router} />;
  await act(async () => {
    reactRoot.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <DesignKitProvider>{strict ? <StrictMode>{app}</StrictMode> : app}</DesignKitProvider>
      </IntlProvider>,
    );
    await router.load();
  });
  await settle();
}
const redraw = () => act(async () => view.redraw((n) => n + 1));
const leavePrompt = () => document.body.querySelector('[data-settings-guard]');
const onOpenChange = vi.fn();
const dialog = (start: AddConnectionStart, providers: ProviderAuthView[] = []) => (
  <AddConnectionDialog
    open
    onOpenChange={onOpenChange}
    start={start}
    providers={providers}
    catalog={catalog}
    config={config}
    profiles={[]}
  />
);

beforeEach(() => {
  stubBrowser();
  fixture.refresh = vi.fn(async () => {});
  fixture.services.models = {};
  container = document.createElement('div');
  document.body.append(container);
  reactRoot = createRoot(container);
});
afterEach(async () => {
  await act(async () => reactRoot.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('add connection with the real leave guard and tasks', () => {
  it('asks before closing whenever a field holds typed input, whatever was edited last', async () => {
    await mount(() => dialog({ face: 'address' }));
    await type(field('API key'), 'sk-local');
    // The last edit puts a field back as it was; the key is still typed.
    await type(field('Name'), 'x');
    await type(field('Name'), '');
    await click(control('Close'));
    expect(leavePrompt()).not.toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('asks before closing with a path typed on the import face', async () => {
    await mount(() => dialog({ face: 'import' }));
    await type(field('Configuration file (optional)'), '~/.claude/settings.json');
    await click(control('Close'));
    expect(leavePrompt()).not.toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('keeps Try again off while a sign-in is starting and never shows a task sentence', async () => {
    const started = deferred<LoginView>();
    fixture.services.models = {
      startLogin: vi.fn(() => started.promise),
      cancelLogin: vi.fn(async () => []),
    };
    const failed = provider({
      providerId: 'github-copilot',
      name: 'GitHub Copilot',
      methods: { oauth: true, apiKey: false },
      login: { state: 'failed', authUrl: null, userCode: null, error: 'the code expired' },
    });
    await mount(() => dialog({ face: 'connect', providerId: 'github-copilot' }, [failed]));
    expect(fixture.services.models.startLogin).toHaveBeenCalledTimes(1);
    const again = control('Try again') as HTMLButtonElement | undefined;
    expect(again?.disabled).toBe(true);
    await click(again);
    await click(again);
    expect(fixture.services.models.startLogin).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain('still pending');
    await act(async () => started.resolve(waiting));
  });

  it('a late failure of one provider’s start leaves the next provider’s sign-in followed', async () => {
    const first = deferred<LoginView>();
    fixture.services.models = {
      startLogin: vi.fn((id: string) =>
        id === 'github-copilot' ? first.promise : Promise.resolve(waiting),
      ),
      cancelLogin: vi.fn(async () => []),
    };
    await mount(() => dialog({ face: 'find' }));
    await click(
      [...document.querySelectorAll<HTMLElement>('[data-directory-row]')].find((el) =>
        el.textContent?.includes('GitHub Copilot'),
      ),
    );
    await settle(300);
    await click(control('Back'));
    await settle(300);
    await click(
      [...document.querySelectorAll<HTMLElement>('[data-directory-row]')].find((el) =>
        el.textContent?.includes('Anthropic'),
      ),
    );
    await settle(300);
    expect(fixture.services.models.startLogin).toHaveBeenLastCalledWith('anthropic');
    await act(async () => first.reject(new Error('offline')));
    await click(control('Close'));
    await settle();
    expect(fixture.services.models.cancelLogin).toHaveBeenLastCalledWith('anthropic');
  });

  it('starts a sign-in once under StrictMode and does not cancel it on the first cleanup', async () => {
    fixture.services.models = {
      startLogin: vi.fn(async () => waiting),
      cancelLogin: vi.fn(async () => []),
    };
    await mount(() => dialog({ face: 'connect', providerId: 'github-copilot' }), true);
    await settle(50);
    expect(fixture.services.models.startLogin).toHaveBeenCalledTimes(1);
    expect(fixture.services.models.cancelLogin).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Waiting for you to finish signing in');
  });

  it('cancels a running sign-in when the dialog closes', async () => {
    fixture.services.models = {
      startLogin: vi.fn(async () => waiting),
      cancelLogin: vi.fn(async () => []),
    };
    await mount(() => dialog({ face: 'connect', providerId: 'github-copilot' }));
    await click(control('Close'));
    await settle();
    expect(fixture.services.models.cancelLogin).toHaveBeenCalledWith('github-copilot');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('cancels a running sign-in when the dialog goes away', async () => {
    fixture.services.models = {
      startLogin: vi.fn(async () => waiting),
      cancelLogin: vi.fn(async () => []),
    };
    await mount(() => dialog({ face: 'connect', providerId: 'github-copilot' }));
    content = () => null;
    await redraw();
    await settle(50);
    expect(fixture.services.models.cancelLogin).toHaveBeenCalledWith('github-copilot');
  });
});

describe('connections with the real settings tasks', () => {
  const connected = [
    provider({
      providerId: 'openai',
      name: 'OpenAI',
      signedIn: true,
      method: 'oauth',
      subscription: true,
      source: 'corral',
      modelCount: 0,
    }),
    provider({
      providerId: 'anthropic',
      name: 'Anthropic',
      signedIn: true,
      method: 'api_key',
      source: 'corral',
      modelCount: 0,
    }),
  ];
  const tab = () => (
    <ModelConnections
      providers={connected}
      catalog={[]}
      profiles={[]}
      config={config}
      onMakeProfile={vi.fn()}
      onOpenProfile={vi.fn()}
    />
  );
  const row = (name: string) =>
    document.querySelector<HTMLElement>(`article[aria-label="${name}"] [data-connection-row]`);

  it('runs an action on one connection while another connection’s is still going', async () => {
    const anthropic = deferred<ProviderAuthView[]>();
    fixture.services.models = {
      logout: vi.fn((id: string) => (id === 'anthropic' ? anthropic.promise : Promise.resolve([]))),
    };
    await mount(tab);
    await click(row('Anthropic'));
    await settle(50);
    await click(control('Disconnect Anthropic'));
    await click(row('OpenAI'));
    await settle(50);
    await click(control('Disconnect OpenAI'));
    await settle();
    expect(fixture.services.models.logout).toHaveBeenCalledWith('openai');
    expect(document.body.textContent).not.toContain('still pending');
    // OpenAI finishing does not free Anthropic's buttons while its own action runs.
    expect((control('Disconnect Anthropic') as HTMLButtonElement | undefined)?.disabled).toBe(true);
    await act(async () => anthropic.resolve([]));
  });
});
