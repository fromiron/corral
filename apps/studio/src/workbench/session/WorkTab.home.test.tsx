// @vitest-environment jsdom
import type { RunSummary, SessionEntry, WorkSession } from '@corral/core';
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
  runControlsOwnConfirmation?: boolean;
  revealRun?: (runId: string | null) => boolean;
};
const fixture = vi.hoisted(() => ({
  composer: [] as ComposerProps[],
  connection: [] as (SessionConnection | null)[],
  workspaces: null as object | null,
  access: 'unknown' as 'unknown' | 'unlinked' | 'copy',
  search: {} as Record<string, unknown>,
}));
vi.mock('../../services.tsx', async () => {
  const { sessionStore } = await import('../../../../../packages/react/src/stories/fixtures.tsx');
  const store = sessionStore();
  return {
    useServices: () => ({
      runFor: () => store,
      sessionFor: () => store,
      retainRun: () => () => {},
      workspaces: fixture.workspaces,
    }),
  };
});
vi.mock('../../pages/FilesViews.tsx', () => ({ useBinding: () => ({ binding: null }) }));
vi.mock('../../router.tsx', () => ({ sessionRoute: { useSearch: () => fixture.search } }));
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
  fixture.search = {};
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

async function show(
  value: WorkSession,
  {
    runs = [],
    active = null,
    selectedRunId = null,
    onPlace,
  }: {
    runs?: RunSummary[];
    active?: RunSummary | null;
    selectedRunId?: string | null;
    onPlace?: (message: string | undefined) => void;
  } = {},
) {
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
          runs={runs}
          active={active}
          liveRunId={null}
          selectedRunId={selectedRunId}
          onChange={() => {}}
          reference={null}
          onReferenceUsed={() => {}}
          onPanel={() => {}}
          {...(onPlace ? { onPlace } : {})}
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

const run = (runId: string): RunSummary => ({
  runId,
  status: 'running',
  corralId: 'team',
  projectId: 'project',
  sessionId: 'session_home',
  startedAt: '2026-11-09T00:00:00Z',
});
const asked = (runId: string): SessionEntry => ({
  entryId: `entry_${runId}`,
  intent: 'next',
  text: `Request of ${runId}`,
  state: 'started',
  createdAt: '2026-11-09T00:00:00Z',
  runId,
  executionId: null,
  detail: null,
});

it.each([
  ['the run view shows the running run', { panel: 'run' }, 'run_live', true],
  ['the run view shows another run', { panel: 'run' }, 'run_old', false],
  ['no run view is open', {}, 'run_live', false],
] as const)(
  'leaves Stop’s confirmation to the run view only while %s',
  async (_name, search, selected, owns) => {
    fixture.search = search;
    await show(session([asked('run_live')]), {
      runs: [run('run_old'), run('run_live')],
      active: run('run_live'),
      selectedRunId: selected,
    });
    expect(fixture.composer.at(-1)?.runControlsOwnConfirmation).toBe(owns);
  },
);

it("brings a run's item into the conversation's window: its request, or the run itself", async () => {
  const onPlace = vi.fn();
  await show(session([asked('run_asked')]), {
    runs: [run('run_asked'), run('run_loose')],
    active: run('run_asked'),
    onPlace,
  });
  const reveal = fixture.composer.at(-1)?.revealRun;
  // The request that started it.
  expect(reveal?.('run_asked')).toBe(true);
  expect(onPlace).toHaveBeenLastCalledWith('entry_run_asked');
  // A run no request names is its own item.
  expect(reveal?.('run_loose')).toBe(true);
  expect(onPlace).toHaveBeenLastCalledWith('run_loose');
  // The conversation has no item for a run of another session.
  onPlace.mockClear();
  expect(reveal?.('run_elsewhere')).toBe(false);
  expect(onPlace).not.toHaveBeenCalled();
  // Done: the place is let go, so the next View goes there again.
  reveal?.(null);
  expect(onPlace).toHaveBeenLastCalledWith(undefined);
});
