// @vitest-environment jsdom
import { type Presence, runPresence } from '@corral/react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { type PresenceHolds, useSettledPresence } from './useSettledPresence.ts';

const working = runPresence({ status: 'running' }, [], []);
const done = runPresence({ status: 'succeeded' }, [], []);

function View({ live, holds }: { live: ReadonlyMap<string, Presence>; holds: PresenceHolds }) {
  const shown = useSettledPresence(live, undefined, holds);
  return <p>{shown.get('s')?.kind}</p>;
}

const roots: Root[] = [];
function mount(live: ReadonlyMap<string, Presence>, holds: PresenceHolds) {
  const container = document.createElement('div');
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(<View live={live} holds={holds} />));
  return {
    text: () => container.textContent,
    draw: (next: ReadonlyMap<string, Presence>) =>
      act(() => root.render(<View live={next} holds={holds} />)),
    unmount: () => act(() => root.unmount()),
  };
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
  const holds: PresenceHolds = new Map();
  const sidebar = mount(new Map([['s', working]]), holds);
  sidebar.draw(new Map([['s', done]]));
  await advance(1000);
  // The Sessions tab opens during the hold: it shows the same held state, to the same end.
  const tab = mount(new Map([['s', done]]), holds);
  expect([sidebar.text(), tab.text()]).toEqual(['working', 'working']);
  await advance(999);
  expect([sidebar.text(), tab.text()]).toEqual(['working', 'working']);
  await advance(1);
  expect([sidebar.text(), tab.text()]).toEqual(['succeeded', 'succeeded']);
});

it('forgets a session no mounted view lists, so a view opened later shows the end at once', async () => {
  const holds: PresenceHolds = new Map();
  const first = mount(new Map([['s', working]]), holds);
  first.unmount();
  expect(holds.size).toBe(0);
  const later = mount(new Map([['s', done]]), holds);
  expect(later.text()).toBe('succeeded');
});

it('clears its timer when the view closes', async () => {
  const holds: PresenceHolds = new Map();
  const view = mount(new Map([['s', working]]), holds);
  view.draw(new Map([['s', done]]));
  expect(vi.getTimerCount()).toBe(1);
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});
