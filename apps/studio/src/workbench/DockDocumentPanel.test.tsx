// @vitest-environment jsdom
import type { WorkspaceTarget } from '@corral/contracts';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { DockDocumentPanel } from './DockDocumentPanel.tsx';
import { DocumentPanel } from './DocumentPanel.tsx';
import { type DocumentBuffer, type DocumentStore, documentKey } from './documents/store.ts';

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    params,
    title,
    children,
  }: {
    params: { sessionId: string };
    title?: string;
    children: ReactNode;
  }) => (
    <a href={`/sessions/${params.sessionId}`} title={title}>
      {children}
    </a>
  ),
}));

const target: WorkspaceTarget = {
  hostId: 'local',
  projectId: 'project',
  bindingId: 'binding',
  sessionId: 'session',
  copyGeneration: 1,
};
const key = documentKey(target, 'note.txt');
function buffer(): DocumentBuffer {
  return {
    key,
    target,
    path: 'note.txt',
    file: {
      target,
      path: 'note.txt',
      content: { kind: 'text', text: 'saved' },
      version: null,
      writable: true,
    },
    model: null,
    text: 'draft',
    baseText: 'saved',
    baseHash: null,
    editVersion: 1,
    dirty: true,
    saving: false,
    pendingSave: null,
    canRetrySave: false,
    conflict: null,
    formatBlocked: false,
    recoveries: [],
    otherRecoveries: [],
    recoverySavedVersion: null,
    recoveryError: null,
    modelError: null,
    error: null,
  };
}
function owner(documents: Record<string, DocumentBuffer>, openedKey: string) {
  return Object.assign(
    createStore(() => ({ documents })),
    {
      open: vi.fn(async () => openedKey),
      retainView: vi.fn(() => () => {}),
      sessionRecoveries: vi.fn(async () => []),
    },
  ) as unknown as DocumentStore;
}
async function mounted(content: React.ReactNode, check: (container: HTMLDivElement) => void) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          {content}
        </IntlProvider>,
      );
    });
    check(container);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
}

it('[TC-WBD-006-N] external tab ownership skips view retain and a missing conversation reference does not disable saving', async () => {
  const store = owner({ [key]: buffer() }, key);
  await mounted(
    <DocumentPanel owner={store} documentKey={key} viewId="dock-tab" manageView={false} />,
    (container) => {
      expect(store.retainView).not.toHaveBeenCalled();
      const buttons = Array.from(container.querySelectorAll('button'));
      expect(buttons.find((button) => button.textContent === 'Save')?.disabled).toBe(false);
      expect(buttons.find((button) => button.textContent === 'Reference lines')?.disabled).toBe(
        true,
      );
    },
  );
});

it('[TC-WBD-006-F] restoring an old generation cannot show the current copy under the old document tab', async () => {
  const newTarget = { ...target, copyGeneration: 2 };
  const newerKey = documentKey(newTarget, 'note.txt');
  const store = owner(
    { [newerKey]: { ...buffer(), key: newerKey, target: newTarget, text: 'new-copy-only' } },
    newerKey,
  );
  await mounted(
    <DockDocumentPanel owner={store} target={target} path="note.txt" viewId="dock-tab" />,
    (container) => {
      expect(container.querySelector('[data-testid="document-panel"]')).toBeNull();
      expect(container.textContent).not.toContain('new-copy-only');
      expect(store.sessionRecoveries).toHaveBeenCalledWith({
        hostId: 'local',
        projectId: 'project',
        sessionId: 'session',
      });
      expect(store.retainView).not.toHaveBeenCalled();
      expect(container.querySelector('a')?.getAttribute('href')).toBe('/sessions/session');
      expect(container.querySelector('[title="note.txt"]')?.textContent).toBe('note.txt');
    },
  );
});

it('[TC-WBD-006-N] a retained file cannot reference the current copy until target readback completes', async () => {
  const store = owner({ [key]: { ...buffer(), dirty: false, text: 'saved' } }, key);
  let finish!: (key: string) => void;
  vi.mocked(store.open).mockImplementation(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  try {
    await mounted(
      <DockDocumentPanel
        owner={store}
        target={target}
        path="note.txt"
        viewId="dock-tab"
        onReference={() => {}}
      />,
      (container) => {
        const reference = Array.from(container.querySelectorAll('button')).find(
          (button) => button.textContent === 'Reference lines',
        );
        expect(reference?.disabled).toBe(true);
        expect(container.querySelector('a')).toBeNull();
      },
    );
  } finally {
    finish(key);
  }
});
