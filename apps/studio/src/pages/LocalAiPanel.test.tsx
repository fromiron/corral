// @vitest-environment jsdom
import { ApiError, type LocalAiView } from '@corral/client';
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
  release: 'corral-local-ai-2',
  models: { meeting: 'EmbeddingGemma 2 Text 270M' },
  state: 'missing',
  downloadBytes: 198 * MB,
  progress: null,
  error: null,
  device: { requested: 'cpu', actual: null },
  ...overrides,
});

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function render() {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
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
        <LocalAiPanel pollMs={5} />
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

it('installs from settings, shows progress, and stops following once the model is ready', async () => {
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
    models: { localAi, installLocalAi, cancelLocalAiInstall: vi.fn() },
  };
  const container = await render();
  expect(container.textContent).toContain('Meeting analysis: EmbeddingGemma 2 Text 270M');
  expect(container.textContent).not.toContain('Reasoning judge');
  // One bundle, one state.
  expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
  expect(container.textContent).toContain('Not installed');
  expect(container.textContent).toContain('198 MB');

  await act(async () => button(container, 'Install')?.click());
  expect(installLocalAi).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[role="status"]')?.textContent).toContain('Installing');
  expect(button(container, 'Install')).toBeUndefined();
  await vi.waitFor(() => expect(container.textContent).toContain('50% · 99 / 198 MB'));
  await act(async () => finish());

  await vi.waitFor(() =>
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Ready'),
  );
  const polls = localAi.mock.calls.length;
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(localAi.mock.calls.length).toBe(polls);
});

it('cancels back to not installed, and shows a failure with the install button again', async () => {
  const installing = view({ state: 'installing', progress: { received: 0, total: 198 * MB } });
  const localAi = vi.fn().mockResolvedValueOnce(installing).mockResolvedValue(installing);
  const cancelLocalAiInstall = vi.fn().mockResolvedValue(view());
  fixture.services = {
    models: { localAi, installLocalAi: vi.fn(), cancelLocalAiInstall },
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
  expect(failed.textContent).toContain('Downloads about 198 MB for local AI.');
  expect(button(failed, 'Install')).toBeDefined();
});

it('confirms the size freed before removing the meeting model and leaves the judge model alone', async () => {
  const localAi = vi.fn().mockResolvedValue(view({ state: 'idle' }));
  const removeLocalAi = vi.fn().mockResolvedValue(view({ state: 'missing' }));
  fixture.services = {
    models: { localAi, installLocalAi: vi.fn(), cancelLocalAiInstall: vi.fn(), removeLocalAi },
  };
  const container = await render();
  await act(async () => button(container, 'Remove')?.click());
  expect(removeLocalAi).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain(
    'Frees about 198 MB on this computer. The judge model stays.',
  );
  const confirm = [...document.querySelectorAll('button')].filter(
    (node) => node.textContent === 'Remove',
  );
  await act(async () => confirm.at(-1)?.click());
  expect(removeLocalAi).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[role="status"]')?.textContent).toContain('Not installed');
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

it('has no external judge choice', async () => {
  fixture.services = {
    models: {
      localAi: vi.fn().mockResolvedValue(view({ state: 'idle' })),
      installLocalAi: vi.fn(),
      cancelLocalAiInstall: vi.fn(),
    },
  };
  const container = await render();
  expect(container.querySelector('[role="combobox"]')?.getAttribute('aria-label')).toBe('Device');
  expect(container.textContent).not.toContain('local judge');
  expect(container.textContent).toContain('Not running');
});

it('saves the meeting device and shows the device the helper is using', async () => {
  const setLocalAiDevice = vi
    .fn()
    .mockResolvedValue(view({ state: 'ready', device: { requested: 'gpu', actual: 'gpu' } }));
  fixture.services = {
    models: {
      localAi: vi
        .fn()
        .mockResolvedValue(view({ state: 'ready', device: { requested: 'cpu', actual: 'cpu' } })),
      installLocalAi: vi.fn(),
      cancelLocalAiInstall: vi.fn(),
      setLocalAiDevice,
    },
  };
  const container = await render();
  expect(container.textContent).toContain('Running on CPU');
  await act(async () =>
    container.querySelector<HTMLElement>('button[role="combobox"][aria-label="Device"]')?.click(),
  );
  const gpu = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((node) =>
    node.textContent?.startsWith('GPU'),
  );
  expect(gpu?.textContent).toContain('Not verified on this computer');
  await act(async () => gpu?.click());
  expect(setLocalAiDevice).toHaveBeenCalledWith('gpu');
  expect(container.textContent).toContain('Running on GPU');
});

it('says a device change was refused while a computation runs and keeps the saved device', async () => {
  const setLocalAiDevice = vi
    .fn()
    .mockRejectedValue(new ApiError(409, 'RESOURCE_CAPACITY', 'a computation is in progress'));
  fixture.services = {
    models: {
      localAi: vi
        .fn()
        .mockResolvedValue(view({ state: 'ready', device: { requested: 'cpu', actual: 'cpu' } })),
      installLocalAi: vi.fn(),
      cancelLocalAiInstall: vi.fn(),
      setLocalAiDevice,
    },
  };
  const container = await render();
  const select = () =>
    container.querySelector<HTMLElement>('button[role="combobox"][aria-label="Device"]');
  await act(async () => select()?.click());
  const gpu = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((node) =>
    node.textContent?.startsWith('GPU'),
  );
  await act(async () => gpu?.click());
  expect(setLocalAiDevice).toHaveBeenCalledWith('gpu');
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    'Cannot change the device while a computation is running.',
  );
  expect(select()?.textContent).toContain('CPU');
  expect(container.textContent).toContain('Running on CPU');
});
