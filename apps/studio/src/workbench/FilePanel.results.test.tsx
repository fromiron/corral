// @vitest-environment jsdom
import type { FileChangeView, FileOperationView } from '@corral/client';
import type { RunSummary } from '@corral/core';
import { act, type ReactNode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { FilePanel } from './FilePanel.tsx';

const fixture = vi.hoisted(() => ({
  fileOperations: vi.fn(),
  changes: vi.fn(),
  files: {
    scope: { kind: 'session', id: 'session' } as { kind: 'session' | 'project'; id: string },
    list: { files: [] as { path: string; bytes: number }[], truncated: false },
    hasCopy: true,
    copy: { bindingId: 'binding', copyGeneration: 3 },
    loading: false,
    error: null,
    refresh() {},
  },
}));
vi.mock('../services.tsx', () => {
  const services = {
    mode: 'server',
    workspaceId: 'local',
    workspaces: {
      readFile: async () => ({ content: { kind: 'text', text: '' } }),
      listFiles: async () => ({ files: [], truncated: false }),
      fileOperations: fixture.fileOperations,
      changes: fixture.changes,
    },
  };
  return { useServices: () => services };
});
vi.mock('../pages/Workbench.tsx', () => ({
  useRemembered: (_key: string, initial: unknown) => useState(initial),
}));
vi.mock('./useWorkspaceFiles.ts', () => ({ useWorkspaceFiles: () => fixture.files }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, ...props }: { children?: ReactNode }) => <a {...props}>{children}</a>,
}));
vi.mock('./ContentSearch.tsx', () => ({ ContentSearch: () => null }));
vi.mock('./documents/store.ts', () => {
  const state = { documents: {} };
  const owner = {
    getState: () => state,
    subscribe: () => () => {},
    open: async (_session: string, path: string) => `key:${path}`,
    sessionRecoveries: async () => [],
  };
  return { documentStore: () => owner };
});
vi.mock('./DocumentPanel.tsx', () => ({ DocumentPanel: () => null }));
vi.mock('./PierreCode.tsx', () => ({ SourceCode: () => null }));
vi.mock('./navigation.ts', () => ({
  useSettingsNavigation: () => ({ link: () => ({ to: '/' }) }),
}));
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 28,
        size: 28,
      })),
    getTotalSize: () => count * 28,
    scrollToIndex: () => {},
  }),
}));

const file = (path: string) => ({ path, bytes: 1 });
const write = (run_id: string, path: string): FileOperationView => ({
  id: `op_${run_id}_${path}`,
  run_id,
  execution_id: 'exec_1',
  kind: 'write',
  path,
  to_path: null,
  state: 'applied',
  detail: null,
  created_at: '2026-11-10T00:00:00.000Z',
});
const changed = (path: string, provenance: FileChangeView['provenance']): FileChangeView => ({
  path,
  status: 'added',
  additions: 1,
  deletions: 0,
  binary: false,
  provenance,
  beforeBlob: null,
  afterBlob: 'blob',
});
const runs = [
  { runId: 'run_1', sessionId: 'session', status: 'succeeded', startedAt: '2026-11-10T00:00:00Z' },
  { runId: 'run_2', sessionId: 'session', status: 'succeeded', startedAt: '2026-11-10T01:00:00Z' },
] as RunSummary[];

const roots: (() => Promise<void>)[] = [];
beforeEach(() => {
  fixture.files = {
    ...fixture.files,
    scope: { kind: 'session', id: 'session' },
    list: {
      files: [file('README.md'), file('src/app.ts'), file('src/gen/out.ts'), file('notes.txt')],
      truncated: false,
    },
  };
  fixture.fileOperations.mockReset();
  fixture.changes.mockReset();
  fixture.fileOperations.mockResolvedValue([
    write('run_2', 'src/gen/out.ts'),
    write('run_9', 'orphan.txt'),
    write('run_1', 'notes.txt'),
  ]);
  fixture.changes.mockResolvedValue({
    from: 'base',
    to: 'now',
    unavailable: null,
    files: [
      changed('src/gen/out.ts', 'managed_agent'),
      changed('notes.txt', 'managed_agent'),
      changed('README.md', 'external_observed'),
    ],
  });
});
afterEach(async () => {
  for (const dispose of roots.splice(0)) await dispose();
  vi.unstubAllGlobals();
});
async function panel() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () => {
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <FilePanel
          projectId="project"
          sessionId="session"
          runs={runs}
          onReference={() => {}}
          onOpenDocument={() => true}
        />
      </IntlProvider>,
    );
  });
  return container;
}
const rows = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')].map((item) => [
    item.getAttribute('title'),
    item.getAttribute('aria-expanded'),
    item.textContent?.match(/Run #\d+/)?.[0] ?? null,
  ]);
const results = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent === 'Results',
  );
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

it('the Results filter keeps only run-made files with their run, and clearing it restores the tree', async () => {
  const container = await panel();
  await act(async () =>
    container.querySelector<HTMLElement>('[role="treeitem"][title="src"]')?.click(),
  );
  const full = [
    ['src', 'true', null],
    ['src/gen', 'false', null],
    ['src/app.ts', null, null],
    ['notes.txt', null, null],
    ['README.md', null, null],
  ];
  expect(rows(container)).toEqual(full);
  // Nothing is read for run results until they are asked for.
  expect(fixture.fileOperations).not.toHaveBeenCalled();
  const toggle = results(container);
  expect(toggle?.getAttribute('aria-pressed')).toBe('false');
  await act(async () => toggle?.click());
  await settle();
  expect(toggle?.getAttribute('aria-pressed')).toBe('true');
  expect(fixture.changes).toHaveBeenCalledWith('session', { kind: 'session' });
  expect(rows(container)).toEqual([
    ['src', 'true', null],
    ['src/gen', 'true', null],
    ['src/gen/out.ts', null, 'Run #2'],
    ['notes.txt', null, 'Run #1'],
  ]);
  await act(async () => toggle?.click());
  expect(rows(container)).toEqual(full);
});

it('an unattributed file never shows a run label', async () => {
  fixture.files = {
    ...fixture.files,
    list: { files: [file('orphan.txt'), file('README.md'), file('notes.txt')], truncated: false },
  };
  fixture.changes.mockResolvedValue({
    from: 'base',
    to: 'now',
    unavailable: null,
    files: [
      changed('orphan.txt', 'managed_agent'),
      changed('README.md', 'external_observed'),
      // Run 1 wrote it, but its content changed afterwards.
      changed('notes.txt', 'mixed'),
    ],
  });
  const container = await panel();
  expect(rows(container).every(([, , label]) => label === null)).toBe(true);
  await act(async () => results(container)?.click());
  await settle();
  // A run that is not one of this session's numbered runs gets no made-up number.
  expect(rows(container)).toEqual([['orphan.txt', null, null]]);
});

it('a failed read of run results shows no files rather than guessing', async () => {
  fixture.fileOperations.mockRejectedValue(new Error('offline'));
  const container = await panel();
  await act(async () => results(container)?.click());
  await settle();
  expect(rows(container)).toEqual([]);
  expect(container.textContent).toContain(messages.Files.resultsFailed);
});

it('offers the Results filter only for the session copy', async () => {
  fixture.files = { ...fixture.files, scope: { kind: 'project', id: 'project' } };
  const container = await panel();
  expect(results(container)).toBeUndefined();
});
