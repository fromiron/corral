// @vitest-environment jsdom
import type { SessionEntry, WorkSession } from '@corral/core';
import { act, createContext } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { SessionChat } from './SessionChat.tsx';
import type { SessionConnection } from './SessionConnection.tsx';
import { WorkTab } from './WorkTab.tsx';

type ComposerProps = {
  home?: boolean;
  onWorkFolder?: () => void;
  onFolderAction?: () => void;
  folderAccess?: string;
};
const fixture = vi.hoisted(() => ({
  composer: [] as ComposerProps[],
  connection: [] as (SessionConnection | null)[],
  workspaces: null as object | null,
  access: 'unknown' as 'unknown' | 'unlinked' | 'copy',
}));
vi.mock('../../services.tsx', () => ({
  useServices: () => ({
    runFor: () => ({ getState: () => ({ open: async () => {} }) }),
    sessionFor: () => ({ getState: () => ({ open: async () => {} }) }),
    retainRun: () => () => {},
    workspaces: fixture.workspaces,
  }),
}));
vi.mock('../../pages/FilesViews.tsx', () => ({ useBinding: () => ({ binding: null }) }));
vi.mock('../../router.tsx', () => ({ sessionRoute: { useSearch: () => ({}) } }));
vi.mock('../MeetingHandoff.tsx', () => ({ MeetingHandoffLinks: () => null }));
vi.mock('../WorkFolderNotice.tsx', () => ({ useFolderAccess: () => fixture.access }));
vi.mock('./SessionEntries.tsx', () => ({
  EntryCard: ({ entry }: { entry: SessionEntry }) => <p>{entry.text}</p>,
  RunCard: () => null,
  RunChecks: createContext(null),
  useRunChecks: () => null,
}));
vi.mock('./Composer.tsx', async () => {
  const { useSessionConnection } = await import('./SessionConnection.tsx');
  return {
    Composer: (props: ComposerProps) => {
      fixture.composer.push(props);
      // The link to the server, as the composer's activity bar reads it.
      fixture.connection.push(useSessionConnection());
      return <textarea data-testid="composer" aria-label="Request" />;
    },
  };
});

const cleanup: (() => void)[] = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  fixture.composer = [];
  fixture.connection = [];
  fixture.workspaces = null;
  fixture.access = 'unknown';
});
afterEach(() => {
  for (const dispose of cleanup.splice(0)) act(dispose);
  vi.unstubAllGlobals();
});

const session = (entries: SessionEntry[] = []): WorkSession => ({
  sessionId: 'session_home',
  projectId: 'project',
  corralId: null,
  auto: null,
  title: 'New session',
  objective: '',
  pinned: false,
  revision: 1,
  createdAt: '2026-11-09T00:00:00Z',
  updatedAt: '2026-11-09T00:00:00Z',
  archivedAt: null,
  autoStart: true,
  entries,
});

async function show(value: WorkSession) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanup.push(() => {
    root.unmount();
    container.remove();
  });
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <WorkTab
          session={value}
          team={null}
          corrals={[]}
          runs={[]}
          active={null}
          liveRunId={null}
          selectedRunId={null}
          onChange={() => {}}
          reference={null}
          onReferenceUsed={() => {}}
          onPanel={() => {}}
        />
      </IntlProvider>,
    ),
  );
  return container;
}

it('an empty session centers its title above the composer, which offers start suggestions', async () => {
  const container = await show(session());
  expect(container.querySelector('[data-empty-centered]')).not.toBeNull();
  const heading = container.querySelector('h2');
  expect(heading?.textContent).toBe(messages.Desktop.homeTitle);
  const composer = container.querySelector('[data-testid="composer"]');
  // The composer comes directly after the title, and knows it is the home composition.
  expect(
    heading && composer
      ? heading.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING
      : 0,
  ).toBeTruthy();
  expect(fixture.composer.at(-1)?.home).toBe(true);
  // No explanatory caption under the title.
  expect(container.querySelectorAll('section p')).toHaveLength(0);
});

it('returns to the conversation layout once a request exists', async () => {
  const container = await show(
    session([
      {
        entryId: 'first',
        intent: 'next',
        text: 'First request',
        state: 'started',
        createdAt: '2026-11-09T00:00:00Z',
        runId: null,
        executionId: null,
        detail: null,
      },
    ]),
  );
  expect(container.querySelector('[data-empty-centered]')).toBeNull();
  expect(container.querySelector('h2')).toBeNull();
  expect(container.textContent).toContain('First request');
  expect(fixture.composer.at(-1)?.home).toBe(false);
});

it('offers the folder step in the composer row, and does not repeat it above the conversation', async () => {
  fixture.workspaces = {};
  await show(session());
  expect(fixture.composer.at(-1)?.onWorkFolder).toBeTypeOf('function');
  expect(fixture.composer.at(-1)?.onFolderAction).toBeUndefined();
  fixture.access = 'unlinked';
  const container = await show(session());
  expect(fixture.composer.at(-1)?.onFolderAction).toBeTypeOf('function');
  expect(fixture.composer.at(-1)?.folderAccess).toBe('unlinked');
  expect(fixture.composer.at(-1)?.onWorkFolder).toBeUndefined();
  // The notice lives in the composer. The conversation above does not repeat it.
  expect(container.textContent).not.toContain(messages.Sessions.agentNoFiles);
});

it('the session chat leaves a lost connection to the composer’s activity bar, with nothing above or in the conversation', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanup.push(() => {
    root.unmount();
    container.remove();
  });
  const retry = vi.fn();
  const entry: SessionEntry = {
    entryId: 'first',
    intent: 'next',
    text: 'First request',
    state: 'started',
    createdAt: '2026-11-09T00:00:00Z',
    runId: null,
    executionId: null,
    detail: null,
  };
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <SessionChat
          connection={{ lost: true, retry }}
          session={session([entry])}
          team={null}
          corrals={[]}
          runs={[]}
          active={null}
          liveRunId={null}
          selectedRunId={null}
          onChange={() => {}}
          reference={null}
          onReferenceUsed={() => {}}
          onPanel={() => {}}
        />
      </IntlProvider>,
    ),
  );
  const view = container.querySelector('[data-chat-view]');
  const timeline = container.querySelector('[data-testid="chat-timeline"]');
  const composer = container.querySelector('[data-testid="chat-composer"]');
  if (!view || !timeline || !composer) throw new Error('Session chat missing');
  // The conversation itself says nothing of it: no alert, no notice in or above the timeline.
  expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
  expect(container.textContent).not.toContain(messages.Activity.connectionLost);
  expect(container.textContent).not.toContain(messages.Sessions.connectionLost);
  expect(view.parentElement?.firstElementChild).toBe(view);
  // The composer, in the composer's place, reads the lost link and its retry.
  expect(composer.querySelector('[data-testid="composer"]')).not.toBeNull();
  const seen = fixture.connection.at(-1);
  expect(seen?.lost).toBe(true);
  seen?.retry();
  expect(retry).toHaveBeenCalledOnce();
});
