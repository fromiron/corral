// @vitest-environment jsdom
import { ApiError, type EffortRoutingView } from '@corral/client';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { EffortRoutingSettings } from './EffortRoutingSettings.tsx';

const fixture = vi.hoisted(() => ({ services: {} }));
vi.mock('../services.tsx', () => ({ useServices: () => fixture.services }));
vi.mock('../workbench/SettingsLifecycle.tsx', () => ({
  useSettingsForm: () => {},
  useSettingsTask: () => async (task: () => Promise<unknown>) => task(),
}));

const MB = 1_000_000;
const LOCAL = {
  mode: 'manual',
  engine: { kind: 'local', device: { kind: 'cpu', threads: 4 }, callerTimeoutMs: 5000 },
  fallback: { kind: 'provider-default' },
} as const;
const view = (overrides: Partial<EffortRoutingView> = {}): EffortRoutingView => ({
  settings: { mode: 'off' },
  revision: 'rev_1',
  local: {
    model: 'd1-2B Q4_K_M',
    host: 'server-host',
    supported: true,
    reason: null,
    install: 'absent',
    runtime: 'stopped',
    downloadBytes: 1123 * MB,
    progress: null,
    error: null,
    device: { requested: 'cpu', active: null },
    threads: null,
    defaultThreads: 4,
  },
  apis: [
    { id: 'jev', keyConfigured: false, noticeRevision: 'jev:notice-1', verified: false },
    {
      id: 'openai-decisions',
      keyConfigured: true,
      noticeRevision: 'openai-decisions:notice-1',
      verified: false,
    },
  ],
  ...overrides,
});
const local = (overrides: Partial<EffortRoutingView['local']>) => ({
  ...view().local,
  ...overrides,
});

const models = () => ({
  effortRouting: vi.fn(),
  saveEffortRouting: vi.fn(),
  installLocalRouting: vi.fn(),
  cancelLocalRoutingInstall: vi.fn(),
  startLocalRouting: vi.fn(),
  removeLocalRouting: vi.fn(),
});

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function render(api: ReturnType<typeof models>) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  fixture.services = { models: api };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <EffortRoutingSettings pollMs={5} />
      </IntlProvider>,
    ),
  );
  cleanups.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return container;
}

const radio = (container: HTMLElement, label: string) =>
  container.querySelector<HTMLElement>(`[data-fluid-hover-index][aria-label="${label}"]`);
const button = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent === name);
const field = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll('label')]
    .find((l) => l.textContent?.startsWith(label))
    ?.querySelector('input') ?? null;
const type = async (input: HTMLInputElement | null, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(input, value);
    input?.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const choose = async (container: HTMLElement, select: string, option: string) => {
  const trigger = container.querySelector<HTMLElement>(
    `button[role="combobox"][aria-label="${select}"]`,
  );
  await act(async () => trigger?.click());
  const item = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((node) =>
    node.textContent?.startsWith(option),
  );
  await act(async () => item?.click());
};

it('starts Off with nothing to set up, and saving Manual with Local downloads nothing', async () => {
  const api = models();
  api.effortRouting.mockResolvedValue(view());
  api.saveEffortRouting.mockImplementation(async (settings) => view({ settings }));
  const container = await render(api);
  expect(radio(container, 'Off')?.getAttribute('aria-checked')).toBe('true');
  expect(radio(container, 'Local judge model')).toBeNull();
  expect(button(container, 'Save')?.disabled).toBe(true);

  await act(async () => radio(container, 'Manual')?.click());
  expect(radio(container, 'Local judge model')?.getAttribute('aria-checked')).toBe('true');
  expect(container.textContent).toContain('Runs on server-host');
  expect(container.querySelector('[role="status"]')?.textContent).toBe(
    'Not installed · about 1.1 GB',
  );
  expect(container.textContent).toContain('Downloads about 1.1 GB.');
  await act(async () => button(container, 'Save')?.click());
  expect(api.saveEffortRouting).toHaveBeenCalledWith(LOCAL, 'rev_1');
  expect(api.installLocalRouting).not.toHaveBeenCalled();
  expect(container.textContent).toContain('Saved');

  await act(async () => radio(container, 'Off')?.click());
  await act(async () => button(container, 'Save')?.click());
  expect(api.saveEffortRouting).toHaveBeenLastCalledWith({ mode: 'off' }, 'rev_1');
});

it('installs only from its button, follows the download, and can cancel it', async () => {
  const api = models();
  const downloading = view({
    settings: LOCAL,
    local: local({ install: 'downloading', progress: { received: 0, total: 1123 * MB } }),
  });
  api.effortRouting.mockResolvedValueOnce(view({ settings: LOCAL })).mockResolvedValue(
    view({
      settings: LOCAL,
      local: local({ install: 'downloading', progress: { received: 562 * MB, total: 1123 * MB } }),
    }),
  );
  api.installLocalRouting.mockResolvedValue(downloading);
  api.cancelLocalRoutingInstall.mockResolvedValue(view({ settings: LOCAL }));
  const container = await render(api);
  expect(api.installLocalRouting).not.toHaveBeenCalled();
  await act(async () => button(container, 'Install')?.click());
  expect(api.installLocalRouting).toHaveBeenCalledTimes(1);
  await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
  expect(container.querySelector('[role="status"]')?.textContent).toBe(
    'Downloading 50% · 562 / 1,123 MB',
  );
  await act(async () => button(container, 'Cancel install')?.click());
  expect(api.cancelLocalRoutingInstall).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[role="status"]')?.textContent).toBe(
    'Not installed · about 1.1 GB',
  );
  expect(container.textContent).toContain('Downloads about 1.1 GB.');
});

