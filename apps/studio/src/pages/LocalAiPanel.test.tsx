// @vitest-environment jsdom
import type { LocalAiView } from '@corral/client';
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
  ...overrides,
});

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function render(onInstalled = () => {}) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
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
  fixture.services = { models: { localAi, installLocalAi, cancelLocalAiInstall: vi.fn() } };
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
  fixture.services = { models: { localAi, installLocalAi: vi.fn(), cancelLocalAiInstall } };
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
