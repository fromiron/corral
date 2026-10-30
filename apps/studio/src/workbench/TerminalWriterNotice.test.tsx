// @vitest-environment jsdom
import type { TerminalView } from '@corral/contracts';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { TerminalWriterNotice } from './TerminalWriterNotice.tsx';
import { WORKSPACE_CHANGED } from './workspaceEvents.ts';

const fixture = vi.hoisted(() => ({ store: null as unknown, api: {} }));
vi.mock('../services.tsx', () => ({
  useServices: () => ({ mode: 'server', terminals: fixture.api }),
}));
vi.mock('./terminals/store.ts', () => ({ terminalStore: () => fixture.store }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    params,
    search,
    children,
    ...props
  }: {
    params: { sessionId: string };
    search: { terminal: string };
    children: React.ReactNode;
  }) => (
    <a {...props} href={`/sessions/${params.sessionId}?terminal=${search.terminal}`}>
      {children}
    </a>
  ),
}));

it('shows current ownership before sending, retains it after input release, and refreshes after stop', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const terminal = { terminalId: 'pty', state: 'running', controller: null } as TerminalView;
  const store = createStore(() => ({
    sessions: { session: { list: { terminals: [terminal] }, loading: false } },
  }));
  const refresh = vi.fn(async () => {});
  fixture.store = Object.assign(store, { refresh });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <IntlProvider locale="en" messages={messages}>
          <TerminalWriterNotice sessionId="session" />
        </IntlProvider>,
      ),
    );
    expect(container.textContent).toContain('A terminal is holding this working copy');
    expect(container.querySelector('a')?.getAttribute('href')).toContain('terminal=pty');
    expect(refresh).toHaveBeenCalledWith('session');
    await act(async () =>
      store.setState({
        sessions: {
          session: { list: { terminals: [{ ...terminal, state: 'uncertain' }] }, loading: false },
        },
      }),
    );
    expect(container.textContent).toContain('termination has not been confirmed');
    await act(async () => {
      window.dispatchEvent(new Event(WORKSPACE_CHANGED));
      store.setState({
        sessions: {
          session: { list: { terminals: [{ ...terminal, state: 'exited' }] }, loading: false },
        },
      });
    });
    expect(container.textContent).toBe('');
    expect(refresh.mock.calls.length).toBeGreaterThan(1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