it('says an install downloads about 1.1 GB again after it fails', async () => {
  const api = models();
  api.effortRouting.mockResolvedValue(
    view({
      settings: LOCAL,
      local: local({ install: 'install-error', error: 'the download did not match' }),
    }),
  );
  const container = await render(api);
  expect(container.querySelector('[role="status"]')?.textContent).toBe('Install failed');
  expect(container.textContent).toContain('Downloads about 1.1 GB.');
  expect(button(container, 'Install')).toBeDefined();
});

it('says Prepare now starts the installed model and downloads nothing', async () => {
  const api = models();
  api.effortRouting.mockResolvedValue(
    view({
      settings: LOCAL,
      local: local({ install: 'installed', runtime: 'stopped' }),
    }),
  );
  const container = await render(api);
  expect(button(container, 'Prepare now')).toBeDefined();
  expect(container.textContent).toContain(
    'Starts the model that is already installed. Nothing is downloaded.',
  );
});

it('confirms the size freed before removing the judge model', async () => {
  const api = models();
  const absent = view({
    settings: LOCAL,
    local: local({ install: 'absent' }),
  });
  api.effortRouting.mockResolvedValue(
    view({
      settings: LOCAL,
      local: local({ install: 'installed', runtime: 'stopped' }),
    }),
  );
  api.removeLocalRouting.mockResolvedValue(absent);
  const container = await render(api);
  await act(async () => button(container, 'Remove')?.click());
  expect(api.removeLocalRouting).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain(
    'Frees about 1.1 GB on this computer. The meeting analysis model stays.',
  );
  const confirm = [...document.querySelectorAll('button')].filter(
    (node) => node.textContent === 'Remove',
  );
  await act(async () => confirm.at(-1)?.click());
  expect(api.removeLocalRouting).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[role="status"]')?.textContent).toBe(
    'Not installed · about 1.1 GB',
  );
});

it('says a judgment must finish before the judge model can be removed', async () => {
  const api = models();
  api.effortRouting.mockResolvedValue(
    view({
      settings: LOCAL,
      local: local({ install: 'installed', runtime: 'inferring' }),
    }),
  );
  api.removeLocalRouting.mockRejectedValue(
    new ApiError(409, 'RESOURCE_CAPACITY', 'a judgment is running'),
  );
  const container = await render(api);
  await act(async () => button(container, 'Remove')?.click());
  const confirm = [...document.querySelectorAll('button')].filter(
    (node) => node.textContent === 'Remove',
  );
  await act(async () => confirm.at(-1)?.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    'Cannot remove it while a judgment is running.',
  );
});

