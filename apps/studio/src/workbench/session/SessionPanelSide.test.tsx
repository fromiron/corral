// @vitest-environment jsdom
import type { RunSummary } from '@corral/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { ctx, panel, run } from '../panel/fixtures.ts';
import type { PanelState } from '../panel/model.ts';
import type { PanelContext } from '../panel/tabs.ts';
import { SessionPanelSide } from './SessionPanelSide.tsx';

// The panel's head and its "+" list (features/session-panel.md 탭, "+" 목록).

Element.prototype.getAnimations ??= () => [];
const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.unstubAllGlobals();
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
