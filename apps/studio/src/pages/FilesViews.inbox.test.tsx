// @vitest-environment jsdom
import type { InboxItemView } from '@corral/client';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import en from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { InboxSection } from './FilesViews.tsx';

const fixture = vi.hoisted(() => ({ inbox: vi.fn(), commands: vi.fn() }));
const workspaces = { inbox: fixture.inbox, terminalStop: fixture.commands };
vi.mock('../services.tsx', () => ({ useServices: () => ({ workspaces }) }));
vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<typeof import('@tanstack/react-router')>()),
  Link: ({
    to,
    search,
    children,
    ...rest
  }: {
    to: string;
    search?: Record<string, string>;
    children: React.ReactNode;
  }) => (
    <a href={search ? `${to}?${new URLSearchParams(search)}` : to} {...rest}>
      {children}
    </a>
  ),
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({ location: { href: '/projects/project' } }),
}));

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it('sums up every pending item of the project in one line that opens Needs you', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const terminal: InboxItemView = {
    kind: 'uncertain_terminal',
    sessionId: 'session',
    sessionTitle: 'Terminal only',
    terminalId: 'pty_exact',
    runId: null,
    detail: null,
  };
  const queued: InboxItemView = {
    kind: 'queued',
    sessionId: 'session',
    sessionTitle: 'Terminal only',
    runId: null,
    detail: 'Private request body',
  };
  fixture.inbox.mockResolvedValue([terminal, queued]);
  const onItems = vi.fn();
  const container = document.createElement('div');
  const root = createRoot(container);
  disposals.push(async () => {
    await act(async () => root.unmount());
  });
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={en}>
        <InboxSection projectId="project" onItems={onItems} />
      </IntlProvider>,
    ),
  );
  // The project count is every inbox item, as the workspace header counts them.
  expect(container.textContent).toBe('2 items need you');
  expect(container.querySelectorAll('a')).toHaveLength(1);
  expect(container.querySelector('a')?.getAttribute('href')).toBe(
    '/inbox?returnTo=%2Fprojects%2Fproject',
  );
  expect(container.textContent).not.toContain('Private request body');
  expect(onItems).toHaveBeenLastCalledWith([terminal, queued]);
  expect(fixture.commands).not.toHaveBeenCalled();
  fixture.inbox.mockResolvedValue([terminal]);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(container.textContent).toBe('1 item needs you');
  fixture.inbox.mockResolvedValue([]);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(container.querySelector('a')).toBeNull();
  expect(onItems).toHaveBeenLastCalledWith([]);
});
