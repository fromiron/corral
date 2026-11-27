// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { useBinding, WorkFolderSection, WorkingCopyPanel } from './FilesViews.tsx';

// docs/specs/workbench.md: a failed folder or Paddock read is never taken as "none".

const fixture = vi.hoisted(() => ({
  binding: vi.fn(),
  worktree: vi.fn(),
}));
vi.mock('../services.tsx', () => {
  const workspaces = {
    binding: (projectId: string) => fixture.binding(projectId),
    worktree: (sessionId: string) => fixture.worktree(sessionId),
  };
  return { useServices: () => ({ workspaces, mode: 'server' }) };
});
vi.mock('../workbench/navigation.ts', () => ({
  useSettingsNavigation: () => ({ link: () => ({ to: '/' }) }),
}));
vi.mock('../workbench/SettingsLifecycle.tsx', () => ({
  useSettingsForm: () => async () => true,
  useSettingsTask: () => (work: () => Promise<unknown>) => work(),
}));
vi.mock('../workbench/CheckpointPanel.tsx', () => ({ CheckpointPanel: () => null }));
vi.mock('../workbench/CopyRemovalDialog.tsx', () => ({ CopyRemovalDialog: () => null }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children?: ReactNode }) => <a href="/">{children}</a>,
}));

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  fixture.binding.mockReset();
  fixture.worktree.mockReset();
  vi.unstubAllGlobals();
});

async function render(
  view: ReactNode = <WorkingCopyPanel sessionId="session" projectId="project" />,
) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        {view}
      </IntlProvider>,
    ),
  );
  for (let i = 0; i < 3; i++) await act(async () => {});
  return container;
}
const named = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll('button')].find((button) => button.textContent === name);

it('a failed Paddock read says why and offers Try again, never Make a Paddock', async () => {
  fixture.binding.mockResolvedValue({ trusted: true, status: { head: 'main', changed: 0 } });
  fixture.worktree.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(null);
  const container = await render();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    messages.Files.copyReadFailed.replace('{message}', 'offline'),
  );
  expect(container.textContent).not.toContain(messages.Files.noCopyTitle);
  expect(container.textContent).not.toContain('Make a Paddock');
  await act(async () => named(container, messages.Files.retry)?.click());
  for (let i = 0; i < 3; i++) await act(async () => {});
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.textContent).toContain('Make a Paddock from main');
});

it('a failed folder read says why and offers Try again, never linking a folder', async () => {
  fixture.binding.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(null);
  fixture.worktree.mockResolvedValue(null);
  const container = await render();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    messages.Files.folderReadFailed.replace('{message}', 'offline'),
  );
  expect(container.textContent).not.toContain(messages.Files.noFolder);
  expect(container.textContent).not.toContain(messages.Files.openFolderSettings);
  await act(async () => named(container, messages.Files.retry)?.click());
  for (let i = 0; i < 3; i++) await act(async () => {});
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.textContent).toContain(messages.Files.noFolder);
});

it('says on the project page that the folder link could not be read, and reads it again', async () => {
  fixture.binding.mockRejectedValueOnce(new Error('disk offline'));
  const container = await render(<WorkFolderSection projectId="project" />);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('disk offline');
  expect(container.querySelector('form')).toBeNull();
  fixture.binding.mockResolvedValueOnce(null);
  await act(async () => named(container, 'Try again')?.click());
  for (let i = 0; i < 3; i++) await act(async () => {});
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.querySelector('form')).not.toBeNull();
});

it('Try again reads the folder link again for every view that shows it', async () => {
  fixture.binding
    .mockRejectedValueOnce(new Error('offline'))
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue(null);
  function Elsewhere() {
    const { failed } = useBinding('project');
    return <output>{failed ?? 'read'}</output>;
  }
  const container = await render(
    <>
      <WorkFolderSection projectId="project" />
      <Elsewhere />
    </>,
  );
  expect(container.querySelector('output')?.textContent).toBe('offline');
  await act(async () => named(container, 'Try again')?.click());
  for (let i = 0; i < 3; i++) await act(async () => {});
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.querySelector('output')?.textContent).toBe('read');
});
