// @vitest-environment jsdom
import type { DirectiveView, RunSummary, SessionEntry, WorkSession } from '@corral/core';
import { emptyProjection } from '@corral/core';
import { act, createContext } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../../../../../packages/react/src/messages/en.json' with { type: 'json' };
import type { RunRecord, SteerRecord } from './entryMeta.ts';
import type { WatchedExpiry } from './runRecords.ts';
import { WorkTab } from './WorkTab.tsx';

// What WorkTab hands each conversation row about its message (features/composer-flow.md "보낸
// 메시지의 메타 줄"): an instruction's own directive, found by the command it was sent as; the
// request it was carried to, whatever became of it; whether it is held until the session is read
// again; and where a carried request is drawn.

type CardProps = {
  entry: SessionEntry;
  record?: SteerRecord | null;
  carried?: SessionEntry;
  carriedHere?: boolean;
  runOnly?: boolean;
  heldAs?: DirectiveView['status'];
  sourceShown?: boolean;
  runsListed?: boolean;
};
const fixture = vi.hoisted(() => ({
  cards: new Map<string, CardProps>(),
  records: new Map<string, RunRecord>(),
  watched: new Map<string, WatchedExpiry>(),
  options: null as null | { started: () => number; onWatchedExpiry: () => void },
  search: {} as Record<string, string>,
}));
vi.mock('../../services.tsx', () => ({
  useServices: () => ({
    runFor: () => ({ getState: () => ({ open: async () => {} }) }),
    sessionFor: () => ({ getState: () => ({ open: async () => {} }) }),
    retainRun: () => () => {},
    workspaces: null,
  }),
}));
vi.mock('./runRecords.ts', () => ({
  useRunRecords: (
    _ids: string[],
    _runs: RunSummary[],
    options: { started: () => number; onWatchedExpiry: () => void },
  ) => {
    fixture.options = options;
    return { records: fixture.records, watched: fixture.watched };
  },
}));
vi.mock('../../pages/FilesViews.tsx', () => ({ useBinding: () => ({ binding: null }) }));
vi.mock('../../router.tsx', () => ({ sessionRoute: { useSearch: () => fixture.search } }));
vi.mock('../MeetingHandoff.tsx', () => ({ MeetingHandoffLinks: () => null }));
vi.mock('../WorkFolderNotice.tsx', () => ({ useFolderAccess: () => 'unknown' }));
vi.mock('./SessionEntries.tsx', async () => {
  const { useContext } = await import('react');
  const { AdviceArrival } = await import('../adviceArrival.ts');
  return {
    EntryCard: (props: CardProps) => {
      fixture.cards.set(props.entry.entryId, props);
      // The run a person came to read advice in, as each row hears it.
      const arrival = useContext(AdviceArrival);
      return props.runOnly && !props.entry.runId ? null : (
        <p data-arrival={arrival ?? ''}>{props.entry.text}</p>
      );
    },
    RunCard: () => null,
    RunChecks: createContext(null),
    useRunChecks: () => null,
  };
});
vi.mock('./Composer.tsx', () => ({ Composer: () => <textarea aria-label="Request" /> }));

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
  fixture.cards.clear();
  fixture.records.clear();
  fixture.watched.clear();
  fixture.options = null;
  fixture.search = {};
});
afterEach(() => {
  for (const dispose of cleanup.splice(0)) act(dispose);
  vi.unstubAllGlobals();
});

const session = (entries: SessionEntry[]): WorkSession => ({
  sessionId: 'session_meta',
  projectId: 'project',
  corralId: null,
  auto: null,
  title: 'Session',
  objective: '',
  pinned: false,
  revision: 1,
  createdAt: '2026-11-09T00:00:00Z',
  updatedAt: '2026-11-09T00:00:00Z',
  archivedAt: null,
  autoStart: true,
  entries,
});
const entry = (entryId: string, patch: Partial<SessionEntry> = {}): SessionEntry => ({
  entryId,
  intent: 'steer',
  text: entryId,
  state: 'sent',
  createdAt: '2026-11-09T00:00:00Z',
  runId: 'run_one',
  executionId: 'exec',
  commandId: `cmd_${entryId}`,
  detail: null,
  ...patch,
});
const directive = (directiveId: string, commandId: string, status: DirectiveView['status']) =>
  ({ directiveId, commandId, status, targetExecutionId: 'exec' }) as DirectiveView;
function record(runId: string, directives: DirectiveView[]) {
  const projection = emptyProjection(runId);
  for (const item of directives) projection.directives[item.directiveId] = item;
  fixture.records.set(runId, { projection, definition: null });
}

async function show(
  entries: SessionEntry[],
  reads = { read: 0, started: () => 0 },
  onChange = vi.fn(),
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
          session={session(entries)}
          team={null}
          corrals={[]}
          runs={[]}
          active={null}
          liveRunId={null}
          selectedRunId={null}
          onChange={onChange}
          sessionReads={reads}
          runsListed={false}
          reference={null}
          onReferenceUsed={() => {}}
          onPanel={() => {}}
        />
      </IntlProvider>,
    ),
  );
  return { container, onChange };
}

