// @vitest-environment jsdom
import { ApiError } from '@corral/client';
import type { GitDiff, GitStatus } from '@corral/contracts';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { GitPanel } from './GitPanel.tsx';

const fixture = vi.hoisted(() => ({ services: {} }));
vi.mock('../services.tsx', () => ({ useServices: () => fixture.services }));
vi.mock('../router.tsx', () => ({ reviewRoute: {} }));
vi.mock('@tanstack/react-router', () => ({ Link: () => null, useNavigate: () => () => {} }));
vi.mock('use-intl', () => ({
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
});
const target = {
  kind: 'session' as const,
  hostId: 'host',
  projectId: 'project',
  bindingId: 'binding',
  sessionId: 'session',
  copyGeneration: 1,
};
const path = 'src/한글 file.ts';
function status(): GitStatus {
  return {
    target,
    head: {
      oid: 'a'.repeat(40),
      branch: 'feature',
      detached: false,
      unborn: false,
      shallow: true,
      upstream: { name: 'origin/feature', ahead: 1, behind: 2 },
    },
    indexHash: 'b'.repeat(64),
    filtersDisabled: true,
    truncated: false,
    entries: [
      { kind: 'ordinary', path, indexStatus: 'M', worktreeStatus: 'M', submodule: false },
      {
        kind: 'untracked',
        path: 'new\nfile.ts',
        indexStatus: '?',
        worktreeStatus: '?',
        submodule: false,
      },
      {
        kind: 'unmerged',
        path: 'conflict.ts',
        indexStatus: 'U',
        worktreeStatus: 'U',
        submodule: false,
      },
    ],
  };
}
function diff(input: {
  target: GitStatus['target'];
  side: 'staged' | 'unstaged' | 'untracked';
  path: string;
  head: string | null;
  indexHash: string;
}): Extract<GitDiff, { kind: 'diff' }> {
  return {
    ...input,
    kind: 'diff',
    filtersDisabled: true,
    before: input.side === 'untracked' ? { kind: 'absent' } : { kind: 'text', text: 'before' },
    after: { kind: 'text', text: `${input.side} contents` },
  };
}
async function mount(workspaces: object, sessionId = 'session') {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    'Worker',
    class {
      postMessage() {}
      terminate() {}
    },
  );
  fixture.services = { mode: 'server', workspaceId: 'host', workspaces };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const render = (id: string) => root.render(<GitPanel sessionId={id} projectId="project" />);
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () => render(sessionId));
  const click = async (label: string) => {
    const button = [...container.querySelectorAll('button')].find(
      (element) => element.textContent === label,
    );
    expect(button).toBeDefined();
    await act(async () => button?.click());
  };
  const choose = async (side: string) => {
    const button = container.querySelector<HTMLButtonElement>(`button[data-git-side="${side}"]`);
    expect(button).not.toBeNull();
    await act(async () => button?.click());
  };
  return { container, root, render, click, choose };
}

it('[TC-WBD-008-H] staged and unstaged rows for one exact path select different read-only sides', async () => {
  const gitStatus = vi.fn(async () => status());
  const gitDiff = vi.fn(async (_scope, input) => diff(input));
  const f = await mount({ gitStatus, gitDiff });
  expect(f.container.textContent).toContain('Git.shallow');
  expect(f.container.textContent).toContain('origin/feature');
  expect(f.container.textContent).toContain('Git.conflicts');
  expect(f.container.textContent).toContain('Git.rawContent');
  expect(gitDiff).not.toHaveBeenCalled();
  await f.choose('staged');
  await f.click('Files.raw');
  expect(f.container.textContent).toContain('staged contents');
  expect(f.container.textContent).toContain('Git.comparison.staged');
  expect(f.container.textContent).not.toContain('Files.markFileReviewed');
  await f.choose('unstaged');
  await f.click('Files.raw');
  expect(f.container.textContent).toContain('unstaged contents');
  expect(gitDiff.mock.calls.map((call) => call[1])).toEqual([
    { target, side: 'staged', path, head: 'a'.repeat(40), indexHash: 'b'.repeat(64) },
    { target, side: 'unstaged', path, head: 'a'.repeat(40), indexHash: 'b'.repeat(64) },
  ]);
  await f.choose('untracked');
  await f.click('Files.raw');
  expect(gitDiff.mock.calls.at(-1)?.[1].path).toBe('new\nfile.ts');
  expect(f.container.textContent).toContain('untracked contents');
});

