// @vitest-environment jsdom
import type { FileEditProposalSummary, TextRange, WorkspaceTarget } from '@corral/contracts';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { DocumentPanel } from './DocumentPanel.tsx';
import type { DocumentBuffer, DocumentStore } from './documents/store.ts';
import type { FileEditClient } from './EditProposalReview.tsx';

Element.prototype.getAnimations ??= () => [];

// The editor reports what the head asked of it; selecting a range is one click.
const editor = vi.hoisted(() => ({
  props: {} as {
    revealRange?: { startLine: number; endLine: number };
    tabFocusRequest?: number;
  },
}));
vi.mock('./documents/CodeEditorView.tsx', () => ({
  CodeEditorView: (props: {
    revealRange?: { startLine: number; endLine: number };
    tabFocusRequest?: number;
    onSelection?: (start: number, end: number, selection: TextRange | null) => void;
  }) => {
    editor.props = props;
    return (
      <button
        type="button"
        onClick={() =>
          props.onSelection?.(1, 1, { startLine: 1, startColumn: 1, endLine: 1, endColumn: 4 })
        }
      >
        Select code
      </button>
    );
  },
}));
vi.mock('../services.tsx', () => ({ useServices: () => ({ mode: 'server' }) }));
vi.mock('./context/bridge.ts', () => ({ beginAttachmentCapture: vi.fn(() => ({})) }));

const target: WorkspaceTarget = {
  hostId: 'host',
  projectId: 'project',
  bindingId: 'binding',
  sessionId: 'session',
  copyGeneration: 1,
};
function buffer(overrides: Partial<DocumentBuffer> = {}): DocumentBuffer {
  return {
    key: 'document',
    target,
    path: 'src/notes/today.md',
    text: 'one\ntwo\nthree\nfour',
    baseText: 'one\ntwo\nthree\nfour',
    baseHash: 'a'.repeat(64),
    file: {
      target,
      path: 'src/notes/today.md',
      content: { kind: 'text', text: 'one\ntwo\nthree\nfour' },
      writable: true,
      version: null,
    },
    model: { getEOL: () => '\n' } as unknown as NonNullable<DocumentBuffer['model']>,
    editVersion: 1,
    dirty: false,
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
    ...overrides,
  };
}
const summary = (overrides: Partial<FileEditProposalSummary>) =>
  ({
    proposalId: 'proposal',
    target,
    title: 'Rename',
    dismissed: false,
    operationId: null,
    files: [],
    ...overrides,
  }) as unknown as FileEditProposalSummary;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
});

async function mount(
  entry: DocumentBuffer,
  props: { edits?: FileEditClient; onReference?: () => void; onAttach?: () => void } = {},
) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const owner = Object.assign(
    createStore(() => ({ documents: { document: entry } as Record<string, DocumentBuffer> })),
    {
      retainView: () => () => {},
      refresh: vi.fn(async () => {}),
      save: vi.fn(async () => true),
    },
  ) as unknown as DocumentStore & {
    refresh: ReturnType<typeof vi.fn>;
    save: ReturnType<typeof vi.fn>;
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <DocumentPanel owner={owner} documentKey="document" viewId="view" fill {...props} />
      </IntlProvider>,
    ),
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  const button = (name: string) =>
    [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.textContent === name || node.getAttribute('aria-label') === name,
    );
  const openMenu = async () => {
    await act(async () =>
      container
        .querySelector<HTMLElement>('[aria-label="More actions for src/notes/today.md"]')
        ?.click(),
    );
    return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  };
  const choose = async (name: string) => {
    const row = (await openMenu()).find((node) => node.getAttribute('aria-label') === name);
    expect(row, name).toBeDefined();
    expect(row?.getAttribute('aria-disabled')).not.toBe('true');
    await act(async () => row?.click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
  };
  const popover = (name: string) =>
    document.querySelector<HTMLElement>(`[role="dialog"][aria-label="${name}"]`);
  const fill = async (label: string, value: number) => {
    const field = [...document.querySelectorAll<HTMLLabelElement>('[role="dialog"] label')]
      .find((node) => node.textContent === label)
      ?.querySelector('input');
    expect(field, label).toBeDefined();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        field,
        String(value),
      );
      field?.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const submit = async (name: string) => {
    const action = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
      (node) => node.textContent === name,
    );
    expect(action, name).toBeDefined();
    await act(async () => action?.click());
    return action;
  };
  return { container, owner, button, openMenu, choose, popover, fill, submit };
}

it('the head is one row and leaves no helper sentences on the document', async () => {
  const view = await mount(buffer());
  const head = view.container.querySelector('[data-testid="document-header"]');
  expect(head?.textContent).toContain('today.md');
  expect(head?.textContent).toContain(messages.Desktop.sessionCopy);
  const text = view.container.textContent ?? '';
  for (const helper of [
    messages.Desktop.referencePermission,
    messages.Documents.dirtyReference,
    messages.Documents.otherSessionReference,
    'Ctrl+M (Control+Shift+M on Mac)',
    messages.Desktop.fromLine,
    messages.Desktop.toLine,
  ])
    expect(text).not.toContain(helper);
});