it('lets the person install Vulkan or CUDA and says they are not verified here', async () => {
  const api = models();
  api.effortRouting.mockResolvedValue(
    view({
      settings: LOCAL,
      local: local({
        devices: [
          { kind: 'cpu', installed: true, downloadBytes: 1123 * MB, requirement: null },
          {
            kind: 'vulkan',
            installed: false,
            downloadBytes: 36 * MB,
            requirement: 'libvulkan.so.1',
          },
          {
            kind: 'cuda',
            installed: false,
            downloadBytes: 188 * MB,
            requirement: 'libcudart.so.12; NVIDIA Linux driver >= 570.26',
          },
        ],
      }),
    }),
  );
  api.installLocalRouting.mockResolvedValue(view({ settings: LOCAL }));
  const container = await render(api);
  await act(async () =>
    container.querySelector<HTMLElement>('button[role="combobox"][aria-label="Device"]')?.click(),
  );
  const option = (name: string) =>
    [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((node) =>
      node.textContent?.startsWith(name),
    );
  expect(option('Vulkan')?.getAttribute('aria-disabled')).not.toBe('true');
  expect(option('Vulkan')?.textContent).toContain('Not verified on this computer');
  expect(option('CUDA')?.textContent).toContain('Not verified on this computer');
  expect(option('Vulkan')?.textContent).not.toContain('verified GPU');
  await act(async () => option('Vulkan')?.click());
  expect(container.textContent).toContain('Downloads about 36 MB.');
  expect(container.textContent).toContain(
    'Not verified on this computer. Needs libvulkan.so.1. Corral does not download these.',
  );
  const pick = async (name: string) => {
    await act(async () =>
      container.querySelector<HTMLElement>('button[role="combobox"][aria-label="Device"]')?.click(),
    );
    await act(async () => option(name)?.click());
  };
  await pick('CUDA');
  expect(container.textContent).toContain(
    'Needs libcudart.so.12; NVIDIA Linux driver >= 570.26. Corral does not download these.',
  );
  await pick('Vulkan');
  await act(async () => button(container, 'Install')?.click());
  expect(api.installLocalRouting).toHaveBeenCalledWith('vulkan');
});

it('prepares the saved Local engine again after an error', async () => {
  const api = models();
  const starting = view({
    settings: LOCAL,
    local: local({ install: 'installed', runtime: 'starting' }),
  });
  api.effortRouting
    .mockResolvedValueOnce(
      view({
        settings: LOCAL,
        local: local({ install: 'installed', runtime: 'error', error: 'the runtime stopped' }),
      }),
    )
    .mockResolvedValue(starting);
  api.startLocalRouting.mockResolvedValue(starting);
  const container = await render(api);
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('the runtime stopped');
  await act(async () => button(container, 'Prepare again')?.click());
  expect(api.startLocalRouting).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[role="status"]')?.textContent).toBe('Installed · getting ready');
});

it('a computer without the Local engine cannot save it', async () => {
  const api = models();
  api.effortRouting.mockResolvedValue(
    view({
      local: local({
        supported: false,
        reason: 'not here',
        downloadBytes: null,
        installedBytes: null,
        devices: [],
      }),
    }),
  );
  const container = await render(api);
  await act(async () => radio(container, 'Manual')?.click());
  expect(container.querySelector('[role="status"]')?.textContent).toBe(
    'Not available on this computer',
  );
  expect(button(container, 'Install')).toBeUndefined();
  expect(button(container, 'Save')?.disabled).toBe(true);
});

it('a decision API is saved only with its key and agreement to the current notice', async () => {
  const api = models();
  api.effortRouting.mockResolvedValue(view());
  api.saveEffortRouting.mockImplementation(async (settings) => view({ settings }));
  const container = await render(api);
  await act(async () => radio(container, 'Manual')?.click());
  await act(async () => radio(container, 'Decision API')?.click());
  // The one API with a key is chosen; the other cannot be.
  expect(
    container.querySelector('button[role="combobox"][aria-label="Decision API"]')?.textContent,
  ).toContain('OpenAI Decisions');
  expect(container.textContent).toContain('Each judged request sends up to 2 KB');
  expect(button(container, 'Save')?.disabled).toBe(true);
  const consent = container.querySelector<HTMLElement>('[aria-label="Send to this decision API"]');
  await act(async () => consent?.click());
  await act(async () => button(container, 'Save')?.click());
  expect(api.saveEffortRouting).toHaveBeenCalledWith(
    {
      mode: 'manual',
      engine: {
        kind: 'api',
        id: 'openai-decisions',
        callerTimeoutMs: 3000,
        consentRevision: 'openai-decisions:notice-1',
      },
      fallback: { kind: 'provider-default' },
    },
    'rev_1',
  );
  // Withdrawing the agreement leaves nothing that can be saved for this API.
  await act(async () => consent?.click());
  expect(button(container, 'Save')?.disabled).toBe(true);
});

it('without a connected decision API it points to the keys instead', async () => {
  const api = models();
  api.effortRouting.mockResolvedValue(
    view({ apis: view().apis.map((entry) => ({ ...entry, keyConfigured: false })) }),
  );
  const container = await render(api);
  await act(async () => radio(container, 'Manual')?.click());
  await act(async () => radio(container, 'Decision API')?.click());
  expect(container.textContent).toContain('Connect a decision API with its key first.');
  expect(container.querySelector('a[href="#models-decision-apis"]')).not.toBeNull();
  expect(button(container, 'Save')?.disabled).toBe(true);
});

it('a wait or thread count out of range names the range and blocks saving', async () => {
  const api = models();
  api.effortRouting.mockResolvedValue(view({ settings: LOCAL }));
  const container = await render(api);
  const wait = field(container, 'Longest wait (ms)');
  await type(wait, '50');
  expect(wait?.getAttribute('aria-invalid')).toBe('true');
  expect(container.textContent).toContain('Enter a whole number from 100 to 10,000.');
  expect(button(container, 'Save')?.disabled).toBe(true);
  await type(wait, '2500');
  await type(field(container, 'CPU threads'), '0');
  expect(container.textContent).toContain('Enter a whole number from 1 to 256.');
  expect(button(container, 'Save')?.disabled).toBe(true);
  await type(field(container, 'CPU threads'), '2');
  await choose(container, 'When no judgment applies', 'Medium');
  api.saveEffortRouting.mockImplementation(async (settings) => view({ settings }));
  await act(async () => button(container, 'Save')?.click());
  expect(api.saveEffortRouting).toHaveBeenCalledWith(
    {
      mode: 'manual',
      engine: { kind: 'local', device: { kind: 'cpu', threads: 2 }, callerTimeoutMs: 2500 },
      fallback: { kind: 'fixed', effort: 'medium' },
    },
    'rev_1',
  );
});

it('a save that lost only to another settings change goes through on the new revision', async () => {
  const api = models();
  api.effortRouting
    .mockResolvedValueOnce(view())
    .mockResolvedValueOnce(view({ revision: 'rev_2' }));
  api.saveEffortRouting
    .mockRejectedValueOnce(new ApiError(409, 'REVISION_CONFLICT', 'stale'))
    .mockImplementation(async (settings) => view({ settings, revision: 'rev_3' }));
  const container = await render(api);
  await act(async () => radio(container, 'Manual')?.click());
  await act(async () => button(container, 'Save')?.click());
  expect(api.saveEffortRouting.mock.calls.map((call) => call[1])).toEqual(['rev_1', 'rev_2']);
  expect(container.textContent).toContain('Saved');
});

it('a judgment setting changed elsewhere is shown instead of overwritten', async () => {
  const api = models();
  api.effortRouting
    .mockResolvedValueOnce(view())
    .mockResolvedValueOnce(view({ settings: LOCAL, revision: 'rev_2' }));
  api.saveEffortRouting.mockRejectedValueOnce(new ApiError(409, 'REVISION_CONFLICT', 'stale'));
  const container = await render(api);
  await act(async () => radio(container, 'Manual')?.click());
  await act(async () => radio(container, 'Decision API')?.click());
  const consent = container.querySelector<HTMLElement>('[aria-label="Send to this decision API"]');
  await act(async () => consent?.click());
  await act(async () => button(container, 'Save')?.click());
  expect(api.saveEffortRouting).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    'The setting changed elsewhere. Showing the saved one.',
  );
  expect(radio(container, 'Local judge model')?.getAttribute('aria-checked')).toBe('true');
});
