// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { WORKSPACE_CHANGED, WorkingCopyPanel } from './FilesViews.tsx';

const fixture = vi.hoisted(() => ({ copy: null as unknown }));
vi.mock('../services.tsx', () => {
  const workspaces = {
    binding: async () => ({ trusted: true, status: { head: 'main', changed: 0 } }),
    worktree: async () => fixture.copy,
  };
  return { useServices: () => ({ workspaces }) };
});
vi.mock('../workbench/navigation.ts', () => ({
  useSettingsNavigation: () => ({ link: () => ({ to: '/' }) }),
}));
vi.mock('../workbench/DevelopmentMode.tsx', () => ({ DevelopmentMode: () => null }));
vi.mock('../workbench/CheckpointPanel.tsx', () => ({ CheckpointPanel: () => null }));
vi.mock('../workbench/CopyRemovalDialog.tsx', () => ({ CopyRemovalDialog: () => null }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    params,
    children,
    ...props
  }: {
    to: string;
    params?: { sessionId: string };
    children?: ReactNode;
  }) => (
    <a {...props} href={to.replace('$sessionId', params?.sessionId ?? '')}>
      {children}
    </a>
  ),
}));

it('an open copy card follows creation and removal from another entry point', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.copy = null;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <WorkingCopyPanel sessionId="session" projectId="project" />
        </IntlProvider>,
      ),
    );
    expect(container.querySelector('a[href="/sessions/session/review"]')).toBeNull();
    fixture.copy = { baseCommit: 'a'.repeat(40), missing: false };
    await act(async () => window.dispatchEvent(new Event(WORKSPACE_CHANGED)));
    expect(container.querySelector('a[href="/sessions/session/review"]')).not.toBeNull();
    fixture.copy = null;
    await act(async () => window.dispatchEvent(new Event(WORKSPACE_CHANGED)));
    expect(container.querySelector('a[href="/sessions/session/review"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