it('[TC-WBD-008-N] an index conflict requests explicit refresh without silently changing the captured target', async () => {
  const gitStatus = vi.fn(async () => status());
  const gitDiff = vi.fn(async () => {
    throw new ApiError(409, 'REVISION_CONFLICT', 'index changed');
  });
  const f = await mount({ gitStatus, gitDiff });
  await f.choose('staged');
  expect(f.container.textContent).toContain('Git.stateChanged');
  expect(gitStatus).toHaveBeenCalledTimes(1);
  expect(gitDiff).toHaveBeenCalledTimes(1);
});

it('[TC-WBD-008-H] a missing session copy can explicitly switch to an unborn project without creating a copy', async () => {
  const project: GitStatus = {
    ...status(),
    target: { kind: 'project', hostId: 'host', projectId: 'project', bindingId: 'binding' },
    head: {
      oid: null,
      branch: 'main',
      detached: false,
      unborn: true,
      shallow: false,
      upstream: null,
    },
    entries: [],
  };
  const gitStatus = vi.fn(async (scope) => {
    if (scope.kind === 'session') throw new ApiError(404, 'TARGET_NOT_FOUND', 'No working copy');
    return project;
  });
  const createWorktree = vi.fn();
  const f = await mount({ gitStatus, createWorktree });
  expect(f.container.textContent).toContain('Git.unavailable');
  await act(async () => f.container.querySelector<HTMLButtonElement>('[role=combobox]')?.click());
  const option = [...document.querySelectorAll<HTMLElement>('[role=option]')].find(
    (item) => item.textContent === 'Git.projectSource',
  );
  expect(option).toBeDefined();
  await act(async () => option?.focus());
  await act(async () =>
    option?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
  );
  expect(gitStatus.mock.calls.map((call) => call[0])).toEqual([
    { kind: 'session', id: 'session' },
    { kind: 'project', id: 'project' },
  ]);
  expect(f.container.textContent).toContain('Git.unborn');
  expect(f.container.textContent).toContain('Git.noUpstream');
  expect(createWorktree).not.toHaveBeenCalled();
});

it('[TC-WBD-008-F] a late diff cannot cross a session target change', async () => {
  let release!: (value: GitDiff) => void;
  const pending = new Promise<GitDiff>((resolve) => {
    release = resolve;
  });
  const nextTarget = { ...target, sessionId: 'second', copyGeneration: 2 };
  const gitStatus = vi.fn(async (scope) => ({
    ...status(),
    target: scope.id === 'second' ? nextTarget : target,
  }));
  const gitDiff = vi.fn((_scope, input) =>
    input.target.sessionId === 'session' ? pending : Promise.resolve(diff(input)),
  );
  const f = await mount({ gitStatus, gitDiff });
  await f.choose('staged');
  await act(async () => f.render('second'));
  await f.choose('unstaged');
  await f.click('Files.raw');
  await act(async () =>
    release({
      ...diff(gitDiff.mock.calls[0]?.[1]),
      after: { kind: 'text', text: 'OLD SESSION CONTENT' },
    }),
  );
  expect(f.container.textContent).toContain('unstaged contents');
  expect(f.container.textContent).not.toContain('OLD SESSION CONTENT');
  expect(gitDiff.mock.calls[1]?.[1].target).toEqual(nextTarget);
});
