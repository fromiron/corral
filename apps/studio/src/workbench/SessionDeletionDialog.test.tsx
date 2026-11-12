// @vitest-environment jsdom
import { ApiError, type SessionDeletionSummary } from '@corral/client';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { SessionDeletionDialog } from './SessionDeletionDialog.tsx';

const fixture = vi.hoisted(() => ({
  services: {} as Record<string, unknown>,
  documents: {} as Record<string, unknown>,
  recoveries: [] as unknown[],
  forgotten: [] as string[],
}));
vi.mock('../services.tsx', () => ({ useServices: () => fixture.services }));
vi.mock('./documents/store.ts', () => ({
  documentStore: () => ({
    getState: () => ({ documents: fixture.documents }),
    sessionRecoveries: async () => fixture.recoveries,
    forgetSession: async (sessionId: string) => {
      fixture.forgotten.push(sessionId);
    },
  }),
}));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  fixture.forgotten = [];
});

const target = (sessionId: string) => ({
  hostId: 'host',
  projectId: 'project',
  bindingId: 'binding',
  sessionId,
  copyGeneration: 3,
});
const summary = (patch: Partial<SessionDeletionSummary> = {}): SessionDeletionSummary => ({
  sessionId: 'session',
  revision: 4,
  title: 'Alpha',
  meeting: false,
  archived: false,
  runs: 2,
  messages: 3,
  unfinishedRunIds: [],
  generatedMedia: 1,
  inputImages: 0,
  schedules: [{ id: 'sched', title: 'Nightly' }],
  handoffs: [
    {
      commandId: 'handoff_1',
      direction: 'outgoing',
      otherSessionId: 'other',
      otherTitle: 'Beta',
      otherDeleted: false,
    },
  ],
  copyGeneration: 3,
  workingCopy: {
    sessionId: 'session',
    bindingId: 'binding',
    copyGeneration: 3,
    missing: false,
    git: { staged: 1, unstaged: 0, untracked: 2, unmerged: 0 },
    owners: [],
    draftComments: 0,
    uncertainWrites: 1,
    openRuns: [],
  },
  ...patch,
});

function copy() {
  const workingCopy = summary().workingCopy;
  if (!workingCopy) throw new Error('the fixture has a working copy');
  return workingCopy;
}

async function mount(preview: SessionDeletionSummary, remove = vi.fn(async () => undefined)) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const sendCommand = vi.fn(async () => ({ commandId: 'cmd_1' }));
  let current = preview;
  fixture.services = {
    mode: 'server',
    workspaceId: 'host',
    workspaces: {},
    transport: { sendCommand },
    sessionDeletion: {
      preview: vi.fn(async () => current),
      delete: remove,
    },
  };
  const onDeleted = vi.fn();
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
        <SessionDeletionDialog
          open
          sessionId="session"
          projectId="project"
          onClose={() => {}}
          onDeleted={onDeleted}
        />
      </IntlProvider>,
    ),
  );
  const dialog = () => document.querySelector('[role="dialog"]');
  const button = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (item) => item.textContent === label,
    );
  return {
    dialog,
    button,
    sendCommand,
    onDeleted,
    remove,
    refresh: (next: SessionDeletionSummary) => {
      current = next;
    },
  };
}

it('lists what this session would lose and waits while a run is unfinished', async () => {
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
  localStorage.setItem('corral:session-draft:session', 'keep this');
  const view = await mount(
    summary({
      unfinishedRunIds: ['run_open'],
      workingCopy: { ...copy(), openRuns: ['run_open'] },
    }),
  );
  const text = view.dialog()?.textContent ?? '';
  expect(text).toContain('src/a.ts');
  expect(text).not.toContain('src/b.ts');
  expect(text).toContain('src/old.ts');
  expect(text).toContain('Nightly');
  expect(view.button(messages.Sessions.deleteConfirm)?.disabled).toBe(true);
  await act(async () => view.button(messages.Sessions.deleteStop)?.click());
  expect(view.sendCommand).toHaveBeenCalledWith(
    expect.objectContaining({
      runId: 'run_open',
      type: 'cancel',
      payload: { scope: { kind: 'run' }, reason: 'User cancelled the run' },
    }),
  );
  view.refresh(summary());
  await act(async () => view.button(messages.Sessions.deleteStop)?.click());
  expect(view.button(messages.Sessions.deleteConfirm)?.disabled).toBe(false);
  await act(async () => view.button(messages.Sessions.deleteConfirm)?.click());
  expect(view.remove).toHaveBeenCalledWith('session', { expectedRevision: 4, copyGeneration: 3 });
  expect(view.onDeleted).toHaveBeenCalled();
  expect(localStorage.getItem('corral:session-draft:session')).toBeNull();
});

it('a copy still held cannot be deleted, and a stale revision is not success', async () => {
  fixture.documents = {};
  fixture.recoveries = [];
  const held = await mount(
    summary({
      workingCopy: {
        ...copy(),
        owners: [{ kind: 'user', id: 'op', state: 'active', writer: true, operation: 'task' }],
      },
    }),
  );
  expect(held.button(messages.Sessions.deleteConfirm)?.disabled).toBe(true);
  await cleanups.splice(0)[0]?.();
  const late = await mount(
    summary({ copyGeneration: null, workingCopy: null }),
    vi.fn(async () => {
      throw new ApiError(409, 'REVISION_CONFLICT', 'the session changed');
    }),
  );
  await act(async () => late.button(messages.Sessions.deleteConfirm)?.click());
  expect(late.onDeleted).not.toHaveBeenCalled();
  expect(late.remove).toHaveBeenCalledTimes(1);
  expect(late.dialog()?.querySelector('[role="alert"]')?.textContent).toContain('changed');
});

it('a repeated delete that is no longer found is done and clears this browser', async () => {
  fixture.documents = {};
  fixture.recoveries = [];
  localStorage.setItem('corral:session-draft:session', 'gone');
  localStorage.setItem('corral:meeting-handoff:session:decision_1', '{}');
  localStorage.setItem('corral:meeting-records:v1:session', '1');
  localStorage.setItem('corral:session-draft:other', 'stay');
  const view = await mount(
    summary({ copyGeneration: null, workingCopy: null }),
    vi.fn(async () => {
      throw new ApiError(404, 'TARGET_NOT_FOUND', 'no such session');
    }),
  );
  await act(async () => view.button(messages.Sessions.deleteConfirm)?.click());
  expect(view.onDeleted).toHaveBeenCalled();
  expect(fixture.forgotten).toEqual(['session']);
  expect(localStorage.getItem('corral:session-draft:session')).toBeNull();
  expect(localStorage.getItem('corral:meeting-handoff:session:decision_1')).toBeNull();
  expect(localStorage.getItem('corral:meeting-records:v1:session')).toBeNull();
  expect(localStorage.getItem('corral:session-draft:other')).toBe('stay');
});
