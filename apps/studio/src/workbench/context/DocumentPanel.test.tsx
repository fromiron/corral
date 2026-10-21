// @vitest-environment jsdom
import type { TextRange } from '@corral/contracts';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import messages from '../../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { DocumentPanel } from '../DocumentPanel.tsx';
import type { DocumentBuffer, DocumentStore } from '../documents/store.ts';

const capture = vi.hoisted(() => ({
  target: { hostId: 'host', projectId: 'project', sessionId: 'session' },
  revision: 7,
}));
vi.mock('./bridge.ts', () => ({ beginAttachmentCapture: vi.fn(() => capture) }));
vi.mock('../documents/CodeEditorView.tsx', () => ({
  CodeEditorView: ({
    onSelection,
    revealSelection,
  }: {
    onSelection?: (start: number, end: number, selection: TextRange | null) => void;
    revealSelection?: TextRange;
  }) => (
    <button
      type="button"
      data-reveal={JSON.stringify(revealSelection)}
      onClick={() =>
        onSelection?.(1, 1, { startLine: 1, startColumn: 1, endLine: 1, endColumn: 9 })
      }
    >
      Select code
    </button>
  ),
}));

it('[TC-WBD-007-N] dirty confirmation and retries keep the selected text and original capture ticket', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('crypto', { subtle: { digest: async () => new Uint8Array(32).buffer } });
  const target = { ...capture.target, bindingId: 'binding', copyGeneration: 1 };
  const entry: DocumentBuffer = {
    key: 'document',
    target,
    path: 'example.ts',
    text: 'captured\nother',
    baseText: 'base',
    baseHash: 'a'.repeat(64),
    file: {
      target,
      path: 'example.ts',
      content: { kind: 'text', text: 'base' },
      writable: true,
      version: null,
    },
    model: { getEOL: () => '\n' } as unknown as NonNullable<DocumentBuffer['model']>,
    editVersion: 4,
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
  const owner = Object.assign(
    createStore(() => ({ documents: { document: entry } })),
    { retainView: () => () => {} },
  ) as unknown as DocumentStore;
  const onAttach = vi
    .fn()
    .mockRejectedValueOnce(new Error('Keep capture'))
    .mockResolvedValue(undefined);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const click = async (text: string) => {
    await act(async () => {
      const button = Array.from(document.querySelectorAll('button')).find(
        (item) => item.textContent === text,
      );
      expect(button).toBeDefined();
      button?.click();
    });
  };
  try {
    await act(async () => {
      root.render(
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <DocumentPanel
            owner={owner}
            documentKey="document"
            viewId="view"
            onAttach={onAttach}
            revealSelection={{ startLine: 1, startColumn: 1, endLine: 1, endColumn: 9 }}
          />
        </IntlProvider>,
      );
    });
    expect(container.querySelector('[data-reveal]')?.getAttribute('data-reveal')).toBe(
      JSON.stringify({ startLine: 1, startColumn: 1, endLine: 1, endColumn: 9 }),
    );
    await click('Select code');
    await click('Attach selected code');
    expect(onAttach).not.toHaveBeenCalled();
    expect(document.querySelector('textarea[aria-label="Captured selection"]')?.textContent).toBe(
      'captured',
    );
    await act(async () => {
      owner.setState({
        documents: { document: { ...entry, text: 'later draft', editVersion: 5 } },
      });
    });
    await click('Add captured text');
    expect(document.querySelector('textarea[aria-label="Captured selection"]')?.textContent).toBe(
      'captured',
    );
    await click('Add captured text');
    expect(onAttach).toHaveBeenCalledTimes(2);
    expect(onAttach.mock.calls[0]?.[0]).toMatchObject({
      text: 'captured',
      provenance: { editVersion: 4, snapshot: 'draft' },
    });
    expect(onAttach.mock.calls[0]?.[1]).toBe(capture);
    expect(onAttach.mock.calls[1]?.[0]).toBe(onAttach.mock.calls[0]?.[0]);
    expect(onAttach.mock.calls[1]?.[1]).toBe(capture);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
