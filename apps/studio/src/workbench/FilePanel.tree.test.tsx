// @vitest-environment jsdom
import { SizeScope } from '@corral/react/design-kit';
import { act, type ReactNode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { FilePanel } from './FilePanel.tsx';

const fixture = vi.hoisted(() => ({
  target: {
    hostId: 'local',
    projectId: 'project',
    bindingId: 'binding',
    sessionId: 'session',
    copyGeneration: 3,
  },
  state: { documents: {} as Record<string, unknown> },
  open: vi.fn(async (_session: string, path: string) => `key:${path}`),
  listFiles: vi.fn(async (_scope: unknown, _path?: string) => ({
    files: [] as { path: string; bytes: number }[],
    truncated: false,
  })),
  files: {
    scope: { kind: 'session', id: 'session' },
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
      readFile: async (_scope: unknown, path: string) => ({
        content: { kind: 'text', text: `body of ${path}` },
      }),
      listFiles: fixture.listFiles,
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
  const owner = {
    getState: () => fixture.state,
    subscribe: () => () => {},
    open: fixture.open,
    sessionRecoveries: async () => [],
  };
  return { documentStore: () => owner };
});
vi.mock('./DocumentPanel.tsx', () => ({ DocumentPanel: () => <div data-inline-editor /> }));
vi.mock('./PierreCode.tsx', () => ({
  SourceCode: ({ text }: { text: string }) => <pre data-source>{text}</pre>,
}));
vi.mock('./navigation.ts', () => ({
  useSettingsNavigation: () => ({ link: () => ({ to: '/' }) }),
}));
// Every row renders: jsdom has no layout for the virtualizer to measure.
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
const roots: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of roots.splice(0)) await dispose();
  vi.unstubAllGlobals();
});
async function panel(onOpenDocument = vi.fn(() => true), density?: 'default' | 'compact') {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const render = () =>
    act(async () => {
      root.render(
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <SizeScope size={density}>
            <FilePanel
              projectId="project"
              sessionId="session"
              onReference={() => {}}
              onOpenDocument={onOpenDocument}
            />
          </SizeScope>
        </IntlProvider>,
      );
    });
  await render();
  return { container, onOpenDocument, render };
}
const tree = (container: HTMLElement) => container.querySelector<HTMLElement>('[role="tree"]');
const items = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')].map(
    (item) => item.getAttribute('title') ?? '',
  );
const focused = () => document.activeElement?.getAttribute('title');
const press = (key: string) =>
  act(async () => {
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });

it('arrow keys, Home and End move through visible rows; Enter opens a file', async () => {
  fixture.listFiles.mockClear();
  fixture.open.mockClear();
  fixture.state = { documents: {} };
  fixture.files = {
    ...fixture.files,
    list: {
      files: [file('README.md'), file('src/app.ts'), file('src/lib/util.ts')],
      truncated: false,
    },
  };
  const { container, onOpenDocument } = await panel();
  expect(tree(container)).not.toBeNull();
  expect(items(container)).toEqual(['src', 'README.md']);
  const first = container.querySelector<HTMLElement>('[role="treeitem"][title="src"]');
  // One row takes Tab: the tree is one stop.
  expect(
    [...container.querySelectorAll('[role="treeitem"]')].filter(
      (item) => item.getAttribute('tabindex') === '0',
    ),
  ).toHaveLength(1);
  await act(async () => first?.focus());
  await press('ArrowRight');
  expect(first?.getAttribute('aria-expanded')).toBe('true');
  expect(items(container)).toEqual(['src', 'src/lib', 'src/app.ts', 'README.md']);
  await press('ArrowRight');
  expect(focused()).toBe('src/lib');
  await press('ArrowDown');
  expect(focused()).toBe('src/app.ts');
  await press('ArrowLeft');
  expect(focused()).toBe('src');
  await press('End');
  expect(focused()).toBe('README.md');
  await press('Home');
  expect(focused()).toBe('src');
  await press('ArrowLeft');
  expect(items(container)).toEqual(['src', 'README.md']);
  await press('ArrowDown');
  expect(focused()).toBe('README.md');
  fixture.state = {
    documents: {
      'key:README.md': {
        target: fixture.target,
        path: 'README.md',
        file: { content: { kind: 'text', text: 'hello' } },
        dirty: false,
        pendingSave: null,
        recoveries: [],
      },
    },
  };
  await press('Enter');
  expect(fixture.open).toHaveBeenCalledWith('session', 'README.md');
  expect(onOpenDocument).toHaveBeenCalledWith({
    documentKey: 'key:README.md',
    target: fixture.target,
    path: 'README.md',
  });
  // A complete listing already holds every folder: expanding reads nothing more.
  expect(fixture.listFiles).not.toHaveBeenCalled();
});

