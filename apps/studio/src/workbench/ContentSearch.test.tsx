// @vitest-environment jsdom
import type { ContentSearchResult, FileDocument, WorkspaceTarget } from '@corral/contracts';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { ContentSearch } from './ContentSearch.tsx';
import type { DocumentStore } from './documents/store.ts';

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, start: index * 52, size: 52 })),
    getTotalSize: () => count * 52,
  }),
}));
const target: WorkspaceTarget = {
  hostId: 'host',
  projectId: 'project',
  bindingId: 'binding',
  sessionId: 'session',
  copyGeneration: 1,
};
const match = {
  path: 'src/한글 파일.ts',
  sha256: 'a'.repeat(64),
  range: { startLine: 2, startColumn: 3, endLine: 2, endColumn: 8 },
  preview: '  greet(name);',
};
const file = {
  target,
  path: match.path,
  content: { kind: 'text', text: 'saved' },
  version: { sha256: match.sha256 },
} as FileDocument;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
});
async function mount() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const api = {
    searchContents: vi.fn(
      async (
        _session: string,
        input: { queryId: string; query: string; caseSensitive: boolean },
        _signal?: AbortSignal,
      ): Promise<ContentSearchResult> => ({
        target,
        queryId: input.queryId,
        query: input.query,
        caseSensitive: input.caseSensitive,
        matches: [match],
        scannedFiles: 2,
        skippedFiles: 1,
        truncated: false,
      }),
    ),
    readDocument: vi.fn(async () => file),
  };
  const entry = {
    key: 'document',
    target,
    path: match.path,
    baseHash: match.sha256,
    dirty: false,
    pendingSave: null,
    text: 'saved',
  };
  const owner = {
    open: vi.fn(async () => 'document'),
    getState: () => ({ documents: { document: entry } }),
  } as unknown as DocumentStore;
  const open = vi.fn(() => true);
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  const render = (value = target) =>
    act(async () =>
      root.render(
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <ContentSearch api={api} owner={owner} target={value} onOpenDocument={open} />
        </IntlProvider>,
      ),
    );
  cleanups.push(async () => {
    await act(async () => root.unmount());
    element.remove();
  });
  await render();
  const query = async (value: string) =>
    act(async () => {
      const input = element.querySelector<HTMLInputElement>('input[type="text"]')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  const search = async () =>
    act(async () => {
      element
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
  const clickResult = async () =>
    act(async () => {
      [...element.querySelectorAll('button')]
        .find((button) => button.textContent?.includes(match.path))
        ?.click();
    });
  return { api, entry, owner, open, element, render, query, search, clickResult };
}
it('[TC-WBD-019-H] searches saved content and opens the existing document with the exact range', async () => {
  const f = await mount();
  await f.query('greet');
  await f.search();
  expect(f.element.textContent).toContain(messages.ContentSearch.diskOnly);
  expect(f.element.textContent).toContain('1 matches in 2 files');
  f.entry.baseHash = 'c'.repeat(64);
  f.owner.refresh = vi.fn(async () => {
    f.entry.baseHash = match.sha256;
  });
  await f.clickResult();
  expect(f.owner.refresh).toHaveBeenCalledWith('document');
  expect(f.api.readDocument).toHaveBeenCalledWith('session', match.path);
  expect(f.open).toHaveBeenCalledWith(
    { documentKey: 'document', target, path: match.path },
    match.range,
  );
});
it('[TC-WBD-019-F] cancels requests and prevents late search or open responses from crossing query and copy changes', async () => {
  const f = await mount();
  let resolve!: (result: ContentSearchResult) => void;
  f.api.searchContents.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await f.query('first');
  await f.search();
  const [, input, signal] = f.api.searchContents.mock.calls[0]!;
  await f.query('second');
  expect(signal?.aborted).toBe(true);
  await act(async () =>
    resolve({
      target,
      queryId: input.queryId,
      query: input.query,
      caseSensitive: input.caseSensitive,
      matches: [match],
      scannedFiles: 1,
      skippedFiles: 0,
      truncated: false,
    }),
  );
  expect(f.element.textContent).not.toContain(match.path);
  await f.search();
  let finishRead!: (file: FileDocument) => void;
  f.api.readDocument.mockImplementationOnce(
    () =>
      new Promise((done) => {
        finishRead = done;
      }),
  );
  await f.clickResult();
  await f.render({ ...target, copyGeneration: 2 });
  await act(async () => finishRead(file));
  expect(f.open).not.toHaveBeenCalled();
});
it('[TC-WBD-019-N] rejects stale disk results and preserves unsaved drafts without jumping to disk coordinates', async () => {
  const f = await mount();
  await f.query('greet');
  await f.search();
  f.api.readDocument.mockResolvedValueOnce({
    ...file,
    version: { ...file.version!, sha256: 'b'.repeat(64) },
  });
  await f.clickResult();
  expect(f.element.textContent).toContain(messages.ContentSearch.stale);
  expect(f.owner.open).not.toHaveBeenCalled();
  f.entry.dirty = true;
  f.entry.text = 'my unsaved draft';
  await f.clickResult();
  expect(f.element.textContent).toContain(messages.ContentSearch.draft);
  expect(f.entry.text).toBe('my unsaved draft');
  expect(f.open).not.toHaveBeenCalled();
});
