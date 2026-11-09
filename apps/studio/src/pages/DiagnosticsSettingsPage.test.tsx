// @vitest-environment jsdom
import type { ModelsApi } from '@corral/client';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import type { WorkspacesClient } from '../demo/workspaces-client.ts';
import { SettingsNavigationContext } from '../workbench/navigation.ts';
import { DiagnosticsSettingsPage } from './DiagnosticsSettingsPage.tsx';

const fixture = vi.hoisted(() => ({ services: {} as Record<string, unknown> }));
vi.mock('../services.tsx', () => ({ useServices: () => fixture.services }));
vi.mock('./SettingsPage.tsx', () => ({
  SettingsLayout: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...props }: { to: string; children?: ReactNode }) => (
    <a {...props} href={to}>
      {children}
    </a>
  ),
}));

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
});

async function mount(projectId?: string) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const show = (id?: string) =>
    act(async () =>
      root.render(
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <SettingsNavigationContext.Provider
            value={{
              projects: [],
              ...(id ? { projectId: id } : {}),
              returnTo: '/projects',
              search: {},
              link: (section) => ({ to: `/settings/${section}`, search: {}, resetScroll: false }),
            }}
          >
            <DiagnosticsSettingsPage />
          </SettingsNavigationContext.Provider>
        </IntlProvider>,
      ),
    );
  await show(projectId);
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  return { container, show };
}

async function render(projectId?: string) {
  return (await mount(projectId)).container;
}

const row = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`[data-diagnostic="${id}"]`);

it('says which parts need the local server in the browser demo instead of leaving them blank', async () => {
  fixture.services = {
    mode: 'browser',
    live: false,
    models: null,
    harnesses: null,
    workspaces: {
      binding: async () => ({
        bindingId: 'b',
        projectId: 'p',
        path: 'demo://example-repo',
        isGit: true,
        trusted: false,
        verifyCommands: [],
        status: null,
        missing: false,
      }),
    } as unknown as WorkspacesClient,
  };
  const container = await render('p');
  for (const id of ['models', 'localAi'])
    expect(row(container, id)?.textContent).toContain('Available with the local server');
  expect(row(container, 'server')?.textContent).toContain('Browser demo');
  expect(row(container, 'pathEngine')?.textContent).toContain('Built-in');
  expect(row(container, 'folder')?.textContent).toContain('Linked');
});

it('copies a summary without the folder path, a key or a login link', async () => {
  const writeText = vi.fn(async (_text: string) => {});
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
  fixture.services = {
    mode: 'server',
    serverVersion: '1.4.0',
    live: true,
    harnesses: null,
    models: {
      profiles: async () => [
        {
          profileId: 'default',
          provider: 'openai',
          providerName: 'OpenAI',
          modelId: 'gpt-5',
          modelName: 'GPT-5',
          available: true,
          reasoning: true,
          contextWindow: null,
          maxOutputTokens: null,
          method: 'api_key',
          keyConfigured: true,
          subscriptionSupported: null,
        },
      ],
      auth: async () => [
        {
          providerId: 'openai',
          name: 'OpenAI',
          signedIn: true,
          method: 'api_key',
          methods: { oauth: true, apiKey: true },
          endpoint: null,
          endpointChanged: false,
          connectionTest: null,
          subscription: false,
          expiresAt: null,
          login: { state: 'waiting', authUrl: 'https://auth.example/?code=secret-code' },
          source: 'corral',
          permissionsOk: true,
        },
      ],
      catalog: async () => [],
      config: async () => null,
      localAi: async () => ({
        release: 'r',
        models: { meeting: 'm' },
        state: 'error',
        downloadBytes: null,
        progress: null,
        error: 'cannot open /home/bell/.corral/local-ai/model.bin',
      }),
    } as unknown as ModelsApi,
    workspaces: {
      binding: async () => ({
        bindingId: 'b',
        projectId: 'p',
        path: '/home/bell/private/project',
        isGit: true,
        trusted: true,
        verifyCommands: [],
        status: null,
        missing: false,
      }),
    } as unknown as WorkspacesClient,
  };
  const container = await render('p');
  expect(row(container, 'models')?.textContent).toContain('Connected');
  expect(row(container, 'server')?.textContent).toContain('1.4.0');
  expect(row(container, 'localAi')?.textContent).toContain('Error');
  const copy = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Copy diagnostics',
  );
  expect(copy).toBeDefined();
  await act(async () => copy?.click());
  expect(writeText).toHaveBeenCalledOnce();
  const text = writeText.mock.calls[0]?.[0] ?? '';
  expect(text).toContain('model connection: connected');
  expect(text).toContain('<local path>');
  for (const secret of ['/home/', 'secret-code', 'auth.example', 'model.bin'])
    expect(text).not.toContain(secret);
  expect(container.textContent).toContain('Diagnostics copied');
});

const missingFolderA = {
  bindingId: 'binding-a',
  projectId: 'a',
  path: '/srv/project-a',
  isGit: true,
  trusted: true,
  verifyCommands: [],
  status: null,
  missing: true,
};

/** Each project's binding answers only when the test resolves it. */
function heldBindings() {
  const pending = new Map<string, (binding: unknown) => void>();
  fixture.services = {
    mode: 'server',
    live: false,
    models: null,
    harnesses: null,
    workspaces: {
      binding: (projectId: string) =>
        new Promise((resolve) => {
          pending.set(projectId, resolve);
        }),
    } as unknown as WorkspacesClient,
  };
  return (projectId: string, binding: unknown) =>
    act(async () => pending.get(projectId)?.(binding));
}

it("shows the new settings project's folder when the previous project's answer arrives last", async () => {
  const answer = heldBindings();
  const { container, show } = await mount('a');
  const folder = () => row(container, 'folder')?.textContent ?? '';
  await show('b');
  expect(folder()).toContain('Checking');
  await answer('b', null);
  expect(folder()).toContain('Not linked');
  await answer('a', missingFolderA);
  expect(folder()).toContain('Not linked');
  expect(folder()).not.toContain('project-a');
  expect(folder()).not.toContain('Folder missing');
});

it("does not keep showing the previous project's folder while the new one is checked", async () => {
  const answer = heldBindings();
  const { container, show } = await mount('a');
  const folder = () => row(container, 'folder')?.textContent ?? '';
  await answer('a', missingFolderA);
  expect(folder()).toContain('project-a');
  await show('b');
  expect(folder()).toContain('Checking');
  expect(folder()).not.toContain('project-a');
});
