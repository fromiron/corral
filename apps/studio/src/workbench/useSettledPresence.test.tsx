// @vitest-environment jsdom
import { runPresence } from '@corral/react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LivePresence } from './sessionList.ts';
import {
  createPresenceHolds,
  type PresenceClock,
  type PresenceHolds,
  useSettledPresence,
} from './useSettledPresence.ts';

const state = (status: 'running' | 'created' | 'succeeded', runId = 'run_1'): LivePresence => ({
  presence: runPresence({ status }, [], []),
  runId,
});
const one = (live: LivePresence) => new Map([['s', live]]);

function View({
  live,
  holds,
  clock,
}: {
  live: ReadonlyMap<string, LivePresence>;
  holds: PresenceHolds;
  clock?: PresenceClock;
}) {
  const shown = useSettledPresence(live, clock, holds);
  return <p>{shown.get('s')?.kind}</p>;
}

const roots: Root[] = [];
function mount(
  live: ReadonlyMap<string, LivePresence>,
  holds: PresenceHolds,
  clock?: PresenceClock,
) {
  const container = document.createElement('div');
  const root = createRoot(container);
  roots.push(root);
  const draw = (next: ReadonlyMap<string, LivePresence>) =>
    act(() => root.render(<View live={next} holds={holds} clock={clock} />));
  draw(live);
  return { text: () => container.textContent, draw, unmount: () => act(() => root.unmount()) };
}
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('holds one session to the same end in two views, the later one included', async () => {
  const holds = createPresenceHolds();
  const sidebar = mount(one(state('running')), holds);
  sidebar.draw(one(state('succeeded')));
  await advance(1000);
  // The Sessions tab opens during the hold: it shows the same held state, to the same end.
  const tab = mount(one(state('succeeded')), holds);
  expect([sidebar.text(), tab.text()]).toEqual(['working', 'working']);
  await advance(999);
  expect([sidebar.text(), tab.text()]).toEqual(['working', 'working']);
  await advance(1);
  expect([sidebar.text(), tab.text()]).toEqual(['succeeded', 'succeeded']);
});

it('never shows a run seen ended in progress again, nor holds it anew, for an older value', async () => {
  const holds = createPresenceHolds();
  const view = mount(one(state('running')), holds);
  view.draw(one(state('succeeded')));
  await advance(2000);
  expect(view.text()).toBe('succeeded');
  // A cached list drawn first: the same run, still running.
  view.draw(one(state('running')));
  expect(view.text()).toBe('succeeded');
  view.draw(one(state('succeeded')));
  expect(view.text()).toBe('succeeded');
  expect(vi.getTimerCount()).toBe(0);
});

it('keeps another view’s hold end when a view still sees the run in progress', async () => {
  const holds = createPresenceHolds();
  const sidebar = mount(one(state('running')), holds);
  const tab = mount(one(state('running')), holds);
  sidebar.draw(one(state('succeeded')));
  const end = holds.entries.get('s')?.holdUntil;
  expect(end).toBe(Date.now() + 2000);
  await advance(500);
  // The tab judges again on its older list: the hold stays, to the same end.
  tab.draw(one(state('running')));
  expect(holds.entries.get('s')?.holdUntil).toBe(end);
  expect([sidebar.text(), tab.text()]).toEqual(['working', 'working']);
  await advance(1500);
  expect(sidebar.text()).toBe('succeeded');
  expect(tab.text()).toBe('succeeded');
});

it('shows the next run starting, which is another run', async () => {
  const holds = createPresenceHolds();
  const view = mount(one(state('running')), holds);
  view.draw(one(state('succeeded')));
  await advance(3000);
  view.draw(one(state('created', 'run_2')));
  expect(view.text()).toBe('starting');
});

it('sets its timer again when it rings before the hold ends', async () => {
  let now = 0;
  const clock = { now: () => now };
  const holds = createPresenceHolds();
  const view = mount(one(state('running')), holds, clock);
  view.draw(one(state('succeeded')));
  // The timer rings at 2 s of timer time while the clock still reads 1.5 s.
  now = 1500;
  await advance(2000);
  expect(view.text()).toBe('working');
  expect(vi.getTimerCount()).toBe(1);
  now = 2000;
  await advance(500);
  expect(view.text()).toBe('succeeded');
  expect(vi.getTimerCount()).toBe(0);
});

it('forgets a session no mounted view lists, so a view opened later shows the end at once', async () => {
  const holds = createPresenceHolds();
  const first = mount(one(state('running', 'run_9')), holds);
  first.unmount();
  expect(holds.entries.size).toBe(0);
  const later = mount(one(state('succeeded', 'run_9')), holds);
  expect(later.text()).toBe('succeeded');
});

it('clears its timer when the view closes', async () => {
  const holds = createPresenceHolds();
  const view = mount(one(state('running')), holds);
  view.draw(one(state('succeeded')));
  expect(vi.getTimerCount()).toBe(1);
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});
