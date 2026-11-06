// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkFolderNotice } from './WorkFolderNotice.tsx';
import { WORKSPACE_CHANGED } from './workspaceEvents.ts';

const fixture = vi.hoisted(() => ({ worktree: vi.fn(), workspaceId: 'host' }));
vi.mock('../services.tsx', () => ({
  useServices: () => ({ mode: 'server', workspaces: fixture, workspaceId: fixture.workspaceId }),
}));
vi.mock('use-intl', () => ({ useTranslations: () => (key: string) => key }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
  window.localStorage.clear();
  fixture.workspaceId = 'host';
});

it('remembers dismissal across requests and remounts while preserving the file setup action', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.worktree.mockResolvedValue(null);
  const setup = vi.fn();
  const container = document.createElement('div');
  document.body.append(container);
  let root = createRoot(container);
  const render = async (revision: string) =>
    act(async () =>
      root.render(<WorkFolderNotice sessionId="one" revision={revision} onSetup={setup} />),
    );
  try {
    await render('');
    const dismiss = container.querySelector<HTMLButtonElement>(
      'button[aria-label="hideWorkingCopyNotice"]',
    );
    expect(dismiss).not.toBeNull();
    dismiss?.focus();
    await act(async () => dismiss?.click());
    await vi.waitFor(() =>
      expect(container.querySelector('[data-testid="work-folder-notice"]')).toBeNull(),
    );
    const compactSetup = container.querySelector<HTMLButtonElement>(
      '[data-testid="work-folder-setup"]',
    );
    expect(compactSetup?.textContent).toBe('prepareWorkingCopy');
    expect(document.activeElement).toBe(compactSetup);
    await act(async () => compactSetup?.click());
    expect(setup).toHaveBeenCalledOnce();
    await render('run:running');
    await render('run:succeeded');
    await act(async () => window.dispatchEvent(new Event(WORKSPACE_CHANGED)));
    expect(container.textContent).not.toContain('noWorkingCopy');
    await act(async () => root.unmount());
    root = createRoot(container);
    await render('run:succeeded');
    expect(container.textContent).not.toContain('noWorkingCopy');
    expect(container.textContent).toContain('prepareWorkingCopy');
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it('keeps dismissal within its workspace, session and missing copy generation', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  const root = createRoot(container);
  const copy = { bindingId: 'folder', copyGeneration: 1, missing: true, removedAt: null };
  fixture.worktree.mockResolvedValue(copy);
  const render = async (sessionId: string) =>
    act(async () =>
      root.render(<WorkFolderNotice sessionId={sessionId} revision="" onSetup={() => {}} />),
    );
  try {
    await render('one');
    const dismiss = container.querySelector<HTMLButtonElement>(
      'button[aria-label="hideWorkingCopyNotice"]',
    );
    expect(dismiss).not.toBeNull();
    await act(async () => dismiss?.click());
    await vi.waitFor(() => expect(container.textContent).not.toContain('noWorkingCopy'));
    await render('two');
    expect(container.textContent).toContain('noWorkingCopy');
    await render('one');
    await vi.waitFor(() => expect(container.textContent).not.toContain('noWorkingCopy'));
    fixture.workspaceId = 'other-host';
    await render('one');
    expect(container.textContent).toContain('noWorkingCopy');
    fixture.workspaceId = 'host';
    await render('one');
    await vi.waitFor(() => expect(container.textContent).not.toContain('noWorkingCopy'));
    fixture.worktree.mockResolvedValue({ ...copy, copyGeneration: 2, missing: false });
    await act(async () => window.dispatchEvent(new Event(WORKSPACE_CHANGED)));
    expect(container.textContent).toBe('');
    fixture.worktree.mockResolvedValue({
      ...copy,
      copyGeneration: 2,
      removedAt: '2026-10-30T00:00:00Z',
    });
    await act(async () => window.dispatchEvent(new Event(WORKSPACE_CHANGED)));
    expect(container.textContent).toContain('noWorkingCopy');
  } finally {
    await act(async () => root.unmount());
  }
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
