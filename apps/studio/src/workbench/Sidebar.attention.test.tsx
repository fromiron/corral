// @vitest-environment jsdom
import type { InboxItemView } from '@corral/client';
import type { WorkSession } from '@corral/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { expect, it, vi } from 'vitest';
import en from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { changePreferences } from './preferences.ts';
import { useCorralSidebar } from './Sidebar.tsx';
import { sessionListState, uncertainSessionTerminal } from './sessionList.ts';

const fixture = vi.hoisted(() => ({
  attention: vi.fn(),
  inbox: vi.fn(),
  stop: vi.fn(),
  desktop: { notify: vi.fn(async () => {}), badge: vi.fn(async () => {}) },
}));
vi.mock('../desktop.tsx', () => ({ desktop: fixture.desktop }));
const otherSession = {
  sessionId: 'other_session',
  projectId: 'other',
  title: 'Terminal only',
  entries: [],
  archivedAt: null,
} as unknown as WorkSession;
const services = {
  transport: { listRuns: vi.fn(async () => []) },
  repository: {
    list: vi.fn(async () => []),
    listProjects: vi.fn(async () => [
      { projectId: 'default', archivedAt: null },
      { projectId: 'other', archivedAt: null },
    ]),
    listSessions: vi.fn(async (projectId: string) => (projectId === 'other' ? [otherSession] : [])),
  },
  workspaces: { inbox: fixture.inbox },
  terminals: { attention: fixture.attention, stop: fixture.stop },
};
vi.mock('../services.tsx', () => ({ useServices: () => services }));
vi.mock('../projects.ts', async (original) => ({
  ...(await original<typeof import('../projects.ts')>()),
  useCurrentProject: () => 'default',
  useProjectsVersion: () => 0,
}));
const navigate = vi.fn();
vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<typeof import('@tanstack/react-router')>()),
  useNavigate: () => navigate,
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({ location: { href: '/projects/default' } }),
}));

it('marks another project’s terminal-only session without fetching every project inbox', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const terminal: InboxItemView = {
    kind: 'uncertain_terminal',
    sessionId: 'other_session',
    sessionTitle: 'Terminal only',
    terminalId: 'other_terminal',
    runId: null,
    detail: null,
  };
  fixture.attention.mockResolvedValue([terminal]);
  fixture.inbox.mockResolvedValue([]);
  function View() {
    const model = useCorralSidebar();
    const other = model.sessions.find((session) => session.sessionId === 'other_session');
    return (
      <p>
        {other
          ? `${sessionListState(other, model.runs, model.terminalAttention)}:${uncertainSessionTerminal(other.sessionId, model.terminalAttention) ?? ''}`
          : 'loading'}
      </p>
    );
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <IntlProvider locale="en" messages={en}>
          <View />
        </IntlProvider>,
      ),
    );
    expect(container.textContent).toBe('attention:other_terminal');
    expect(fixture.inbox).toHaveBeenCalledWith('default');
    expect(fixture.inbox).not.toHaveBeenCalledWith('other');
    expect(fixture.attention).toHaveBeenCalledWith();
    fixture.attention.mockResolvedValue([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(container.textContent).toBe('empty:');
    expect(fixture.stop).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

// desktop-contract.md 알림: the app's first inbox read notifies nothing already waiting; a target
// seen for the first time later does, once.
it('notifies no item that was waiting at the first read, and a new one once', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  changePreferences({ notify: true });
  const item = (runId: string): InboxItemView => ({
    kind: 'decision',
    sessionId: 'other_session',
    sessionTitle: 'Terminal only',
    runId,
    detail: null,
  });
  fixture.attention.mockResolvedValue([]);
  fixture.inbox.mockResolvedValue([item('run_waiting')]);
  fixture.desktop.notify.mockClear();
  function View() {
    useCorralSidebar();
    return null;
  }
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () =>
      root.render(
        <IntlProvider locale="en" messages={en}>
          <View />
        </IntlProvider>,
      ),
    );
    expect(fixture.inbox).toHaveBeenCalled();
    expect(fixture.desktop.notify).not.toHaveBeenCalled();
    fixture.inbox.mockResolvedValue([item('run_waiting'), item('run_new')]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(fixture.desktop.notify).toHaveBeenCalledTimes(1);
    expect(fixture.desktop.notify.mock.calls[0]?.[2]).toMatchObject({ runId: 'run_new' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(fixture.desktop.notify).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});
