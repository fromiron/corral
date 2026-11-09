// @vitest-environment jsdom
import type { WorkspaceTarget } from '@corral/contracts';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { DockDocumentPanel } from './DockDocumentPanel.tsx';
import { DocumentHeader } from './DocumentHeader.tsx';
import { type DocumentBuffer, type DocumentStore, documentKey } from './documents/store.ts';

const target: WorkspaceTarget = {
  hostId: 'local',
  projectId: 'project',
  bindingId: 'binding',
  sessionId: 'session',
  copyGeneration: 1,
};
const fixture = vi.hoisted(() => ({
  gitStatus: vi.fn(async (_scope: unknown) => ({}) as unknown),
}));
vi.mock('../services.tsx', () => {
  const services = { mode: 'server', workspaces: { gitStatus: fixture.gitStatus } };
  return { useServices: () => services };
});
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/">{children}</a>,
}));
vi.mock('./DocumentPanel.tsx', () => ({ DocumentPanel: () => <div data-document-panel /> }));

const key = documentKey(target, 'note.txt');
const buffer = (dirty: boolean) =>
  ({
    key,
    target,
    path: 'note.txt',
    file: { target, path: 'note.txt', content: { kind: 'text', text: 'saved' }, writable: true },
    dirty,
    pendingSave: null,
    recoveries: [],
  }) as unknown as DocumentBuffer;
const owner = (entry: DocumentBuffer) =>
  Object.assign(
    createStore(() => ({ documents: { [key]: entry } as Record<string, DocumentBuffer> })),
    {
      open: vi.fn(async () => key),
      retainView: vi.fn(() => () => {}),
      sessionRecoveries: vi.fn(async () => []),
    },
  ) as unknown as DocumentStore;
const status = (copyGeneration: number, branch: string | null) => ({
  target: { ...target, copyGeneration, kind: 'session' },
  head: { oid: null, branch, detached: !branch, unborn: false },
});

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.unstubAllGlobals();
});
async function mounted(content: ReactNode) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  disposals.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () => {
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        {content}
      </IntlProvider>,
    );
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  return container;
}
const header = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-testid="document-header"]');

it('a copy document names the session working copy, its branch and the unsaved state', async () => {
  fixture.gitStatus.mockResolvedValue(status(1, 'feature/tree'));
  const container = await mounted(
    <DockDocumentPanel owner={owner(buffer(true))} target={target} path="note.txt" viewId="tab" />,
  );
  const head = header(container);
  expect(head?.textContent).toContain(messages.Desktop.sessionCopy);
  expect(head?.textContent).toContain('feature/tree');
  expect(head?.textContent).toContain(messages.Documents.dirty);
  expect(head?.textContent).not.toContain(messages.Desktop.sourceFolder);
  expect(fixture.gitStatus).toHaveBeenCalledWith({ kind: 'session', id: 'session' });
});

it('a saved document shows no unsaved mark, and another copy generation’s branch is not shown', async () => {
  fixture.gitStatus.mockResolvedValue(status(2, 'someone-else'));
  const container = await mounted(
    <DockDocumentPanel owner={owner(buffer(false))} target={target} path="note.txt" viewId="tab" />,
  );
  const head = header(container);
  expect(head?.textContent).toContain(messages.Desktop.sessionCopy);
  expect(head?.textContent).not.toContain(messages.Documents.dirty);
  expect(head?.textContent).not.toContain('someone-else');
});

it('a source-folder file says so and claims neither a branch nor a draft', async () => {
  fixture.gitStatus.mockClear();
  const container = await mounted(<DocumentHeader path="README.md" target={{ kind: 'source' }} />);
  const head = header(container);
  expect(head?.textContent).toContain(messages.Desktop.sourceFolder);
  expect(head?.textContent).toContain('README.md');
  expect(head?.textContent).not.toContain(messages.Documents.dirty);
  expect(fixture.gitStatus).not.toHaveBeenCalled();
});
