// @vitest-environment jsdom
import { act, type ReactNode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { expect, it, vi } from 'vitest';
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
  open: vi.fn(async () => 'canonical-key'),
  files: {
    scope: { kind: 'session', id: 'session' },
    list: { files: [{ path: 'note.txt' }], truncated: false },
    hasCopy: true,
    copy: { bindingId: 'binding', copyGeneration: 3 },
    loading: false,
    error: null,
    refresh() {},
  },
}));
const readFile = vi.hoisted(() =>
  vi.fn(async (_scope: unknown, path: string) => ({
    content: { kind: 'text', text: `body of ${path}` },
  })),
);
vi.mock('../services.tsx', () => {
  const services = { mode: 'server', workspaceId: 'local', workspaces: { readFile } };
  return { useServices: () => services };
});
vi.mock('../pages/Workbench.tsx', () => ({
  useRemembered: (_key: string, initial: unknown) => useState(initial),
}));
vi.mock('./useWorkspaceFiles.ts', () => ({
  useWorkspaceFiles: (_project: string, _session: string, source?: string) => ({
    ...fixture.files,
    scope: source
      ? { kind: source, id: source === 'session' ? 'session' : 'project' }
      : fixture.files.scope,
  }),
}));
vi.mock('@corral/react/design-kit', async (original) => ({
  ...(await original<typeof import('@corral/react/design-kit')>()),
  Select: ({
    label,
    value,
    options,
    onValueChange,
  }: {
    label: string;
    value: string;
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
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    params,
    search,
    children,
    ...props
  }: {
    to: string;
    params?: { sessionId: string };
    search?: Record<string, string>;
    children?: ReactNode;
  }) => (
    <a
      {...props}
      href={`${to.replace('$sessionId', params?.sessionId ?? '')}${search ? `?${new URLSearchParams(search)}` : ''}`}
    >
      {children}
    </a>
  ),
}));
vi.mock('./ContentSearch.tsx', () => ({
  ContentSearch: ({ target }: { target: { sessionId: string } }) => (
    <div data-search-session={target.sessionId} />
  ),
}));
vi.mock('./documents/store.ts', () => {
  const owner = { getState: () => fixture.state, subscribe: () => () => {}, open: fixture.open };
  return { documentStore: () => owner };
});
vi.mock('./DocumentPanel.tsx', () => ({ DocumentPanel: () => <div data-inline-editor /> }));
vi.mock('./PierreCode.tsx', () => ({
  SourceCode: ({ text }: { text: string }) => <pre data-source>{text}</pre>,
}));
vi.mock('./navigation.ts', () => ({
  useSettingsNavigation: () => ({ link: () => ({ to: '/' }) }),
}));
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: () => ({
    getVirtualItems: () => [{ index: 0, start: 0, size: 30 }],
    getTotalSize: () => 30,
  }),
}));

it('a user selection opens the canonical document once and background refresh does not refocus it', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.open.mockClear();
  fixture.state = {
    documents: {
      'canonical-key': {
        target: fixture.target,
        path: 'note.txt',
        file: { content: { kind: 'text', text: 'saved' } },
        dirty: false,
        pendingSave: null,
        recoveries: [],
      },
    },
  };
  const onOpenDocument = vi.fn(() => true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const render = () =>
    act(async () => {
      root.render(
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <FilePanel
            projectId="project"
            sessionId="session"
            onReference={() => {}}
            onOpenDocument={onOpenDocument}
          />
        </IntlProvider>,
      );
    });
  try {
    await render();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[title="note.txt"]')?.click();
    });
    expect(fixture.open).toHaveBeenCalledTimes(1);
    expect(onOpenDocument).toHaveBeenCalledWith({
      documentKey: 'canonical-key',
      target: fixture.target,
      path: 'note.txt',
    });
    expect(container.querySelector('[data-inline-editor]')).toBeNull();
    fixture.files = { ...fixture.files, list: { ...fixture.files.list } };
    await render();
    expect(onOpenDocument).toHaveBeenCalledTimes(1);
    expect(fixture.open).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

const sessionFiles = fixture.files;
async function panel(
  onOpenDocument: () => boolean,
  check: (container: HTMLDivElement) => Promise<void>,
) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <FilePanel
            projectId="project"
            sessionId="session"
            onReference={() => {}}
            onOpenDocument={onOpenDocument}
          />
        </IntlProvider>,
      );
    });
    await check(container);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
}
const click = (container: HTMLElement, title: string) =>
  act(async () => {
    container.querySelector<HTMLButtonElement>(`button[title="${title}"]`)?.click();
  });

