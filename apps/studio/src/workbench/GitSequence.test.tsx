// @vitest-environment jsdom
import type { GitSequenceState, GitStatus, WorkspaceTarget } from '@corral/contracts';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { DocumentBuffer, DocumentStore } from './documents/store.ts';
import { GitSequence } from './GitSequence.tsx';

vi.mock('use-intl', () => ({
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}));
const target: WorkspaceTarget = {
  hostId: 'host',
  projectId: 'project',
  bindingId: 'binding',
  sessionId: 'session',
  copyGeneration: 2,
};
const status: GitStatus = {
  target: { kind: 'session', ...target },
  head: {
    oid: 'a'.repeat(40),
    branch: 'main',
    detached: false,
    unborn: false,
    shallow: false,
    upstream: null,
  },
  indexHash: 'b'.repeat(64),
  entries: [],
  truncated: false,
  filtersDisabled: true,
  branches: ['main', 'feature'],
};
const state: GitSequenceState = {
  target,
  head: status.head.oid,
  indexHash: status.indexHash,
  workingTreeHash: 'c'.repeat(64),
  sequence: null,
  conflicts: [],
  ownerOperationId: null,
  localBranches: [
    { name: 'main', oid: 'a'.repeat(40) },
    { name: 'feature', oid: 'd'.repeat(40) },
  ],
};
const active: GitSequenceState = {
  ...state,
  ownerOperationId: 'git_merge',
  sequence: {
    kind: 'merge',
    identity: 'e'.repeat(64),
    originalHead: 'a'.repeat(40),
    onto: 'd'.repeat(40),
    headName: 'refs/heads/main',
    reason: null,
  },
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
});
async function mount(initial = state, initialStatus = status) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const owner = createStore<{ documents: Record<string, DocumentBuffer> }>(() => ({
    documents: {},
  })) as DocumentStore;
  const onCommand = vi.fn(async () => {});
  const onRunHooksChange = vi.fn();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const render = async (value = initial, observation = initialStatus) =>
    act(async () =>
      root.render(
        <GitSequence
          sessionId="session"
          status={observation}
          state={value}
          owner={owner}
          disabled={false}
          runHooks
          author={{ name: 'Person', email: 'person@example.test' }}
          onRunHooksChange={onRunHooksChange}
          onCommand={onCommand}
        />,
      ),
    );
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await render();
  const button = (key: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.textContent === `GitSequence.${key}`,
    );
  const click = async (key: string) => {
    expect(button(key), key).toBeDefined();
    await act(async () => button(key)?.click());
  };
  return { owner, onCommand, onRunHooksChange, render, button, click };
}

it('[TC-WBD-022-H] confirms the reviewed branch commit and policy with the complete Git snapshot', async () => {
  const view = await mount();
  await view.click('reviewMerge');
  expect(view.onCommand).not.toHaveBeenCalled();
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('feature');
  await view.render({ ...state, workingTreeHash: 'f'.repeat(64) });
  expect(view.button('confirm')?.disabled).toBe(true);
  await view.click('confirm');
  expect(view.onCommand).not.toHaveBeenCalled();
  await view.click('cancel');
  await view.render();
  await view.click('reviewMerge');
  await view.click('confirm');
  expect(view.onCommand).toHaveBeenCalledWith({
    target,
    expect: { head: state.head, indexHash: state.indexHash },
    workingTreeHash: state.workingTreeHash,
    sequenceIdentity: null,
    kind: 'merge',
    branch: 'feature',
    branchCommit: 'd'.repeat(40),
    runHooks: true,
    author: { name: 'Person', email: 'person@example.test' },
  });
});

it('[TC-WBD-022-N] preserves every draft in the copy and requires a separate abort loss confirmation', async () => {
  const changed: GitStatus = {
    ...status,
    entries: [
      {
        kind: 'ordinary',
        path: 'resolved.ts',
        indexStatus: 'M',
        worktreeStatus: '.',
        submodule: false,
      },
    ],
  };
  const view = await mount(active, changed);
  await view.click('reviewAbort');
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('resolved.ts');
  expect(view.button('confirm')?.disabled).toBe(true);
  const confirm = document.querySelector<HTMLElement>(
    '[role="checkbox"][aria-label="GitSequence.abortConfirm"]',
  );
  expect(confirm).not.toBeNull();
  await act(async () => confirm?.click());
  const draft = {
    key: 'other',
    target,
    path: 'unrelated.ts',
    text: 'keep my draft',
    dirty: true,
    saving: false,
    pendingSave: null,
    conflict: null,
  } as DocumentBuffer;
  await act(async () => view.owner.setState({ documents: { other: draft } }));
  expect(view.button('confirm')?.disabled).toBe(true);
  await view.click('confirm');
  expect(view.onCommand).not.toHaveBeenCalled();
  expect(view.owner.getState().documents.other?.text).toBe('keep my draft');
  await act(async () =>
    view.owner.setState({
      documents: { other: { ...draft, target: { ...target, copyGeneration: 1 } } },
    }),
  );
  await view.click('confirm');
  expect(view.onCommand).toHaveBeenCalledWith({
    target,
    expect: { head: state.head, indexHash: state.indexHash },
    workingTreeHash: state.workingTreeHash,
    sequenceIdentity: active.sequence?.identity,
    kind: 'abort',
    confirmed: true,
  });
});

it('[TC-WBD-022-F] offers no sequence action for unsupported or external state and pins an owned continue', async () => {
  const view = await mount({
    ...active,
    sequence: {
      kind: 'unsupported',
      identity: 'e'.repeat(64),
      originalHead: null,
      onto: null,
      headName: null,
      reason: 'Interactive exec is unsupported',
    },
  });
  expect(document.body.textContent).toContain('Interactive exec is unsupported');
  expect(view.button('reviewContinue')).toBeUndefined();
  expect(view.button('reviewAbort')).toBeUndefined();
  await view.render({ ...active, ownerOperationId: null });
  expect(document.body.textContent).toContain('GitSequence.external');
  expect(view.button('reviewAbort')).toBeUndefined();
  await view.render(active);
  await view.click('reviewContinue');
  await view.click('confirm');
  expect(view.onCommand).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: 'continue',
      sequenceIdentity: active.sequence?.identity,
      runHooks: true,
    }),
  );
});