it('a truncated listing reads a folder only when it is expanded, and marks what was cut', async () => {
  fixture.listFiles.mockClear();
  fixture.files = {
    ...fixture.files,
    list: { files: [file('a/one.ts'), file('b/two.ts')], truncated: true },
  };
  fixture.listFiles.mockImplementation(async (_scope, path) =>
    path === 'b'
      ? { files: [file('b/two.ts'), file('b/three.ts')], truncated: true }
      : { files: [], truncated: false },
  );
  const { container } = await panel();
  expect(container.textContent).toContain(messages.Desktop.filesTruncated);
  expect(fixture.listFiles).not.toHaveBeenCalled();
  const folder = container.querySelector<HTMLElement>('[role="treeitem"][title="b"]');
  await act(async () => folder?.click());
  expect(fixture.listFiles).toHaveBeenCalledTimes(1);
  expect(fixture.listFiles).toHaveBeenCalledWith({ kind: 'session', id: 'session' }, 'b');
  expect(items(container)).toEqual(['a', 'b', 'b/three.ts', 'b/two.ts']);
  expect(folder?.textContent).toContain(messages.Files.folderTruncated);
  // Collapsing and expanding again reuses what was read.
  await act(async () => folder?.click());
  await act(async () => folder?.click());
  expect(fixture.listFiles).toHaveBeenCalledTimes(1);
});

it('a folder read that returns after a refresh is dropped', async () => {
  fixture.listFiles.mockClear();
  fixture.files = {
    ...fixture.files,
    list: { files: [file('a/one.ts')], truncated: true },
  };
  const pending: ((value: {
    files: { path: string; bytes: number }[];
    truncated: boolean;
  }) => void)[] = [];
  fixture.listFiles.mockImplementation(
    () =>
      new Promise((resolve) => {
        pending.push(resolve);
      }),
  );
  const { container, render } = await panel();
  await act(async () =>
    container.querySelector<HTMLElement>('[role="treeitem"][title="a"]')?.click(),
  );
  expect(container.querySelector('[role="treeitem"][title="a"]')?.getAttribute('aria-busy')).toBe(
    'true',
  );
  // The listing refreshes (a change notification) before the folder read answers.
  fixture.files = { ...fixture.files, list: { files: [file('a/one.ts')], truncated: true } };
  await render();
  // The open folder is read again for the new listing.
  expect(fixture.listFiles).toHaveBeenCalledTimes(2);
  await act(async () => pending[0]?.({ files: [file('a/stale.ts')], truncated: false }));
  expect(items(container)).not.toContain('a/stale.ts');
  await act(async () =>
    pending[1]?.({ files: [file('a/one.ts'), file('a/new.ts')], truncated: false }),
  );
  expect(items(container)).toEqual(['a', 'a/new.ts', 'a/one.ts']);
});

it('the filter keeps the tree and still opens files', async () => {
  fixture.files = {
    ...fixture.files,
    list: {
      files: [file('README.md'), file('other.txt'), file('docs/readme.md')],
      truncated: false,
    },
  };
  const { container } = await panel();
  const input = container.querySelector<HTMLInputElement>(
    `input[aria-label="${messages.Desktop.filterFiles}"]`,
  );
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    set?.call(input, 'readme');
    input?.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(items(container)).toEqual(['docs', 'docs/readme.md', 'README.md']);
  expect(tree(container)).not.toBeNull();
});

// Settings › General › Interface density reaches the Files view (workbench.md).
it('the Files toolbar and its filter take the interface density', async () => {
  fixture.state = { documents: {} };
  fixture.files = { ...fixture.files, list: { files: [file('README.md')], truncated: false } };
  const sizes = async (density: 'default' | 'compact') => {
    const { container } = await panel(undefined, density);
    return [
      container.querySelector<HTMLElement>(`button[aria-label="${messages.Desktop.refreshFiles}"]`)
        ?.dataset.size,
      container
        .querySelector<HTMLElement>(`input[aria-label="${messages.Desktop.filterFiles}"]`)
        ?.closest<HTMLElement>('[data-slot="input-control"]')?.dataset.size,
    ];
  };
  expect(await sizes('default')).toEqual(['icon', 'default']);
  expect(await sizes('compact')).toEqual(['icon-compact', 'compact']);
});
