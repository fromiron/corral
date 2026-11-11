// @vitest-environment jsdom
import type { ModelsApi } from '@corral/client';
import { act, type ReactNode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { ModelSettingsPage } from './ModelSettingsPage.tsx';

const fixture = vi.hoisted(() => ({
  models: {} as ModelsApi,
  applied: [] as number[],
  // The providers the Connections tab was first drawn with.
  firstProviders: null as number | null,
}));
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
vi.mock('./ModelConnections.tsx', async () => {
  const { useModelSettingsRefresh } = await import('../workbench/modelSettings.tsx');
  return {
    ModelConnections: ({
      providers,
      onMakeProfile,
      onOpenProfile,
    }: {
      providers: unknown[];
      onMakeProfile: (provider: string, model: string) => void;
      onOpenProfile: (profileId: string) => void;
    }) => {
      const refresh = useModelSettingsRefresh();
      fixture.firstProviders ??= providers.length;
      return (
        <div data-testid="connections">
          <button type="button" onClick={() => onMakeProfile('openai', 'o9')}>
            make o9
          </button>
          <button type="button" onClick={() => onOpenProfile('model-a')}>
            open model-a
          </button>
          <button type="button" onClick={() => void refresh().catch(() => {})}>
            read the lists again
          </button>
        </div>
      );
    },
  };
});
vi.mock('./ModelProfilesEditor.tsx', () => ({
  // Like the editor, it makes the profile a request asks for once per mount and says so.
  ModelProfilesEditor: ({
    request,
    focus,
    onRequestHandled,
  }: {
    request?: { provider: string; model: string; nonce: number } | null;
    focus?: { profileId: string } | null;
    onRequestHandled?: (nonce: number) => void;
  }) => {
    const [draft, setDraft] = useState('');
    const [made, setMade] = useState<string[]>([]);
    const handled = useRef<number | null>(null);
    useEffect(() => {
      if (!request || handled.current === request.nonce) return;
      handled.current = request.nonce;
      fixture.applied.push(request.nonce);
      setMade((list) => [...list, `${request.provider}/${request.model}`]);
      onRequestHandled?.(request.nonce);
    });
    return (
      <div data-testid="profiles">
        <input aria-label="draft" value={draft} onChange={(e) => setDraft(e.target.value)} />
        <span data-testid="request">{made.join(',')}</span>
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
  fixture.applied = [];
  fixture.firstProviders = null;
  fixture.models = {
    profiles: async () => [],
    auth: async () => [{ providerId: 'openai', name: 'OpenAI' }],
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

it('keeps the Profiles tab and its draft when one read of the config fails, and makes a request once', async () => {
  const page = await render();
  try {
    const { container, tabs, button } = page;
    await act(async () => button('make o9')?.click());
    expect(fixture.applied).toHaveLength(1);
    const draft = () => container.querySelector<HTMLInputElement>('input[aria-label="draft"]');
    await act(async () => {
      const input = draft();
      if (!input) return;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        'typed-but-unsaved',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const config = fixture.models.config;
    fixture.models.config = async () => {
      throw new Error('offline');
    };
    await act(async () => tabs()[0]?.click());
    await act(async () => button('read the lists again')?.click());
    expect(draft()?.value).toBe('typed-but-unsaved');
    fixture.models.config = config;
    await act(async () => button('read the lists again')?.click());
    expect(draft()?.value).toBe('typed-but-unsaved');
    // The request was made into a profile once, not again on a later read.
    expect(fixture.applied).toHaveLength(1);
  } finally {
    await page.unmount();
  }
});

it('draws the Connections tab once the lists are read, so its first rows are not news', async () => {
  const page = await render();
  try {
    expect(fixture.firstProviders).toBe(1);
  } finally {
    await page.unmount();
  }
});
