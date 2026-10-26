// @vitest-environment jsdom
import type { WorkspacesApi } from '@corral/client';
import type { FileEditPreview, FileEditPreviewResult, LanguageSession } from '@corral/contracts';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import messages from '../../../../../packages/react/src/messages/en.json' with { type: 'json' };
import type { DocumentBuffer, DocumentStore } from '../documents/store.ts';
import { RefactorActions } from './RefactorActions.tsx';
import { type LanguageStore, languageCopyKey } from './store.ts';

vi.mock('../EditProposalReview.tsx', () => ({
  EditProposals: ({ proposal }: { proposal?: { title: string } | null }) => (
    <div data-review>{proposal?.title ?? 'History'}</div>
  ),
}));
const target = {
  hostId: 'host',
  projectId: 'project',
  bindingId: 'binding',
  sessionId: 'session',
  copyGeneration: 1,
};
const session: LanguageSession = {
  generation: 'generation',
  clientId: 'client',
  serverId: 'ts',
  configRevision: 1,
  fingerprint: 'a'.repeat(64),
  state: 'running',
  diagnostics: [],
  error: null,
  capabilities: {
    completion: true,
    definition: true,
    references: true,
    diagnostics: true,
    diagnosticPull: false,
    triggerCharacters: [],
    rename: true,
    codeActions: true,
  },
};
const scope = {
  target,
  generation: session.generation,
  clientId: session.clientId,
  path: 'file.ts',
  version: 1,
};
const result: FileEditPreviewResult = {
  unavailable: [],
  proposals: [
    {
      proposalId: 'proposal',
      target,
      title: 'Rename saved symbol',
      source: {
        kind: 'language',
        operation: 'rename',
        language: {
          generation: session.generation,
          clientId: session.clientId,
          serverId: session.serverId,
          configRevision: session.configRevision,
          fingerprint: session.fingerprint,
          path: scope.path,
          version: 1,
        },
      },
      files: [
        {
          path: scope.path,
          before: 'const oldName = 1;',
          beforeHash: 'b'.repeat(64),
          after: 'const nextName = 1;',
          afterHash: 'c'.repeat(64),
        },
      ],
      createdAt: '2026-10-23T00:00:00.000Z',
      hash: 'd'.repeat(64),
      dismissed: false,
      operationId: null,
    },
  ],
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
});
async function fixture() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const entry = {
    key: 'document',
    target,
    path: scope.path,
    text: 'const oldName = 1;',
    model: null,
    editVersion: 0,
    dirty: false,
    saving: false,
    pendingSave: null,
    conflict: null,
  } as DocumentBuffer;
  const owner = createStore(() => ({ documents: { document: entry } })) as unknown as DocumentStore;
  const copies = createStore(() => ({
    copies: {
      [languageCopyKey(target)]: {
        state: { target, available: true, unavailableReason: null, servers: [], session },
        inspection: null,
        error: null,
        busy: false,
      },
    },
  }));
  const editScope = vi.fn(async () => scope);
  const store = Object.assign(copies, {
    clientId: 'client',
    editScope,
    documentVersion: () => 1,
  }) as unknown as LanguageStore;
  const preview = vi.fn<
    (id: string, input: FileEditPreview, signal?: AbortSignal) => Promise<FileEditPreviewResult>
  >(async () => result);
  const api = { previewFileEdits: preview } as unknown as WorkspacesApi;
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <RefactorActions
          api={api}
          owner={owner}
          entry={entry}
          store={store}
          selection={{
            position: { line: 0, character: 7 },
            range: { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } },
          }}
        />
      </IntlProvider>,
    ),
  );
  cleanups.push(async () => {
    await act(async () => root.unmount());
    element.remove();
  });
  const click = async (label: string) => {
    const button = [...document.querySelectorAll('button')].find(
      (value) => value.textContent === label,
    );
    expect(button).toBeDefined();
    await act(async () => button?.click());
  };
  const rename = async () => {
    await click('Rename symbol');
    const input = document.querySelector<HTMLInputElement>('input');
    expect(input).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        'nextName',
      );
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  return { element, owner, copies, editScope, preview, click, rename };
}

it('a saved rename opens an immutable review and retry keeps the same request id', async () => {
  const view = await fixture();
  view.preview.mockRejectedValueOnce(new Error('response lost'));
  await view.rename();
  expect(document.querySelector('[role=dialog]')?.textContent).toContain('file.ts:1:8');
  await view.click('Review rename');
  await view.click('Review rename');
  expect(view.preview).toHaveBeenCalledTimes(2);
  const first = view.preview.mock.calls[0]?.[1];
  expect(first).toMatchObject({
    ...scope,
    kind: 'rename',
    position: { line: 0, character: 7 },
    newName: 'nextName',
  });
  expect(view.preview.mock.calls[1]?.[1]).toEqual(first);
  expect(view.element.querySelector('[data-review]')?.textContent).toBe('Rename saved symbol');
  expect(view.owner.getState().documents.document?.text).toBe('const oldName = 1;');
});

it('a dirty source never requests edits and a late generation cannot open a review', async () => {
  const view = await fixture();
  const original = view.owner.getState().documents.document;
  if (!original) throw new Error('missing fixture document');
  await act(async () =>
    view.owner.setState({ documents: { document: { ...original, dirty: true } } }),
  );
  await view.click('Rename symbol');
  expect(view.editScope).not.toHaveBeenCalled();
  expect(view.preview).not.toHaveBeenCalled();
  expect(document.querySelector('[role=dialog]')).toBeNull();
  await act(async () => view.owner.setState({ documents: { document: original } }));
  let resolve!: (value: FileEditPreviewResult) => void;
  view.preview.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await view.rename();
  await view.click('Review rename');
  await act(async () => {
    const copy = view.copies.getState().copies[languageCopyKey(target)];
    if (!copy) throw new Error('missing fixture copy');
    view.copies.setState({
      copies: {
        [languageCopyKey(target)]: {
          ...copy,
          state: { ...copy.state, session: { ...session, generation: 'later-generation' } },
        },
      },
    });
  });
  await act(async () => resolve(result));
  expect(view.element.querySelector('[data-review]')?.textContent).toBe('History');
  expect(view.preview.mock.calls[0]?.[2]?.aborted).toBe(true);
});