it('Save follows the unsaved state', async () => {
  const clean = await mount(buffer());
  expect(clean.button('Save')?.disabled).toBe(true);
  expect(clean.container.querySelector('[role="status"]')?.textContent).toBe(
    messages.Documents.saved,
  );
  const dirty = await mount(buffer({ dirty: true, text: 'one\ntwo!' }));
  const save = dirty.button('Save');
  expect(save?.disabled).toBe(false);
  expect(dirty.container.querySelector('[role="status"]')?.textContent).toBe(
    messages.Documents.dirty,
  );
  await act(async () => save?.click());
  expect(dirty.owner.save).toHaveBeenCalledWith('document');
});

it('every moved action is a named row of the more menu and calls its handler', async () => {
  const onAttach = vi.fn();
  const edits = {
    fileEditProposals: vi.fn(async () => []),
  } as unknown as FileEditClient;
  const view = await mount(buffer(), { edits, onReference: () => {}, onAttach });
  const rows = (await view.openMenu()).map((row) => row.getAttribute('aria-label'));
  expect(rows).toEqual([
    messages.Documents.refresh,
    messages.EditProposals.history,
    messages.Documents.goToLinesMenu,
    messages.Documents.referenceLinesMenu,
    messages.Documents.attachSelection,
    `${messages.Documents.tabFocus}, Ctrl+M`,
  ]);
  await act(async () => document.body.click());
  await view.choose(messages.Documents.refresh);
  expect(view.owner.refresh).toHaveBeenCalledWith('document');
  await view.choose(`${messages.Documents.tabFocus}, Ctrl+M`);
  expect(editor.props.tabFocusRequest).toBe(1);
  // Attaching needs a selection; once there is one, the row captures it.
  const attach = (await view.openMenu()).find(
    (row) => row.getAttribute('aria-label') === messages.Documents.attachSelection,
  );
  expect(attach?.getAttribute('aria-disabled')).toBe('true');
  await act(async () => document.body.click());
  await act(async () => view.button('Select code')?.click());
  vi.stubGlobal('crypto', { subtle: { digest: async () => new Uint8Array(32).buffer } });
  await view.choose(messages.Documents.attachSelection);
  expect(onAttach).toHaveBeenCalledTimes(1);
  expect(onAttach.mock.calls[0]?.[0]).toMatchObject({ text: 'one' });
  await view.choose(messages.EditProposals.history);
  expect(edits.fileEditProposals).toHaveBeenCalledWith('session');
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
    messages.EditProposals.empty,
  );
});

it('go to lines and reference lines submit the range typed in their popover', async () => {
  const onReference = vi.fn();
  const view = await mount(buffer(), { onReference });
  await view.choose(messages.Documents.goToLinesMenu);
  expect(view.popover(messages.Documents.goToLines)).not.toBeNull();
  await view.fill(messages.Desktop.fromLine, 2);
  await view.fill(messages.Desktop.toLine, 3);
  await view.submit(messages.Documents.goToLines);
  expect(editor.props.revealRange).toEqual({ startLine: 2, endLine: 3 });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
  await view.choose(messages.Documents.referenceLinesMenu);
  const reference = view.popover(messages.Desktop.referenceLines);
  expect(reference?.textContent).toContain(messages.Desktop.referencePermission);
  // The range typed before stays with the document.
  await view.fill(messages.Desktop.toLine, 4);
  await view.submit(messages.Desktop.referenceLines);
  expect(onReference).toHaveBeenCalledExactlyOnceWith({
    path: 'src/notes/today.md',
    start: 2,
    end: 4,
  });
});

it('an unsaved document says why its lines cannot be referenced, only when asked', async () => {
  const onReference = vi.fn();
  const view = await mount(buffer({ dirty: true, text: 'one\ntwo' }), { onReference });
  expect(view.container.textContent).not.toContain(messages.Documents.dirtyReference);
  await view.choose(messages.Documents.referenceLinesMenu);
  const reference = view.popover(messages.Desktop.referenceLines);
  expect(reference?.textContent).toContain(messages.Documents.dirtyReference);
  expect((await view.submit(messages.Desktop.referenceLines))?.disabled).toBe(true);
  expect(onReference).not.toHaveBeenCalled();
});

it('counts only this copy’s proposals still waiting for review', async () => {
  const edits = {
    fileEditProposals: vi.fn(async () => [
      summary({ proposalId: 'a' }),
      summary({ proposalId: 'b' }),
      summary({ proposalId: 'dismissed', dismissed: true }),
      summary({ proposalId: 'applied', operationId: 'operation' }),
      summary({ proposalId: 'other', target: { ...target, copyGeneration: 2 } }),
    ]),
  } as unknown as FileEditClient;
  const view = await mount(buffer(), { edits });
  expect(view.button('2 edit proposals to review')).toBeDefined();
  const none = await mount(buffer(), {
    edits: { fileEditProposals: vi.fn(async () => []) } as unknown as FileEditClient,
  });
  expect(none.container.querySelector('[aria-label$="to review"]')).toBeNull();
});
