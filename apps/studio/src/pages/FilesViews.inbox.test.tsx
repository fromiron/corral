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
    params,
    search,
    children,
  }: {
    params: { sessionId: string };
    search: Record<string, string>;
    children: React.ReactNode;
  }) => <a href={`/sessions/${params.sessionId}?${new URLSearchParams(search)}`}>{children}</a>,
}));

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it('shows a terminal-only pending action, publishes its state, and links to its exact controls without a command', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const item: InboxItemView = {
    kind: 'uncertain_terminal',
    sessionId: 'session',
    sessionTitle: 'Terminal only',
    terminalId: 'pty_exact',
    runId: null,
    detail: null,
  };
  fixture.inbox.mockResolvedValue([item]);
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
  expect(container.textContent).toContain('Terminal termination needs confirmation');
  expect(container.querySelector('a')?.getAttribute('href')).toBe(
    '/sessions/session?panel=terminal&terminal=pty_exact',
  );
  expect(onItems).toHaveBeenLastCalledWith([item]);
  expect(fixture.commands).not.toHaveBeenCalled();
  fixture.inbox.mockResolvedValue([]);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(container.querySelector('section')).toBeNull();
  expect(onItems).toHaveBeenLastCalledWith([]);
});
