// @vitest-environment jsdom
import { emptyProjection, type RunSummary, type RuntimeTransport } from '@corral/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { createRunSessions } from '../../runSessions.ts';
import { ctx, panel, run } from '../panel/fixtures.ts';
import type { PanelState } from '../panel/model.ts';
import type { PanelContext } from '../panel/tabs.ts';
import { SessionPanelSide } from './SessionPanelSide.tsx';

// The panel's head and its "+" list (features/session-panel.md 탭, "+" 목록).

// The page's run stores: a run followed live on screen (retained) says its state from there.
const stores = vi.hoisted(() => ({ services: {} as Record<string, unknown> }));
vi.mock('../../services.tsx', () => ({ useServices: () => stores.services }));

Element.prototype.getAnimations ??= () => [];
const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.unstubAllGlobals();
  stores.services = {};
});

const summary = (runId: string, status: RunSummary['status']): RunSummary => ({
  runId,
  status,
  corralId: 'team',
  projectId: 'project',
  sessionId: 'session',
  startedAt: '2026-11-17T00:00:00Z',
});

async function show({
  state,
  context = ctx({ folder: false }),
  runs,
  names = {},
}: {
  state: PanelState;
  context?: PanelContext;
  runs: RunSummary[];
  names?: Record<string, string | null>;
}) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  if (!('liveRun' in stores.services)) {
    const sessions = createRunSessions({} as RuntimeTransport);
    stores.services = { liveRun: sessions.liveRun, watchRuns: sessions.watchRuns };
  }
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const onPlus = vi.fn();
  const onOpenRun = vi.fn();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  disposals.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <SessionPanelSide
          sessionId="session"
          state={state}
          ctx={context}
          runs={runs}
          runNames={names}
          strip={{ current: null }}
          onSelect={() => {}}
          onClose={() => {}}
          onPlus={onPlus}
          terminalRow={null}
          terminals={[]}
          onTerminal={() => {}}
          onOpenRun={onOpenRun}
          onMaximize={() => {}}
          renderTab={() => null}
        />
      </IntlProvider>,
    ),
  );
  return { container, onPlus, onOpenRun };
}

/** Text a person reads: the kit draws some labels twice, once hidden to reserve their width. */
function visibleText(element: Element) {
  const copy = element.cloneNode(true) as Element;
  for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
  return copy.textContent?.trim() ?? '';
}

const click = (element: Element | null | undefined) =>
  act(async () => (element as HTMLElement | null | undefined)?.click());
const menuRows = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
const rowNamed = (name: string) => menuRows().find((row) => visibleText(row) === name);
/** The run history's rows: the kit draws a row's label twice, once hidden to hold its width. */
const runRows = () => [
  ...new Set(
    [...document.querySelectorAll<HTMLElement>('[data-run-history-row]')].map(
      (row) => row.closest<HTMLElement>('[role="menuitem"]') ?? row,
    ),
  ),
];
const plusButton = (container: HTMLElement) =>
  container.querySelector<HTMLElement>(`button[aria-label="${messages.SessionPanel.add}"]`);
const tabs = (container: HTMLElement) => [
  ...container.querySelectorAll<HTMLElement>('[role="tab"]'),
];

const three = [
  summary('run_1', 'failed'),
  summary('run_2', 'running'),
  summary('run_3', 'succeeded'),
];

it('lists every run of the conversation newest first under Runs, each with its mark, number and request', async () => {
  const view = await show({
    state: panel({ tabs: [run('run_1')], selected: 'run:run_1', presentation: 'beside' }),
    context: ctx({ folder: false, runIds: ['run_1', 'run_2', 'run_3'] }),
    runs: three,
    names: { run_1: 'Draft the notes', run_2: 'Research brief', run_3: null },
  });
  await click(plusButton(view.container));
  // Runs leads to the list instead of opening one run.
  const history = rowNamed(messages.Docking.history);
  expect(history).toBeDefined();
  await click(history);
  const rows = runRows();
  expect(rows.map(visibleText)).toEqual(['Run #3', '#2 · Research brief', '#1 · Draft the notes']);
  // The mark shows the state; the row's name says it in words, once.
  expect(
    rows.map((row) => row.querySelector('[role="img"]')?.getAttribute('aria-label') ?? null),
  ).toEqual([
    messages.Presence.state.succeeded,
    messages.Presence.state.working,
    messages.Presence.state.failed,
  ]);
  expect(rows.map((row) => row.getAttribute('aria-label'))).toEqual([
    `Run #3, ${messages.Presence.state.succeeded}`,
    `#2 · Research brief, ${messages.Presence.state.working}`,
    `#1 · Draft the notes, ${messages.Presence.state.failed}`,
  ]);
  expect(view.onPlus).not.toHaveBeenCalled();
  await click(rows[1]);
  expect(view.onOpenRun).toHaveBeenCalledExactlyOnceWith('run_2');
});

