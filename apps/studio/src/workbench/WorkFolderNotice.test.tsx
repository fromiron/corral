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

/** The folder mark's accessible name: what assistive tech reads and its tooltip says. */
const nameOf = (container: HTMLElement) =>
  container
    .querySelector('[data-testid="folder-access"], [data-testid="working-copy-chip"]')
    ?.getAttribute('aria-label');

// workbench.md: the folder state is said by one mark, of one size in one place, in all five
// states. Its sentence is its name and tooltip, never visible words that the line would cut.
it('says every folder state with one mark: no visible words, the sentence as its name', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const glyphs = new Map<string, string>();
  try {
    for (const [access, name] of [
      ['copy', 'agentCopy'],
      ['direct', 'agentDirect'],
      ['unlinked', 'agentNoFiles linkFolder.'],
      ['untrusted', 'agentNoFiles trustFolder.'],
      ['missing', 'agentFolderMissing checkFolder.'],
    ] as const) {
      await act(async () =>
        root.render(<FolderAccessNotice access={access} onAction={() => {}} />),
      );
      const marks = container.querySelectorAll<HTMLElement>(
        '[data-testid="folder-access"], [data-testid="working-copy-chip"]',
      );
      expect(marks, access).toHaveLength(1);
      const mark = marks[0] as HTMLElement;
      expect(container.textContent, access).toBe('');
      expect(mark.getAttribute('aria-label'), access).toBe(name);
      expect(mark.querySelector('svg'), access).not.toBeNull();
      // One size, never cut and never giving way to the rest of the line.
      expect(mark.className, access).toMatch(/\bsize-7\b|\bh-7\b/);
      expect(mark.className, access).toContain('shrink-0');
      expect(mark.className, access).not.toMatch(/\btruncate\b|\bgrow\b|basis-0/);
      if (access === 'copy' || access === 'direct') {
        // No next step: not a button, yet reachable by keyboard so its tooltip can be read.
        expect(container.querySelector('button'), access).toBeNull();
        expect(mark.getAttribute('role'), access).toBe('img');
        expect(mark.tabIndex, access).toBe(0);
      } else {
        expect(mark.tagName, access).toBe('BUTTON');
      }
      glyphs.set(access, mark.querySelector('svg')?.getAttribute('class') ?? '');
    }
    // One folder family: open where there is a next step, plain when read, with a pen when the
    // working copy can be changed.
    expect(glyphs.get('copy')).toMatch(/\blucide-folder-pen\b/);
    expect(glyphs.get('direct')).toMatch(/\blucide-folder\b(?!-)/);
    for (const access of ['unlinked', 'untrusted', 'missing'])
      expect(glyphs.get(access), access).toMatch(/\blucide-folder-open\b/);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it('an unlinked folder is an icon button that says the agent cannot read or change files and offers linking', async () => {
  fixture.binding.mockResolvedValue(null);
  fixture.worktree.mockResolvedValue(null);
  const action = vi.fn();
  const { container, render, dispose } = await mount();
  try {
    await render('one', 'project', '', action);
    const chip = container.querySelector('button');
    // No folder: the kit icon button alone on the tool line; the sentence is its name and tooltip.
    expect(chip?.textContent).toBe('');
    expect(chip?.querySelector('svg')).not.toBeNull();
    expect(chip?.getAttribute('aria-label')).toBe('agentNoFiles linkFolder.');
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
      'agentNoFiles trustFolder.',
    );
    fixture.binding.mockResolvedValue({ trusted: true, missing: false });
    await act(async () => window.dispatchEvent(new Event(WORKSPACE_CHANGED)));
    expect(container.querySelector('button')).toBeNull();
    expect(nameOf(container)).toBe('agentDirect');
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
    expect(nameOf(container)).toBe('agentCopy');
    fixture.worktree.mockResolvedValue({ missing: false, removedAt: '2026-11-01T00:00:00Z' });
    await act(async () => window.dispatchEvent(new Event(WORKSPACE_CHANGED)));
    expect(nameOf(container)).toBe('agentDirect');
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
      'agentFolderMissing checkFolder.',
    );
    fixture.binding.mockRejectedValue(new Error('offline'));
    await act(async () => window.dispatchEvent(new Event(WORKSPACE_CHANGED)));
    expect(container.textContent).toBe('');
    fixture.workspaceId = 'other-host';
    fixture.binding.mockResolvedValue(null);
    fixture.worktree.mockResolvedValue(null);
    await render('two', 'project', '');
    expect(container.querySelector('button')?.getAttribute('aria-label')).toBe(
      'agentNoFiles linkFolder.',
    );
  } finally {
    await dispose();
  }
});
