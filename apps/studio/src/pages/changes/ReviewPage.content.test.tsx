// @vitest-environment jsdom
import type { WorkSession } from '@corral/core';
import { act, type ReactNode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { ReviewSearch } from '../../workbench/panels/routes.ts';
import { WORKSPACE_CHANGED } from '../../workbench/workspaceEvents.ts';
import { ReviewContent } from './ReviewPage.tsx';

const fixture = vi.hoisted(() => ({
  services: {},
  session: null as WorkSession | null,
  navigate: vi.fn(),
}));
vi.mock('../../services.tsx', () => ({ useServices: () => fixture.services }));
vi.mock('../FilesViews.tsx', () => ({ useBinding: () => ({ binding: null }) }));
vi.mock('./LspProposals.tsx', () => ({ LspProposals: () => null }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  useNavigate: () => fixture.navigate,
}));
vi.mock('../../workbench/useModels.ts', () => ({ useModelProfiles: () => null }));
vi.mock('@corral/react/design-kit', async (original) => ({
  ...(await original<typeof import('@corral/react/design-kit')>()),
  Select: ({
    value,
    label,
    options,
    onValueChange,
  }: {
    value: string;
    label: string;
    options: { value: string; label: string }[];
    onValueChange: (value: string) => void;
  }) => (
    <select
      aria-label={label}
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));
vi.mock('use-intl', async (original) => {
  const actual = await original<typeof import('use-intl')>();
  return {
    ...actual,
    useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
    useFormatter: () => actual.createFormatter({ locale: 'en', timeZone: 'UTC' }),
  };
});
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  fixture.navigate.mockClear();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

async function mount({ noCopy = false } = {}) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const session: WorkSession = {
    sessionId: 'session_embedded',
    projectId: 'project',
    corralId: null,
    auto: null,
    title: 'Current session',
    objective: '',
    pinned: false,
    revision: 1,
    createdAt: '2026-10-26T00:00:00Z',
    updatedAt: '2026-10-26T00:00:00Z',
    archivedAt: null,
    autoStart: true,
    entries: [],
  };
  fixture.session = session;
  const changes = vi.fn(async () => ({
    from: null,
    to: null,
    files: [
      {
        path: 'README.md',
        status: 'modified',
        additions: 1,
        deletions: 0,
        binary: false,
        provenance: 'external_observed',
        beforeBlob: 'before',
        afterBlob: 'after',
      },
    ],
  }));
  let copy = noCopy ? null : { missing: false };
  fixture.services = {
    mode: 'browser',
    live: false,
    workspaceId: 'host',
    transport: { listRuns: async () => [] },
    repository: { getSession: async () => session },
    workspaces: {
      worktree: async () => copy,
      comments: async () => [],
      changes,
      verifications: async () => [],
      fileOperations: async () => [],
    },
  };
  const prepare = vi.fn();
  const searchChanged = vi.fn();
  function Embedded() {
    const [search, setSearch] = useState<ReviewSearch>({ scope: 'review' });
    return (
      <ReviewContent
        session={session}
        search={search}
        onSearch={(patch) => {
          searchChanged(patch);
          setSearch((previous) => ({ ...previous, ...patch }));
        }}
        onPrepareCopy={prepare}
      />
    );
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () => root.render(<Embedded />));
  return {
    container,
    prepare,
    searchChanged,
    changes,
    createCopy: () => {
      copy = { missing: false };
    },
  };
}

it('selects review files through the Changes tab that holds the review', async () => {
  {
    const view = await mount();
    const file = [...view.container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('README.md'),
    );
    expect(file).toBeDefined();
    await act(async () => file?.click());
    {
      expect(view.searchChanged).toHaveBeenLastCalledWith({ file: 'README.md' });
      expect(fixture.navigate).not.toHaveBeenCalled();
      expect(view.container.textContent).not.toContain('Current session');
      expect(view.container.querySelector('main')).toBeNull();
      expect(file?.getAttribute('aria-current')).toBe('true');
      const scope = view.container.querySelector<HTMLSelectElement>(
        'select[aria-label="Files.scope"]',
      );
      if (!scope) throw new Error('Missing scope');
      await act(async () => {
        scope.value = 'session';
        scope.dispatchEvent(new Event('change', { bubbles: true }));
      });
      expect(view.searchChanged).toHaveBeenLastCalledWith({
        scope: 'session',
        runId: undefined,
        file: undefined,
      });
      expect(view.changes).toHaveBeenLastCalledWith('session_embedded', { kind: 'session' });
    }
  }
});

// glossary.md, "설명이 붙는 용어": in the Changes pane the pane's own setup view is the place
// for the Paddock term (FilesViews), so the review draws no Paddock icon.
it('without a Paddock, draws no Paddock icon', async () => {
  const view = await mount({ noCopy: true });
  expect(view.container.querySelectorAll('[data-term-hint]')).toHaveLength(0);
});

it('prepares a missing copy through Changes and refreshes the retained review after creation', async () => {
  const view = await mount({ noCopy: true });
  const prepare = [...view.container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Files.makeCopyThere',
  );
  expect(prepare).toBeDefined();
  await act(async () => prepare?.click());
  expect(view.prepare).toHaveBeenCalledTimes(1);
  expect(fixture.navigate).not.toHaveBeenCalled();
  view.createCopy();
  await act(async () => window.dispatchEvent(new Event(WORKSPACE_CHANGED)));
  expect(view.container.querySelector('[data-testid="review-empty"]')).toBeNull();
  expect(view.changes).toHaveBeenCalledWith('session_embedded', { kind: 'review' });
  expect(view.container.textContent).toContain('README.md');
});
