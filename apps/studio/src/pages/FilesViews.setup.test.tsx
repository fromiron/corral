// @vitest-environment jsdom
import type { PaddockSetup } from '@corral/client';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { WorkFolderSection, WorkingCopyPanel } from './FilesViews.tsx';

// features/paddock-setup.md 적기 · 화면: the setup command beside the checks, and the setup's
// state in the Paddock head with its one action.

const fixture = vi.hoisted(() => ({
  setup: null as PaddockSetup | null,
  configure: vi.fn(async (..._args: unknown[]) => ({})),
  stopSetup: vi.fn(async (..._args: unknown[]) => ({})),
  startSetup: vi.fn(async (..._args: unknown[]) => ({})),
}));
const target = {
  hostId: 'local',
  projectId: 'project',
  bindingId: 'binding_1',
  sessionId: 'session_1',
  copyGeneration: 2,
};
vi.mock('../services.tsx', () => {
  const workspaces = {
    binding: async () => ({
      bindingId: 'binding_1',
      projectId: 'project',
      path: '/folder',
      trusted: true,
      missing: false,
      isGit: true,
      status: { branch: 'main', head: 'abc', changed: 0 },
      verifyCommands: [],
      setupCommand: 'pnpm install',
      setupRevision: 4,
    }),
    configure: fixture.configure,
    worktree: async () => ({
      sessionId: 'session_1',
      bindingId: 'binding_1',
      copyGeneration: 2,
      baseCommit: 'abc1234abc1234',
      createdAt: '2026-11-26T00:00:00.000Z',
      removedAt: null,
      reviewed: false,
      missing: false,
      setup: fixture.setup,
    }),
    setup: async () => ({
      ...fixture.setup,
      target,
      output: { text: 'lockfile is stale', truncated: false },
    }),
    stopSetup: fixture.stopSetup,
    startSetup: fixture.startSetup,
  };
  return { useServices: () => ({ workspaces, mode: 'server' }) };
});
vi.mock('../workbench/SettingsLifecycle.tsx', () => ({
  useSettingsForm: () => {},
  useSettingsTask: () => (work: () => Promise<unknown>) => work(),
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children?: unknown }) => children ?? null,
}));
vi.mock('../workbench/CopyRemovalDialog.tsx', () => ({ CopyRemovalDialog: () => null }));
vi.mock('../workbench/navigation.ts', () => ({
  useSettingsNavigation: () => ({ link: () => ({ to: '/' }) }),
}));

let unmount: (() => Promise<void>) | null = null;
afterEach(async () => {
  await unmount?.();
  unmount = null;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function render(node: React.ReactNode) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        {node}
      </IntlProvider>,
    ),
  );
  unmount = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  return container;
}
const button = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll('button')].find((item) => item.textContent === name);

it('saves the setup command with the revision it was read at', async () => {
  const container = await render(<WorkFolderSection projectId="project" />);
  const field = container.querySelector<HTMLTextAreaElement>(
    `textarea[aria-label="${messages.Files.setupHeading}"]`,
  );
  expect(field?.value).toBe('pnpm install');
  expect(field?.placeholder).toContain('$CORRAL_SOURCE_DIR');
  expect(button(container, messages.Files.saveSetup)?.disabled).toBe(true);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(field, 'pnpm install --frozen-lockfile');
    field?.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => button(container, messages.Files.saveSetup)?.click());
  expect(fixture.configure).toHaveBeenCalledWith('project', {
    setupCommand: 'pnpm install --frozen-lockfile',
    setupRevision: 4,
  });
});

it('shows a running setup with Stop, and nothing once it succeeded', async () => {
  fixture.setup = {
    operationId: 'setup_1',
    state: 'running',
    reason: null,
    exitCode: null,
    startedAt: '2026-11-26T00:00:00.000Z',
    endedAt: null,
  };
  let container = await render(<WorkingCopyPanel sessionId="session_1" projectId="project" />);
  expect(container.querySelector('[role="status"]')?.textContent).toBe(messages.Files.setupRunning);
  await act(async () => button(container, messages.Files.setupStop)?.click());
  expect(fixture.stopSetup).toHaveBeenCalledWith('session_1', 'setup_1', target);
  await unmount?.();

  fixture.setup = { ...fixture.setup, state: 'succeeded', exitCode: 0, endedAt: 'x' };
  container = await render(<WorkingCopyPanel sessionId="session_1" projectId="project" />);
  expect(container.textContent).not.toContain(messages.Files.setupRunning);
  expect(container.textContent).not.toContain(messages.Files.setupFailed);
});

it('shows a failed setup with its kept output and runs it again on request', async () => {
  fixture.setup = {
    operationId: 'setup_1',
    state: 'failed',
    reason: 'command_failed',
    exitCode: 1,
    startedAt: '2026-11-26T00:00:00.000Z',
    endedAt: '2026-11-26T00:01:00.000Z',
  };
  const container = await render(<WorkingCopyPanel sessionId="session_1" projectId="project" />);
  expect(container.querySelector('[role="status"]')?.textContent).toBe(messages.Files.setupFailed);
  const details = container.querySelector('details');
  await act(async () => {
    if (details) details.open = true;
    details?.dispatchEvent(new Event('toggle'));
  });
  await vi.waitFor(() =>
    expect(container.querySelector('pre')?.textContent).toBe('lockfile is stale'),
  );
  await act(async () => button(container, messages.Files.setupAgain)?.click());
  expect(fixture.startSetup).toHaveBeenCalledWith('session_1', {
    operationId: expect.stringMatching(/^setup_[0-9a-f]{32}$/),
    target,
  });
});