it('opens the one run of a conversation from Runs directly, with no list under it', async () => {
  const view = await show({
    state: panel({ tabs: [run('run_1')], selected: 'run:run_1', presentation: 'beside' }),
    context: ctx({ folder: false, runIds: ['run_1'] }),
    runs: [summary('run_1', 'succeeded')],
  });
  await click(plusButton(view.container));
  await click(rowNamed(messages.Docking.history));
  expect(runRows()).toEqual([]);
  expect(view.onPlus).toHaveBeenCalledExactlyOnceWith('run-history');
});

it('in the empty panel, Runs with several runs opens the same list in place', async () => {
  const view = await show({
    state: panel({ presentation: 'beside' }),
    context: ctx({ folder: false, runIds: ['run_1', 'run_2', 'run_3'] }),
    runs: three,
  });
  const entry = [...view.container.querySelectorAll<HTMLElement>('button')].find(
    (button) => visibleText(button) === messages.Docking.history,
  );
  expect(entry).toBeDefined();
  await click(entry);
  expect(runRows().map(visibleText)).toEqual(['Run #3', 'Run #2', 'Run #1']);
  await click(runRows()[2]);
  expect(view.onOpenRun).toHaveBeenCalledExactlyOnceWith('run_1');
  expect(view.onPlus).not.toHaveBeenCalled();
});

it('in the empty panel, Runs with one run opens that run directly', async () => {
  const view = await show({
    state: panel({ presentation: 'beside' }),
    context: ctx({ folder: false, runIds: ['run_1'] }),
    runs: [summary('run_1', 'succeeded')],
  });
  const entry = [...view.container.querySelectorAll<HTMLElement>('button')].find(
    (button) => visibleText(button) === messages.Docking.history,
  );
  await click(entry);
  expect(runRows()).toEqual([]);
  expect(view.onPlus).toHaveBeenCalledExactlyOnceWith('run-history');
});

it('marks a run tab with its state unless it completed, named by its number and described by its state', async () => {
  const view = await show({
    state: panel({
      tabs: [run('run_1'), run('run_2')],
      selected: 'run:run_1',
      presentation: 'beside',
    }),
    context: ctx({ folder: false, runIds: ['run_1', 'run_2'] }),
    runs: [summary('run_1', 'failed'), summary('run_2', 'succeeded')],
  });
  const [failed, completed] = tabs(view.container);
  expect(failed?.querySelector('[data-slot="tabs-closable-mark"]')).not.toBeNull();
  expect(
    failed
      ?.querySelector('[data-slot="tabs-closable-mark"] [data-presence]')
      ?.getAttribute('data-presence'),
  ).toBe('failed');
  expect(completed?.querySelector('[data-slot="tabs-closable-mark"]')).toBeNull();
  // The name stays the run's number; the state is the tab's description.
  expect(failed?.querySelector('[data-slot="tabs-closable-label"]')?.textContent).toBe('Run #1');
  expect(completed?.querySelector('[data-slot="tabs-closable-label"]')?.textContent).toBe('Run #2');
  expect(failed?.getAttribute('aria-description')).toBe(messages.Presence.state.failed);
  expect(completed?.hasAttribute('aria-description')).toBe(false);
});

it('gives a restored run tab no mark and no description before the run list answers', async () => {
  const view = await show({
    state: panel({ tabs: [run('run_1')], selected: 'run:run_1', presentation: 'beside' }),
    context: ctx({ folder: false, runIds: null }),
    runs: [],
  });
  const [tab] = tabs(view.container);
  expect(tab?.querySelector('[data-slot="tabs-closable-mark"]')).toBeNull();
  expect(tab?.hasAttribute('aria-description')).toBe(false);
});

