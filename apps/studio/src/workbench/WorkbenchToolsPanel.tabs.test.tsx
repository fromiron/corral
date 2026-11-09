// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { WorkbenchToolsPanel } from './WorkbenchToolsPanel.tsx';

Element.prototype.getAnimations ??= () => [];

const running = {
  operationId: 'task_dev',
  script: 'dev',
  command: 'vite',
  packageManager: 'pnpm' as const,
  state: 'running' as const,
  createdAt: '2026-11-10T00:00:00.000Z',
  updatedAt: '2026-11-10T00:00:00.000Z',
};
const fixture = vi.hoisted(() => ({
  workspaces: {
    tasks: vi.fn(),
    taskOutput: vi.fn(),
    startTask: vi.fn(),
    stopTask: vi.fn(),
    previews: vi.fn(),
    commands: vi.fn(async () => []),
    worktree: vi.fn(async () => null),
    startPreview: vi.fn(),
    stopPreview: vi.fn(),
  },
}));
vi.mock('../services.tsx', () => {
  // One services object, as the app's context provides.
  const services = { mode: 'server', workspaceId: 'local', workspaces: fixture.workspaces };
  return { useServices: () => services };
});
vi.mock('@tanstack/react-router', () => ({
  Link: () => null,
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({ location: { href: '/sessions/session' } }),
}));

const disposals: (() => Promise<void>)[] = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  for (const mock of Object.values(fixture.workspaces)) mock.mockClear();
  fixture.workspaces.tasks.mockImplementation(async () => ({
    candidates: { packageManager: 'pnpm', scripts: [{ name: 'dev', command: 'vite' }] },
    tasks: [running],
  }));
  fixture.workspaces.taskOutput.mockImplementation(async () => ({
    text: 'ready on 5173\n',
    nextOffset: 14,
    bytes: 14,
    truncated: false,
  }));
  fixture.workspaces.previews.mockImplementation(async () => []);
});
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.unstubAllGlobals();
});
async function mount() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  disposals.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () => {
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <WorkbenchToolsPanel sessionId="session" projectId="project" />
      </IntlProvider>,
    );
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  return container;
}
// A kit tab also holds an aria-hidden copy of its label that sizes it.
const named = (item: Element | null | undefined) => {
  const copy = item?.cloneNode(true) as Element | undefined;
  for (const hidden of copy?.querySelectorAll('[aria-hidden="true"]') ?? []) hidden.remove();
  return copy?.textContent?.trim();
};
const tab = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find((item) => named(item) === name);
const selected = (container: HTMLElement) =>
  named(container.querySelector('[role="tab"][aria-selected="true"]'));

it('splits the pane into Tasks and Preview tabs, starting on Tasks without a running preview', async () => {
  const container = await mount();
  expect(tab(container, messages.DevTasks.title)).toBeDefined();
  expect(tab(container, messages.Preview.tab)).toBeDefined();
  expect(selected(container)).toBe(messages.DevTasks.title);
});

it('switching tabs keeps a running task’s view and starts nothing again', async () => {
  const container = await mount();
  const tasks = container.querySelector('[data-testid="workbench-tasks"]');
  expect(tasks?.querySelector('[role="log"]')?.textContent).toContain('ready on 5173');
  const reads = fixture.workspaces.tasks.mock.calls.length;
  await act(async () => tab(container, messages.Preview.tab)?.click());
  expect(selected(container)).toBe(messages.Preview.tab);
  await act(async () => tab(container, messages.DevTasks.title)?.click());
  expect(selected(container)).toBe(messages.DevTasks.title);
  // The same mounted list: no remount, so no fresh read, no start and no second output stream.
  expect(container.querySelector('[data-testid="workbench-tasks"]')).toBe(tasks);
  expect(tasks?.querySelector('[role="log"]')?.textContent).toContain('ready on 5173');
  expect(fixture.workspaces.tasks.mock.calls.length).toBe(reads);
  expect(fixture.workspaces.startTask).not.toHaveBeenCalled();
  expect(fixture.workspaces.stopTask).not.toHaveBeenCalled();
  expect(fixture.workspaces.startPreview).not.toHaveBeenCalled();
});

it('starts on Preview when a preview is already running as the pane opens', async () => {
  fixture.workspaces.previews.mockImplementation(async () => [
    {
      leaseId: 'lease_one',
      sessionId: 'session',
      runId: 'run_one',
      kind: 'static',
      url: 'http://127.0.0.2:4100/index.html',
      origin: 'http://127.0.0.2:4100',
      path: 'index.html',
      state: 'ready',
      createdAt: '2026-11-10T00:00:00.000Z',
    },
  ]);
  const container = await mount();
  expect(selected(container)).toBe(messages.Preview.tab);
  // The tasks stay mounted behind the Preview tab.
  expect(container.querySelector('[data-testid="workbench-tasks"]')).not.toBeNull();
});
