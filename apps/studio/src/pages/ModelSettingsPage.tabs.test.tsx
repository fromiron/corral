// @vitest-environment jsdom
import type { ModelsApi } from '@corral/client';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { ModelSettingsPage } from './ModelSettingsPage.tsx';

const fixture = vi.hoisted(() => ({ models: {} as ModelsApi }));
vi.mock('../services.tsx', () => ({
  useServices: () => ({ mode: 'server', live: true, models: fixture.models }),
}));
vi.mock('../workbench/SettingsLifecycle.tsx', () => ({
  useSettingsForm: () => async () => true,
  useSettingsTask: () => async (task: () => Promise<unknown>) => task(),
}));
vi.mock('./SettingsPage.tsx', () => ({
  // The frame's description line, as SettingsLayout draws it under the section title.
  SettingsLayout: ({
    children,
    description,
    descriptionId,
  }: {
    children: ReactNode;
    description?: ReactNode;
    descriptionId?: string;
  }) => (
    <>
      {description ? (
        <p data-description="" data-testid={descriptionId}>
          {description}
        </p>
      ) : null}
      {children}
    </>
  ),
}));
vi.mock('./ModelImportPanel.tsx', () => ({ ModelImportPanel: () => <p>import panel</p> }));
vi.mock('./ImageProfileSettings.tsx', () => ({ ImageProfileSettings: () => <p>image panel</p> }));
vi.mock('./LocalAiPanel.tsx', () => ({ LocalAiPanel: () => <p>local ai panel</p> }));
vi.mock('./EffortRoutingSettings.tsx', () => ({
  EffortRoutingSettings: () => <a href="#models-decision-apis">judgment panel</a>,
}));
vi.mock('./DecisionApiSettings.tsx', () => ({
  DecisionApiSettings: () => <p>decision panel</p>,
}));
vi.mock('./ModelUsagePanel.tsx', () => ({ ModelUsagePanel: () => <p>usage panel</p> }));

afterEach(() => vi.unstubAllGlobals());

it('splits Models into tabs that keep every section and its unsaved input', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  fixture.models = {
    profiles: async () => [],
    auth: async () => [
      {
        providerId: 'openai',
        name: 'OpenAI',
        signedIn: false,
        method: null,
        methods: { oauth: false, apiKey: true },
        endpoint: null,
        endpointChanged: false,
        connectionTest: null,
        subscription: false,
        expiresAt: null,
        login: null,
        source: null,
        permissionsOk: true,
      },
    ],
    catalog: async () => [],
    config: async () => null,
  } as unknown as ModelsApi;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <ModelSettingsPage />
        </IntlProvider>,
      ),
    );
    const tabs = [...container.querySelectorAll<HTMLElement>('[role="tab"]')];
    // Where sign-in is kept is said once, on Sign-in, not under every tab or again per key.
    expect(container.querySelector('[data-description]')?.textContent).toBe(messages.Models.intro);
    expect(container.textContent?.split(messages.Models.intro)).toHaveLength(2);
    expect(container.textContent).not.toContain(
      'Kept on this computer, outside the workspace, and used only',
    );
    // The kit keeps an invisible bold copy of each label for its width; read the visible one.
    const visible = (node: HTMLElement) => {
      const copy = node.cloneNode(true) as HTMLElement;
      for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
      return copy.textContent;
    };
    expect(tabs.map(visible)).toEqual([
      'Sign-in',
      'Profiles',
      'Local AI & judgment',
      'Images',
      'Usage',
    ]);
    const panels = [...container.querySelectorAll<HTMLElement>('[role="tabpanel"]')];
    expect(panels).toHaveLength(5);
    const panelOf = (selector: string) =>
      container.querySelector(selector)?.closest<HTMLElement>('[role="tabpanel"]');
    // Sign-in opens first, and every section still exists in some tab.
    expect(panelOf('[data-testid="provider-openai"]')?.hidden).toBe(false);
    for (const text of [
      'import panel',
      'image panel',
      'local ai panel',
      'judgment panel',
      'decision panel',
      'usage panel',
    ])
      expect(container.textContent).toContain(text);
    // The judgment's link to the decision APIs stays within one tab.
    expect(panelOf('#models-effort-routing')).toBe(panelOf('#models-decision-apis'));
    expect(panelOf('#models-local-ai')).toBe(panelOf('#models-decision-apis'));
    expect(panelOf('#models-import')).toBe(panelOf('#models-profiles'));

    const key = container.querySelector<HTMLInputElement>('[data-testid="provider-openai"] input');
    expect(key).not.toBeNull();
    await act(async () => {
      if (!key) return;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(key, 'typed-but-unsaved');
      key.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => tabs[3]?.click());
    expect(panelOf('#models-images')?.hidden).toBe(false);
    expect(container.querySelector('[data-description]')).toBeNull();
    expect(panelOf('[data-testid="provider-openai"]')?.hidden).toBe(true);
    await act(async () => tabs[0]?.click());
    expect(
      container.querySelector<HTMLInputElement>('[data-testid="provider-openai"] input')?.value,
    ).toBe('typed-but-unsaved');
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