it('each instruction gets its own directive, by the command it was sent as', async () => {
  record('run_one', [
    directive('directive_b', 'cmd_b', 'delivered'),
    directive('directive_a', 'cmd_a', 'queued'),
  ]);
  await show([
    entry('a'),
    entry('b'),
    entry('c'),
    entry('d', { runId: 'run_unread', commandId: 'cmd_d' }),
  ]);
  expect(fixture.cards.get('a')?.record?.directive.directiveId).toBe('directive_a');
  expect(fixture.cards.get('b')?.record?.directive.directiveId).toBe('directive_b');
  // Read, and no directive was made for it: not a guess at another's.
  expect(fixture.cards.get('c')?.record).toBeNull();
  // Its run's record is not read yet.
  expect(fixture.cards.get('d')?.record).toBeUndefined();
  // Before the run list is read, a row does not take a missing run to have ended.
  expect(fixture.cards.get('a')?.runsListed).toBe(false);
});

it('an instruction’s carried request is handed to it whatever became of it, removed as well', async () => {
  record('run_one', [directive('directive_a', 'cmd_a', 'expired')]);
  const removed = entry('carried', {
    intent: 'queue',
    state: 'dismissed',
    runId: null,
    carriedFrom: 'directive_a',
  });
  await show([entry('a'), removed]);
  expect(fixture.cards.get('a')?.carried).toEqual(removed);
});

it('an instruction seen to expire is held until a session read asked after it comes back', async () => {
  record('run_one', [directive('directive_a', 'cmd_a', 'expired')]);
  fixture.watched.set('directive_a', { at: 4, before: 'queued' });
  const onChange = vi.fn();
  await show([entry('a')], { read: 4, started: () => 4 }, onChange);
  expect(fixture.cards.get('a')?.heldAs).toBe('queued');
  // Seeing it expire asks for a session read.
  fixture.options?.onWatchedExpiry();
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(fixture.options?.started()).toBe(4);
  await show([entry('a')], { read: 5, started: () => 5 });
  expect(fixture.cards.get('a')?.heldAs).toBeUndefined();
});

it('a carried request is drawn as a run row only right under its source', async () => {
  record('run_one', [
    directive('directive_a', 'cmd_a', 'expired'),
    directive('directive_b', 'cmd_b', 'expired'),
  ]);
  const carriedA = entry('carried_a', {
    intent: 'queue',
    state: 'started',
    runId: 'run_two',
    carriedFrom: 'directive_a',
  });
  const carriedB = entry('carried_b', {
    intent: 'queue',
    state: 'started',
    runId: 'run_three',
    carriedFrom: 'directive_b',
  });
  // Both carried from one run: [A, B, A's request, B's request]. Neither request is right under
  // its source, so each draws its own message; A and B keep only the words.
  await show([entry('a'), entry('b'), carriedA, carriedB]);
  for (const id of ['carried_a', 'carried_b']) expect(fixture.cards.get(id)?.runOnly).toBe(false);
  // Their sources are here and say they were carried: their own lines do not.
  for (const id of ['carried_a', 'carried_b'])
    expect(fixture.cards.get(id)?.sourceShown).toBe(true);
  expect(fixture.cards.get('a')?.carried).toEqual(carriedA);
  expect(fixture.cards.get('b')?.carried).toEqual(carriedB);
  for (const id of ['a', 'b']) expect(fixture.cards.get(id)?.carriedHere).toBe(false);
  // Each right under its source: run rows alone, and the sources take their actions.
  await show([entry('a'), carriedA, entry('b'), carriedB]);
  for (const id of ['carried_a', 'carried_b']) expect(fixture.cards.get(id)?.runOnly).toBe(true);
  for (const id of ['a', 'b']) expect(fixture.cards.get(id)?.carriedHere).toBe(true);
});

it('a link to a carried request drawn as nothing goes to the message it came from', async () => {
  record('run_one', [directive('directive_a', 'cmd_a', 'expired')]);
  const refused = entry('carried', {
    intent: 'queue',
    state: 'refused',
    runId: null,
    detail: 'no such model profile',
    carriedFrom: 'directive_a',
  });
  fixture.search = { message: 'carried' };
  const f = await show([entry('a'), refused]);
  expect(
    f.container.querySelector('[aria-current="location"]')?.getAttribute('data-chat-item'),
  ).toBe('a');
});

it('a link to an advice goes to its run’s row and opens the advice there', async () => {
  fixture.search = { advice: 'run_two' };
  const f = await show([
    entry('a', { intent: 'next' }),
    entry('b', { intent: 'next', runId: 'run_two' }),
  ]);
  expect(
    f.container.querySelector('[aria-current="location"]')?.getAttribute('data-chat-item'),
  ).toBe('b');
  expect(f.container.querySelector('[data-arrival]')?.getAttribute('data-arrival')).toBe('run_two');
});
