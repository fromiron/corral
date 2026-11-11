// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useWorkingCopyMissing, WorkingCopyChip } from './WorkFolderNotice.tsx';
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

/** The composer row as the conversation fills it: the chip only while the copy is missing. */
function Row({
  sessionId,
  revision,
  onSetup,
}: {
  sessionId: string;
  revision: string;
  onSetup(): void;
}) {
  const missing = useWorkingCopyMissing(sessionId, revision);
  return missing ? <WorkingCopyChip onSetup={onSetup} /> : null;
}

async function mount() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const render = async (sessionId: string, revision: string, onSetup = () => {}) =>
    act(async () =>
      root.render(<Row sessionId={sessionId} revision={revision} onSetup={onSetup} />),
    );
  const dispose = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  return { container, render, dispose };
}

it('marks a missing copy with one chip that opens file setup and stays after requests', async () => {
  fixture.worktree.mockResolvedValue(null);
  const setup = vi.fn();
  const { container, render, dispose } = await mount();
  try {
    await render('one', '', setup);
    const chip = container.querySelector('button');
    expect(chip?.textContent).toBe('noWorkingCopy');
    // The visible words lead the name; the name also says what pressing it does.
    expect(chip?.getAttribute('aria-label')).toBe('noWorkingCopy · prepareWorkingCopy');
    // One control: no dismiss button, no second sentence.
    expect(container.querySelectorAll('button')).toHaveLength(1);
    await act(async () => chip?.click());
    expect(setup).toHaveBeenCalledOnce();
    await render('one', 'run:running', setup);
    await render('one', 'run:succeeded', setup);
    await act(async () => window.dispatchEvent(new Event(WORKSPACE_CHANGED)));
    expect(container.textContent).toBe('noWorkingCopy');
  } finally {
    await dispose();
  }
});

it('follows the copy: shown while missing or removed, gone once a copy exists', async () => {
  const copy = { bindingId: 'folder', copyGeneration: 1, missing: true, removedAt: null };
  fixture.worktree.mockResolvedValue(copy);
  const { container, render, dispose } = await mount();
  try {
    await render('one', '');
    expect(container.textContent).toBe('noWorkingCopy');
    fixture.worktree.mockResolvedValue({ ...copy, copyGeneration: 2, missing: false });
    await act(async () => window.dispatchEvent(new Event(WORKSPACE_CHANGED)));
    expect(container.textContent).toBe('');
    fixture.worktree.mockResolvedValue({
      ...copy,
      copyGeneration: 2,
      missing: false,
      removedAt: '2026-10-30T00:00:00Z',
    });
    await act(async () => window.dispatchEvent(new Event(WORKSPACE_CHANGED)));
    expect(container.textContent).toBe('noWorkingCopy');
    fixture.workspaceId = 'other-host';
    fixture.worktree.mockResolvedValue({ ...copy, missing: false });
    await render('two', '');
    expect(container.textContent).toBe('');
  } finally {
    await dispose();
  }
});

it('never reads a failed lookup as no copy', async () => {
  fixture.worktree.mockResolvedValue(null);
  const { container, render, dispose } = await mount();
  try {
    await render('one', '');
    expect(container.textContent).toBe('noWorkingCopy');
    fixture.worktree.mockRejectedValue(new Error('offline'));
    await act(async () => window.dispatchEvent(new Event(WORKSPACE_CHANGED)));
    expect(container.textContent).toBe('');
  } finally {
    await dispose();
  }
});
