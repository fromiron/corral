// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { FolderAccessNotice, useFolderAccess } from './WorkFolderNotice.tsx';
import { WORKSPACE_CHANGED } from './workspaceEvents.ts';

const fixture = vi.hoisted(() => ({
  worktree: vi.fn(),
  binding: vi.fn(),
  workspaceId: 'host',
}));
vi.mock('../services.tsx', () => ({
  useServices: () => ({ mode: 'server', workspaces: fixture, workspaceId: fixture.workspaceId }),
}));
vi.mock('use-intl', () => ({ useTranslations: () => (key: string) => key }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
  fixture.workspaceId = 'host';
});

function Row({
  sessionId,
  projectId,
  revision,
  onAction,
}: {
  sessionId: string;
  projectId: string;
  revision: string;
  onAction(): void;
}) {
  const access = useFolderAccess(sessionId, projectId, revision);
  return <FolderAccessNotice access={access} onAction={onAction} />;
}

async function mount() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const render = async (
    sessionId: string,
    projectId: string,
    revision: string,
    onAction = () => {},
  ) =>
    act(async () =>
      root.render(
        <Row sessionId={sessionId} projectId={projectId} revision={revision} onAction={onAction} />,
      ),
    );
  const dispose = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  return { container, render, dispose };
}

it('an unlinked folder says the agent cannot read or change files and offers linking', async () => {
  fixture.binding.mockResolvedValue(null);
  fixture.worktree.mockResolvedValue(null);
  const action = vi.fn();
  const { container, render, dispose } = await mount();
  try {
    await render('one', 'project', '', action);
    const chip = container.querySelector('button');
    expect(chip?.textContent).toBe('agentNoFiles');
    expect(chip?.getAttribute('aria-label')).toBe('agentNoFiles. linkFolder');
    expect(container.querySelectorAll('button')).toHaveLength(1);
    await act(async () => chip?.click());
    expect(action).toHaveBeenCalledOnce();
  } finally {
    await dispose();
  }
});

it('an untrusted folder offers trust, and a trusted folder without a copy offers nothing', async () => {
  fixture.binding.mockResolvedValue({ trusted: false, missing: false });
  fixture.worktree.mockResolvedValue(null);
  const { container, render, dispose } = await mount();
  try {
    await render('one', 'project', '');
    expect(container.querySelector('button')?.getAttribute('aria-label')).toBe(
      'agentNoFiles. trustFolder',
    );
    fixture.binding.mockResolvedValue({ trusted: true, missing: false });
    await act(async () => window.dispatchEvent(new Event(WORKSPACE_CHANGED)));
    expect(container.querySelector('button')).toBeNull();
    expect(container.textContent).toBe('agentDirect');
  } finally {
    await dispose();
  }
});

it('a working copy says the agent can read and change it, with no next step', async () => {
  fixture.binding.mockResolvedValue({ trusted: true, missing: false });
  fixture.worktree.mockResolvedValue({ missing: false, removedAt: null });
  const { container, render, dispose } = await mount();
  try {
    await render('one', 'project', '');
    expect(container.querySelector('button')).toBeNull();
    expect(container.textContent).toBe('agentCopy');
    fixture.worktree.mockResolvedValue({ missing: false, removedAt: '2026-11-01T00:00:00Z' });
    await act(async () => window.dispatchEvent(new Event(WORKSPACE_CHANGED)));
    expect(container.textContent).toBe('agentDirect');
  } finally {
    await dispose();
  }
});

it('a missing folder offers the folder settings, and a failed lookup says nothing', async () => {
  fixture.binding.mockResolvedValue({ trusted: true, missing: true });
  fixture.worktree.mockResolvedValue(null);
  const { container, render, dispose } = await mount();
  try {
    await render('one', 'project', '');
    expect(container.querySelector('button')?.getAttribute('aria-label')).toBe(
      'agentFolderMissing. checkFolder',
    );
    fixture.binding.mockRejectedValue(new Error('offline'));
    await act(async () => window.dispatchEvent(new Event(WORKSPACE_CHANGED)));
    expect(container.textContent).toBe('');
    fixture.workspaceId = 'other-host';
    fixture.binding.mockResolvedValue(null);
    fixture.worktree.mockResolvedValue(null);
    await render('two', 'project', '');
    expect(container.querySelector('button')?.getAttribute('aria-label')).toBe(
      'agentNoFiles. linkFolder',
    );
  } finally {
    await dispose();
  }
});
