// @vitest-environment jsdom
import type { ModelsApi } from '@corral/client';
import { act, type ReactNode, useState } from 'react';
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
// The tabs' own screens have their own tests; here they only show what the page hands them.
vi.mock('./ModelConnections.tsx', () => ({
  ModelConnections: ({
    onMakeProfile,
    onOpenProfile,
  }: {
    onMakeProfile: (provider: string, model: string) => void;
    onOpenProfile: (profileId: string) => void;
  }) => (
    <div data-testid="connections">
      <button type="button" onClick={() => onMakeProfile('openai', 'o9')}>
        make o9
      </button>
      <button type="button" onClick={() => onOpenProfile('model-a')}>
        open model-a
      </button>
    </div>
  ),
}));
vi.mock('./ModelProfilesEditor.tsx', () => ({
  ModelProfilesEditor: ({
    request,
    focus,
  }: {
    request?: { provider: string; model: string } | null;
    focus?: { profileId: string } | null;
  }) => {
    const [draft, setDraft] = useState('');
    return (
      <div data-testid="profiles">
        <input aria-label="draft" value={draft} onChange={(e) => setDraft(e.target.value)} />
        <span data-testid="request">{request ? `${request.provider}/${request.model}` : ''}</span>
        <span data-testid="focus">{focus?.profileId ?? ''}</span>
      </div>
    );
  },
}));
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

async function render() {
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
    auth: async () => [],
    catalog: async () => [],
    config: async () => ({
      revision: 'r1',
      usingDefaults: false,
      modelProviders: [],
      modelProfiles: [],
    }),
  } as unknown as ModelsApi;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <ModelSettingsPage />
      </IntlProvider>,
    ),
  );
  return {
    container,
    tabs: () => [...container.querySelectorAll<HTMLElement>('[role="tab"]')],
    panelOf: (selector: string) =>
      container.querySelector(selector)?.closest<HTMLElement>('[role="tabpanel"]'),
    button: (text: string) =>
      [...container.querySelectorAll<HTMLButtonElement>('button')].find(
        (item) => item.textContent === text,
      ),
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

// The kit keeps an invisible bold copy of each label for its width; read the visible one.
const visible = (node: HTMLElement) => {
  const copy = node.cloneNode(true) as HTMLElement;
  for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
  return copy.textContent;
};

it('splits Models into tabs, Connections first, that keep every section and its unsaved input', async () => {
  const page = await render();
  try {
    const { container, tabs, panelOf } = page;
    // The heading names the section alone: no intro line under it.
    expect(container.querySelector('[data-description]')).toBeNull();
    expect(tabs().map(visible)).toEqual([
      'Connections',
      'Profiles',
      'Local AI & judgment',
      'Images',
      'Usage',
    ]);
    expect(container.querySelectorAll('[role="tabpanel"]')).toHaveLength(5);
    expect(panelOf('[data-testid="connections"]')?.hidden).toBe(false);
    expect(panelOf('[data-testid="profiles"]')?.hidden).toBe(true);
    for (const text of [
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

    // An unsaved profile edit survives a tab change.
    await act(async () => tabs()[1]?.click());
    const draft = container.querySelector<HTMLInputElement>('input[aria-label="draft"]');
    await act(async () => {
      if (!draft) return;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        draft,
        'typed-but-unsaved',
      );
      draft.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => tabs()[3]?.click());
    expect(panelOf('#models-images')?.hidden).toBe(false);
    await act(async () => tabs()[1]?.click());
    expect(container.querySelector<HTMLInputElement>('input[aria-label="draft"]')?.value).toBe(
      'typed-but-unsaved',
    );
  } finally {
    await page.unmount();
  }
});

it('a model made into a profile, or a profile opened, takes the person to the Profiles tab', async () => {
  const page = await render();
  try {
    const { container, tabs, panelOf, button } = page;
    await act(async () => button('make o9')?.click());
    expect(tabs()[1]?.getAttribute('aria-selected')).toBe('true');
    expect(panelOf('[data-testid="profiles"]')?.hidden).toBe(false);
    expect(container.querySelector('[data-testid="request"]')?.textContent).toBe('openai/o9');
    await act(async () => tabs()[0]?.click());
    await act(async () => button('open model-a')?.click());
    expect(tabs()[1]?.getAttribute('aria-selected')).toBe('true');
    expect(container.querySelector('[data-testid="focus"]')?.textContent).toBe('model-a');
  } finally {
    await page.unmount();
  }
});
