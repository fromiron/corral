// @vitest-environment jsdom
import { act, useState } from 'react';
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
vi.mock('../services.tsx', () => {
  const services = { mode: 'server', workspaces: {} };
  return { useServices: () => services };
});
vi.mock('../pages/Workbench.tsx', () => ({
  useRemembered: (_key: string, initial: unknown) => useState(initial),
}));
vi.mock('./useWorkspaceFiles.ts', () => ({ useWorkspaceFiles: () => fixture.files }));
vi.mock('./documents/store.ts', () => {
  const owner = { getState: () => fixture.state, subscribe: () => () => {}, open: fixture.open };
  return { documentStore: () => owner };
});
vi.mock('./DocumentPanel.tsx', () => ({ DocumentPanel: () => <div data-inline-editor /> }));
vi.mock('./TerminalPanel.tsx', () => ({ TerminalPanel: () => <div data-tool="terminal" /> }));
vi.mock('./PreviewLeases.tsx', () => ({ PreviewLeases: () => <div data-tool="preview" /> }));
vi.mock('./WorktreeCommandPanel.tsx', () => ({
  WorktreeCommandPanel: () => <div data-tool="command" />,
}));
vi.mock('./ServicePreview.tsx', () => ({ ServicePreview: () => <div data-tool="service" /> }));
vi.mock('./navigation.ts', () => ({
  useSettingsNavigation: () => ({ link: () => ({ to: '/' }) }),
}));
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: () => ({
    getVirtualItems: () => [{ index: 0, start: 0, size: 30 }],
    getTotalSize: () => 30,
  }),
}));

it('[TC-WBD-006-H] a user selection opens the canonical document once and background refresh does not refocus it', async () => {
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
            showTools={false}
          />
        </IntlProvider>,
      );
    });
  try {
    await render();
    expect(container.querySelector('[data-tool]')).toBeNull();
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
