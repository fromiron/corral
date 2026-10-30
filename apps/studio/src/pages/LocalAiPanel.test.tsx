// @vitest-environment jsdom
import type { DecisionApiView, LocalAiView } from '@corral/client';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { LocalAiPanel } from './LocalAiPanel.tsx';

const fixture = vi.hoisted(() => ({ services: {} }));
vi.mock('../services.tsx', () => ({ useServices: () => fixture.services }));

const MB = 1_000_000;
const view = (overrides: Partial<LocalAiView> = {}): LocalAiView => ({
  release: 'corral-local-ai-1',
  modelName: 'EmbeddingGemma 2 Text 270M',
  state: 'missing',
  downloadBytes: 198 * MB,
  progress: null,
  error: null,
  external: { provider: null, model: null, revision: 'r1' },
  ...overrides,
});

const noApis = () => Promise.resolve([]);

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function render(onInstalled = () => {}) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  // The kit's select checks for a touch pointer.
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages}>
        <LocalAiPanel onInstalled={onInstalled} pollMs={5} />
      </IntlProvider>,
    ),
  );
  cleanups.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return container;
}

const button = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent === name);

it('installs from settings, shows progress, and tells the page when the model is ready', async () => {
  let finish: () => void = () => {};
  const finished = new Promise<LocalAiView>((resolve) => {
    finish = () => resolve(view({ state: 'idle' }));
  });
  const localAi = vi
    .fn()
    .mockResolvedValueOnce(view())
    .mockResolvedValueOnce(
      view({ state: 'installing', progress: { received: 99 * MB, total: 198 * MB } }),
    )
    .mockReturnValue(finished);
  const installLocalAi = vi
    .fn()
    .mockResolvedValue(view({ state: 'installing', progress: { received: 0, total: 198 * MB } }));
  fixture.services = {
    models: { localAi, installLocalAi, cancelLocalAiInstall: vi.fn(), decisionApis: noApis },
  };
  const onInstalled = vi.fn();
  const container = await render(onInstalled);
  expect(container.textContent).toContain('EmbeddingGemma 2 Text 270M');
  expect(container.textContent).toContain('Not installed');
  expect(container.textContent).toContain('198 MB');

  await act(async () => button(container, 'Install')?.click());
  expect(installLocalAi).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[role="status"]')?.textContent).toContain('Installing');
  expect(button(container, 'Install')).toBeUndefined();
  await vi.waitFor(() => expect(container.textContent).toContain('50% · 99 / 198 MB'));
  expect(onInstalled).not.toHaveBeenCalled();
  await act(async () => finish());

  await vi.waitFor(() =>
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Ready'),
  );
  expect(onInstalled).toHaveBeenCalledTimes(1);
  const polls = localAi.mock.calls.length;
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(localAi.mock.calls.length).toBe(polls);
});

it('cancels back to not installed, and shows a failure with the install button again', async () => {
  const installing = view({ state: 'installing', progress: { received: 0, total: 198 * MB } });
  const localAi = vi.fn().mockResolvedValueOnce(installing).mockResolvedValue(installing);
  const cancelLocalAiInstall = vi.fn().mockResolvedValue(view());
  fixture.services = {
    models: { localAi, installLocalAi: vi.fn(), cancelLocalAiInstall, decisionApis: noApis },
  };
  const container = await render();
  await act(async () => button(container, 'Cancel install')?.click());
  expect(cancelLocalAiInstall).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain('Not installed');
  expect(button(container, 'Install')).toBeDefined();

  localAi
    .mockReset()
    .mockResolvedValue(view({ error: 'model.litertlm: download failed: HTTP 503' }));
  const failed = await render();
  expect(failed.querySelector('[role="alert"]')?.textContent).toContain('HTTP 503');
  expect(button(failed, 'Install')).toBeDefined();
});