// presence.md: one run is one state on a screen. The run list can lag the run itself; a run that
// is followed live (its record or the conversation holds its store) says its live state.
describe('a run tab and the run history say the state the run says live', () => {
  const live = (status: 'running' | 'awaiting_user' | 'succeeded') => {
    const sessions = createRunSessions({} as RuntimeTransport);
    stores.services = { liveRun: sessions.liveRun, watchRuns: sessions.watchRuns };
    const store = sessions.runFor('run_1');
    const projection = { ...emptyProjection('run_1'), status };
    store.setState({ runId: 'run_1', projection, events: [] });
    return {
      sessions,
      store,
      setStatus: (next: typeof status) =>
        act(async () =>
          store.setState({ projection: { ...emptyProjection('run_1'), status: next } }),
        ),
    };
  };
  const mark = (container: HTMLElement, index = 0) =>
    tabs(container)
      [index]?.querySelector('[data-slot="tabs-closable-mark"] [data-presence]')
      ?.getAttribute('data-presence') ?? null;
  const twoTabs = panel({
    tabs: [run('run_1'), run('run_2')],
    selected: 'run:run_1',
    presentation: 'drawer',
  });
  const twoRuns = ctx({ folder: false, runIds: ['run_1', 'run_2'] });

  it('says the run waits for the person while its list still says it works, and follows it back', async () => {
    const { sessions, setStatus } = live('awaiting_user');
    sessions.retainRun('run_1');
    const view = await show({
      state: twoTabs,
      context: twoRuns,
      runs: [summary('run_1', 'running'), summary('run_2', 'failed')],
    });
    expect(mark(view.container)).toBe('awaiting_user');
    expect(tabs(view.container)[0]?.getAttribute('aria-description')).toBe(
      messages.Presence.state.awaiting_user,
    );
    // The run history says the same.
    await click(plusButton(view.container));
    await click(rowNamed(messages.Docking.history));
    expect(runRows()[1]?.getAttribute('aria-label')).toBe(
      `Run #1, ${messages.Presence.state.awaiting_user}`,
    );
    // Back to work: the mark follows.
    await setStatus('running');
    expect(mark(view.container)).toBe('working');
    expect(tabs(view.container)[0]?.getAttribute('aria-description')).toBe(
      messages.Presence.state.working,
    );
  });

  it('takes the live state from the moment the run is followed, and leaves it when no longer', async () => {
    const { sessions } = live('awaiting_user');
    const view = await show({
      state: twoTabs,
      context: twoRuns,
      runs: [summary('run_1', 'running'), summary('run_2', 'failed')],
    });
    // Not followed: a store left from earlier may be stale, so the list says the state.
    expect(mark(view.container)).toBe('working');
    let release = () => {};
    await act(async () => {
      release = sessions.retainRun('run_1');
    });
    expect(mark(view.container)).toBe('awaiting_user');
    await act(async () => release());
    expect(mark(view.container)).toBe('working');
  });

  it('marks a restored tab never viewed by the run list', async () => {
    live('running');
    const view = await show({
      state: twoTabs,
      context: twoRuns,
      runs: [summary('run_1', 'running'), summary('run_2', 'failed')],
    });
    expect(mark(view.container, 1)).toBe('failed');
    expect(tabs(view.container)[1]?.getAttribute('aria-description')).toBe(
      messages.Presence.state.failed,
    );
  });

  it('marks nothing for a run completed live, and nothing before the run list answers', async () => {
    const { sessions } = live('succeeded');
    sessions.retainRun('run_1');
    const completed = await show({
      state: twoTabs,
      context: twoRuns,
      runs: [summary('run_1', 'running'), summary('run_2', 'failed')],
    });
    expect(mark(completed.container)).toBeNull();
    expect(tabs(completed.container)[0]?.hasAttribute('aria-description')).toBe(false);
    const unanswered = await show({
      state: twoTabs,
      context: ctx({ folder: false, runIds: null }),
      runs: [],
    });
    expect(mark(unanswered.container)).toBeNull();
  });
});
