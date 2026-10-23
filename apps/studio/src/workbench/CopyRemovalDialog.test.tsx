// @vitest-environment jsdom
import type { CopyRemovalPlan } from '@corral/client';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { CopyRemovalDialog } from './CopyRemovalDialog.tsx';

const fixture = vi.hoisted(() => ({
  services: {} as Record<string, unknown>,
  documents: {} as Record<string, unknown>,
  recoveries: [] as unknown[],
}));
vi.mock('../services.tsx', () => ({ useServices: () => fixture.services }));
vi.mock('./documents/store.ts', () => ({
  documentStore: () => ({
    getState: () => ({ documents: fixture.documents }),
    sessionRecoveries: async () => fixture.recoveries,
  }),
}));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
});

const target = (sessionId: string) => ({
  hostId: 'host',
  projectId: 'project',
  bindingId: 'binding',
  sessionId,
  copyGeneration: 3,
});
const empty: CopyRemovalPlan = {
  sessionId: 'session',
  bindingId: 'binding',
  copyGeneration: 3,
  missing: false,
  git: { staged: 0, unstaged: 0, untracked: 0, unmerged: 0 },
  owners: [],
  draftComments: 0,
  uncertainWrites: 0,
  openRuns: [],
};

async function mount(plan: CopyRemovalPlan, remove = vi.fn(async () => null)) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.services = {
    mode: 'server',
    workspaceId: 'host',
    workspaces: { removalPlan: vi.fn(async () => plan), removeWorktree: remove },
  };
  const onRemoved = vi.fn();
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
        <CopyRemovalDialog
          open
          sessionId="session"
          projectId="project"
          onClose={() => {}}
          onRemoved={onRemoved}
        />
      </IntlProvider>,
    ),
  );
  const dialog = () => document.querySelector('[role="dialog"]');
  const confirm = () =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === messages.Files.removeCopy,
    );
  return { dialog, confirm, remove, onRemoved };
}

it('[TC-WBD-016-H] shows what removing the copy would lose and removes exactly the generation shown', async () => {
  fixture.documents = {
    a: {
      target: target('session'),
      path: 'src/a.ts',
      dirty: true,
      saving: false,
      pendingSave: null,
    },
    b: { target: target('other'), path: 'src/b.ts', dirty: true, saving: false, pendingSave: null },
  };
  fixture.recoveries = [{ path: 'src/old.ts' }];
  const view = await mount({
    ...empty,
    git: { staged: 1, unstaged: 2, untracked: 3, unmerged: 0 },
    draftComments: 2,
    uncertainWrites: 1,
    openRuns: ['run_1'],
  });
  const text = view.dialog()?.textContent ?? '';
  expect(text).toContain('src/a.ts');
  expect(text).not.toContain('src/b.ts');
  expect(text).toContain('src/old.ts');
  for (const word of ['1', '2', '3']) expect(text).toContain(word);
  await act(async () => view.confirm()?.click());
  expect(view.remove).toHaveBeenCalledWith('session', 3);
  expect(view.onRemoved).toHaveBeenCalled();
});

it('[TC-WBD-016-N] a copy still held by a task or terminal cannot be removed from here, and a late removal says why', async () => {
  fixture.documents = {};
  fixture.recoveries = [];
  const held = await mount({
    ...empty,
    owners: [{ kind: 'user', id: 'op', state: 'active', writer: true, operation: 'task' }],
  });
  expect(held.confirm()?.disabled).toBe(true);
  await cleanups.splice(0)[0]?.();
  const late = await mount(
    empty,
    vi.fn(async () => {
      throw new Error('the working copy was made again since removal was confirmed');
    }),
  );
  await act(async () => late.confirm()?.click());
  expect(late.onRemoved).not.toHaveBeenCalled();
  expect(late.dialog()?.querySelector('[role="alert"]')?.textContent).toContain('made again');
});

it('[TC-WBD-016-F] Git state that could not be read is shown as unknown, not as clean', async () => {
  fixture.documents = {};
  fixture.recoveries = [];
  const view = await mount({ ...empty, git: null });
  expect(view.dialog()?.textContent).toContain(messages.Files.removalGitUnknown);
});