it('offers no install where local AI cannot run, and says so when status cannot load', async () => {
  fixture.services = {
    models: {
      localAi: vi.fn().mockResolvedValue(view({ state: 'unsupported', downloadBytes: null })),
      installLocalAi: vi.fn(),
      cancelLocalAiInstall: vi.fn(),
    },
  };
  const container = await render();
  expect(container.textContent).toContain('Not available in this environment');
  expect(container.querySelectorAll('button')).toHaveLength(0);

  fixture.services = {
    models: { localAi: vi.fn().mockRejectedValue(new Error('offline')) },
  };
  const broken = await render();
  expect(broken.querySelector('[role="alert"]')?.textContent).toContain(
    'Could not load local AI status',
  );
});

const apis = (openaiKey: boolean): DecisionApiView[] => [
  { id: 'jev', provider: 'TypeSafe', model: 'jev-latest', keyConfigured: false },
  { id: 'openai-decisions', provider: 'OpenAI', model: 'gpt-6-luna', keyConfigured: openaiKey },
];
const options = () =>
  [...document.querySelectorAll<HTMLElement>('[role="option"]')].map((node) => node.textContent);

it('offers only decision APIs with a key, and saves the choice with the config revision', async () => {
  const chosen = view({
    external: { provider: 'openai-decisions', model: 'gpt-6-luna', revision: 'r2' },
  });
  const setExternalJudge = vi.fn().mockResolvedValue(chosen);
  fixture.services = {
    models: {
      localAi: vi.fn().mockResolvedValue(view()),
      decisionApis: vi.fn().mockResolvedValue(apis(true)),
      installLocalAi: vi.fn(),
      cancelLocalAiInstall: vi.fn(),
      setExternalJudge,
    },
  };
  const container = await render();
  expect(container.textContent).toContain('It never gets files, keys, or run IDs');
  const mode = container.querySelector<HTMLButtonElement>(
    'button[role="combobox"][aria-label="When the local judge is unsure"]',
  );
  expect(mode?.textContent).toContain('Use medium');
  await act(async () => mode?.click());
  expect(options()).toEqual(['Use medium', 'Ask OpenAI Decisions']);
  const openai = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (node) => node.textContent === 'Ask OpenAI Decisions',
  );
  await act(async () => openai?.click());
  expect(setExternalJudge).toHaveBeenCalledWith('openai-decisions', 'r1');
  expect(mode?.textContent).toContain('Ask OpenAI Decisions');

  await act(async () => mode?.click());
  const off = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (node) => node.textContent === 'Use medium',
  );
  setExternalJudge.mockResolvedValue(
    view({ external: { provider: null, model: null, revision: 'r3' } }),
  );
  await act(async () => off?.click());
  expect(setExternalJudge).toHaveBeenLastCalledWith(null, 'r2');
});

it('says where to add a key when no decision API has one, and keeps a chosen one without a key', async () => {
  fixture.services = {
    models: {
      localAi: vi.fn().mockResolvedValue(view()),
      decisionApis: vi.fn().mockResolvedValue(apis(false)),
      installLocalAi: vi.fn(),
      cancelLocalAiInstall: vi.fn(),
      setExternalJudge: vi.fn(),
    },
  };
  const container = await render();
  expect(container.textContent).toContain('Add a key under Decision APIs');

  fixture.services = {
    models: {
      localAi: vi
        .fn()
        .mockResolvedValue(
          view({ external: { provider: 'jev', model: 'jev-latest', revision: 'r1' } }),
        ),
      decisionApis: vi.fn().mockResolvedValue(apis(false)),
      installLocalAi: vi.fn(),
      cancelLocalAiInstall: vi.fn(),
      setExternalJudge: vi.fn(),
    },
  };
  const chosen = await render();
  expect(
    chosen.querySelector('button[role="combobox"][aria-label="When the local judge is unsure"]')
      ?.textContent,
  ).toContain('Ask TypeSafe Jev');
  expect(chosen.textContent).toContain('TypeSafe Jev has no key');
});