it('a session-copy file opens as a document tab whatever it holds, so Files keeps no tab strip of its own (#87)', async () => {
  fixture.files = sessionFiles;
  fixture.open.mockClear();
  fixture.state = {
    documents: {
      'canonical-key': {
        target: fixture.target,
        path: 'note.txt',
        file: { content: { kind: 'binary' } },
        dirty: false,
        pendingSave: null,
        recoveries: [],
      },
    },
  };
  const onOpenDocument = vi.fn(() => true);
  await panel(onOpenDocument, async (container) => {
    await click(container, 'note.txt');
    expect(onOpenDocument).toHaveBeenCalledWith({
      documentKey: 'canonical-key',
      target: fixture.target,
      path: 'note.txt',
    });
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    expect(container.querySelector('[data-inline-editor]')).toBeNull();
  });
});

it('an original-folder file previews read-only inside Files, one at a time (#87)', async () => {
  fixture.files = {
    ...sessionFiles,
    scope: { kind: 'project', id: 'project' },
    list: { files: [{ path: 'a.md' }], truncated: false },
    hasCopy: false,
    copy: null,
  } as unknown as typeof sessionFiles;
  fixture.open.mockClear();
  const onOpenDocument = vi.fn(() => true);
  await panel(onOpenDocument, async (container) => {
    await click(container, 'a.md');
    expect(onOpenDocument).not.toHaveBeenCalled();
    expect(fixture.open).not.toHaveBeenCalled();
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    const preview = container.querySelector('[data-testid="file-preview-pane"]');
    expect(preview?.textContent).toContain('a.md');
    expect(preview?.textContent).toContain(messages.Files.readOnlyPreview);
    expect(preview?.querySelector('[data-source]')?.textContent).toBe('body of a.md');
    await act(async () => {
      preview?.querySelector<HTMLButtonElement>('button[aria-label="Close a.md"]')?.click();
    });
    expect(container.querySelector('[data-testid="file-preview-pane"]')).toBeNull();
  });
  fixture.files = sessionFiles;
});

it.each([false, true])(
  'content search offers preparation or selection without creating a copy (exists: %s)',
  async (hasCopy) => {
    fixture.files = {
      ...sessionFiles,
      scope: { kind: 'project', id: 'project' },
      hasCopy,
      copy: hasCopy ? sessionFiles.copy : null,
    } as typeof sessionFiles;
    fixture.state = { documents: {} };
    await panel(
      () => true,
      async (container) => {
        await act(async () => {
          const mode = container.querySelector<HTMLSelectElement>(
            `select[aria-label="${messages.ContentSearch.mode}"]`,
          );
          if (!mode) throw new Error('Content search mode is missing');
          mode.value = 'contents';
          mode.dispatchEvent(new Event('change', { bubbles: true }));
        });
        if (hasCopy) {
          const select = [...container.querySelectorAll('button')].find(
            (button) => button.textContent === 'Select working copy',
          );
          expect(select).toBeDefined();
          await act(async () => select?.click());
          expect(container.querySelector('[data-search-session="session"]')).not.toBeNull();
        } else {
          expect(
            container.querySelector('a[href="/sessions/session?panel=changes"]')?.textContent,
          ).toBe('Prepare working copy');
          expect(container.querySelector('[data-search-session]')).toBeNull();
        }
      },
    );
    fixture.files = sessionFiles;
  },
);
