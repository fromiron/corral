// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { FilePanel } from './FilePanel.tsx';

const fixture = vi.hoisted(() => ({
  workspaces: { previews: vi.fn(async () => []), commands: vi.fn(async () => []) },
  files: {
    scope: { kind: 'session', id: 'session' },
    list: { files: [], truncated: false },
    hasCopy: true,
    copy: null,
    loading: false,
    error: null,
    refresh() {},
  },
}));
vi.mock('../services.tsx', () => ({
  useServices: () => ({ mode: 'server', workspaces: fixture.workspaces }),
}));
vi.mock('../pages/Workbench.tsx', () => ({
  useRemembered: (_key: string, initial: unknown) => useState(initial),
}));
vi.mock('./useWorkspaceFiles.ts', () => ({ useWorkspaceFiles: () => fixture.files }));
vi.mock('./documents/store.ts', () => ({ documentStore: () => null }));
vi.mock('./DocumentPanel.tsx', () => ({ DocumentPanel: () => null }));
vi.mock('./TerminalPanel.tsx', () => ({ TerminalPanel: () => null }));
vi.mock('./WorktreeCommandPanel.tsx', () => ({ WorktreeCommandPanel: () => null }));
vi.mock('./navigation.ts', () => ({
  useSettingsNavigation: () => ({ link: () => ({ to: '/' }) }),
}));
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: () => ({ getVirtualItems: () => [], getTotalSize: () => 0 }),
}));

it('[TC-WBD-004-N] keeps one preview poller through file-panel rerenders and releases it on unmount', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const render = () =>
    act(async () => {
      root.render(
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <FilePanel projectId="default" sessionId="session" onReference={() => {}} />
        </IntlProvider>,
      );
    });
  try {
    await render();
    const initial = fixture.workspaces.previews.mock.calls.length;
    for (let i = 0; i < 10; i++) await render();
    const rerenderCalls = fixture.workspaces.previews.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    const pollCalls = fixture.workspaces.previews.mock.calls.length - rerenderCalls;
    const beforeUnmount = fixture.workspaces.previews.mock.calls.length;
    await act(async () => root.unmount());
    await vi.advanceTimersByTimeAsync(6000);
    const unmountCalls = fixture.workspaces.previews.mock.calls.length - beforeUnmount;
    expect({ rerenderCalls, pollCalls, unmountCalls }).toEqual({
      rerenderCalls: initial,
      pollCalls: 1,
      unmountCalls: 0,
    });
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});
