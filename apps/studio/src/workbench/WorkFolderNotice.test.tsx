// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkFolderNotice } from './WorkFolderNotice.tsx';
import { WORKSPACE_CHANGED } from './workspaceEvents.ts';

const fixture = vi.hoisted(() => ({ worktree: vi.fn() }));
vi.mock('../services.tsx', () => ({
  useServices: () => ({ mode: 'server', workspaces: fixture }),
}));
vi.mock('use-intl', () => ({ useTranslations: () => (key: string) => key }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

it('keeps file setup available after requests and refreshes when a copy is created', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.worktree.mockResolvedValue(null);
  const setup = vi.fn();
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(<WorkFolderNotice sessionId="one" revision="run:succeeded" onSetup={setup} />),
    );
    expect(container.textContent).toContain('noWorkingCopy');
    await act(async () => container.querySelector('button')?.click());
    expect(setup).toHaveBeenCalledOnce();
    fixture.worktree.mockResolvedValue({ missing: false, removedAt: null });
    await act(async () => window.dispatchEvent(new Event(WORKSPACE_CHANGED)));
    expect(container.textContent).toBe('');
    fixture.worktree.mockRejectedValue(new Error('offline'));
    await act(async () => window.dispatchEvent(new Event(WORKSPACE_CHANGED)));
    expect(container.textContent).toBe('');
  } finally {
    await act(async () => root.unmount());
  }
});
