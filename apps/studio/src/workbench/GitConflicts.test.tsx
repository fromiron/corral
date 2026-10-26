// @vitest-environment jsdom
import type { GitConflict, GitSequenceState } from '@corral/contracts';
import { act, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { SourceNavigationContext } from './context/SourceAttachments.tsx';
import type { DocumentBuffer, DocumentStore } from './documents/store.ts';
import { GitConflicts } from './GitConflicts.tsx';

vi.mock('use-intl', () => ({
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}));
vi.mock('../pages/ReviewPage.tsx', () => ({
  FileDiff: ({
    loadKey,
    load,
  }: {
    loadKey: string;
    load(): Promise<{ before: { text: string }; after: { text: string } }>;
  }) => {
    const [text, setText] = useState('');
    // biome-ignore lint/correctness/useExhaustiveDependencies: Immutable FileDiff load key.
    useEffect(() => {
      void load().then((value) => setText(`${value.before.text} → ${value.after.text}`));
    }, [loadKey]);
    return <pre>{text}</pre>;
  },
}));
const target = {
  hostId: 'host',
  projectId: 'project',
  bindingId: 'binding',
  sessionId: 'session',
  copyGeneration: 1,
};
const state: GitSequenceState = {
  target,
  head: 'a'.repeat(40),
  indexHash: 'b'.repeat(64),
  workingTreeHash: 'c'.repeat(64),
  sequence: {
    kind: 'merge',
    identity: 'd'.repeat(64),
    originalHead: 'a'.repeat(40),
    onto: 'e'.repeat(40),
    headName: 'main',
    reason: null,
  },
  conflicts: ['a.ts'],
  ownerOperationId: 'merge_1',
  localBranches: [],
};
const conflict: GitConflict = {
  target,
  path: 'a.ts',
  head: state.head,
  indexHash: state.indexHash,
  sequenceIdentity: state.sequence?.identity ?? null,
  base: { kind: 'text', text: 'base' },
  ours: { kind: 'text', text: 'ours' },
  theirs: { kind: 'text', text: 'theirs' },
  current: { kind: 'text', text: 'working' },
  currentHash: 'f'.repeat(64),
  unsupported: null,
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
});
async function mount() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const api = { gitConflict: vi.fn(async () => conflict) };
  const owner = Object.assign(
    createStore<{ documents: Record<string, DocumentBuffer> }>(() => ({
      documents: {
        doc: {
          key: 'doc',
          path: 'a.ts',
          target,
          dirty: false,
          saving: false,
          pendingSave: null,
          conflict: null,
          baseHash: conflict.currentHash,
          text: 'working',
        } as DocumentBuffer,
      },
    })),
    { open: vi.fn(async () => 'doc'), refresh: vi.fn(async () => {}) },
  ) as unknown as DocumentStore;
  const onStage = vi.fn(async () => {}),
    openDocument = vi.fn(() => true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const render = async (value = state) =>
    act(async () =>
      root.render(
        <SourceNavigationContext.Provider value={{ openDocument, openTerminal: () => {} }}>
          <GitConflicts
            api={api}
            owner={owner}
            state={value}
            disabled={false}
            writable
            onStage={onStage}
          />
        </SourceNavigationContext.Provider>,
      ),
    );
  await render();
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const click = async (key: string) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.textContent === key,
    );
    expect(button, key).toBeDefined();
    await act(async () => button?.click());
  };
  return { api, owner, onStage, openDocument, render, click };
}

it('reviews conflict sides, opens the existing draft without overwriting and only stages a saved resolution', async () => {
  const f = await mount();
  await f.click('a.ts');
  expect(document.body.textContent).toContain('base → working');
  await f.click('GitConflicts.ours');
  expect(document.body.textContent).toContain('base → ours');
  await f.click('GitConflicts.theirs');
  expect(document.body.textContent).toContain('base → theirs');
  await act(async () =>
    f.owner.setState({
      documents: {
        doc: {
          ...(f.owner.getState().documents.doc as DocumentBuffer),
          dirty: true,
          text: 'my draft',
        },
      },
    }),
  );
  await f.click('GitConflicts.openEditor');
  expect(f.openDocument).toHaveBeenCalledWith(target, 'a.ts');
  expect(f.owner.getState().documents.doc?.text).toBe('my draft');
  expect(f.owner.refresh).not.toHaveBeenCalled();
  await f.click('a.ts');
  await f.click('GitConflicts.stage');
  expect(f.onStage).not.toHaveBeenCalled();
  await act(async () =>
    f.owner.setState({
      documents: { doc: { ...(f.owner.getState().documents.doc as DocumentBuffer), dirty: false } },
    }),
  );
  await f.click('GitConflicts.stage');
  expect(f.onStage).toHaveBeenCalledWith({
    kind: 'stage',
    target,
    expect: { head: state.head, indexHash: state.indexHash },
    paths: ['a.ts'],
  });
});

it('rejects changed disk content and late conflict reads from a replaced copy', async () => {
  const f = await mount();
  await f.click('a.ts');
  f.api.gitConflict.mockResolvedValueOnce({ ...conflict, currentHash: '1'.repeat(64) });
  await f.click('GitConflicts.stage');
  expect(f.onStage).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain('GitConflicts.stale');
  let resolve!: (value: GitConflict) => void;
  f.api.gitConflict.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await f.click('GitConflicts.close');
  await f.click('a.ts');
  await f.render({ ...state, target: { ...target, copyGeneration: 2 } });
  await act(async () => resolve(conflict));
  expect(document.body.textContent).not.toContain('base → working');
  expect(f.openDocument).not.toHaveBeenCalled();
});
