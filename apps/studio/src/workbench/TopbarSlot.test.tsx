// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TopbarBar, TopbarFit, useTopbarLayout } from './TopbarSlot.tsx';
import { TOPBAR_TIERS, type TopbarLayout } from './topbarTier.ts';

// jsdom lays nothing out: the bar's width and what each tier asks for are given here, as the
// browser measured them for a session.
const fixture = vi.hoisted(() => ({
  needs: [1322, 1063, 763, 517, 366],
  measured: [] as string[],
}));
vi.mock('./topbarTier.ts', async (original) => {
  const real = await original<typeof import('./topbarTier.ts')>();
  return {
    ...real,
    measureTopbar: (_bar: HTMLElement, layout: TopbarLayout) => {
      fixture.measured.push(layout.tier);
      return fixture.needs[real.TOPBAR_TIERS.indexOf(layout.tier)] ?? 0;
    },
  };
});

let width = 0;
const disposals: (() => Promise<void>)[] = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.measured = [];
  fixture.needs = [1322, 1063, 763, 517, 366];
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width);
});
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function Reader() {
  const layout = useTopbarLayout();
  return <output>{`${layout.project} ${layout.tools}`}</output>;
}

async function mount(barWidth: number) {
  width = barWidth;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  disposals.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () =>
    root.render(
      <TopbarFit>
        <TopbarBar className="app-topbar">
          <nav>Fix the login redirect</nav>
          <button type="button">Search</button>
        </TopbarBar>
        <Reader />
      </TopbarFit>,
    ),
  );
  const bar = container.querySelector('header');
  return {
    container,
    tier: () => bar?.getAttribute('data-topbar-tier'),
    rows: () => bar?.getAttribute('data-topbar-rows'),
    reads: () => container.querySelector('output')?.textContent,
    /** The bar's content changed: as the browser's observer would report it. */
    async change() {
      await act(async () => {
        bar?.append(document.createElement('span'));
        await Promise.resolve();
      });
    },
  };
}

it.each([
  [1440, 'full', '1', 'name bar'],
  [1184, 'short-path', '1', 'name bar'],
  [1024, 'project-icon', '1', 'icon bar'],
  [768, 'project-icon', '1', 'icon bar'],
  [600, 'two-rows', '2', 'icon bar'],
  [390, 'two-rows-menu', '2', 'icon menu'],
] as const)(
  'a %ipx bar settles at the %s tier before it is painted',
  async (barWidth, tier, rows, reads) => {
    const view = await mount(barWidth);
    expect(view.tier()).toBe(tier);
    expect(view.rows()).toBe(rows);
    expect(view.reads()).toBe(reads);
    // Every tier on the way down was laid out and measured once, in order.
    expect(fixture.measured.slice(0, TOPBAR_TIERS.indexOf(tier) + 1)).toEqual(
      TOPBAR_TIERS.slice(0, TOPBAR_TIERS.indexOf(tier) + 1),
    );
    // The name and Search are in the bar whatever the tier.
    expect(view.container.querySelector('header nav')?.textContent).toBe('Fix the login redirect');
    expect(view.container.querySelector('header button')?.textContent).toBe('Search');
  },
);

it('gives the room back when the content shrinks', async () => {
  const view = await mount(1024);
  expect(view.tier()).toBe('project-icon');
  // With less in the bar, every tier asks for less.
  fixture.needs = fixture.needs.map((need) => need - 330);
  await view.change();
  expect(view.tier()).toBe('full');
});

it('folds further when the content grows at the same width', async () => {
  const view = await mount(1200);
  expect(view.tier()).toBe('short-path');
  fixture.needs = fixture.needs.map((need) => need + 200);
  await view.change();
  expect(view.tier()).toBe('project-icon');
});

it('keeps everything where nothing is laid out', async () => {
  const view = await mount(0);
  expect(view.tier()).toBe('full');
  expect(fixture.measured).toEqual([]);
});

it('shows everything outside a fitted bar', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  disposals.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () => root.render(<Reader />));
  expect(container.textContent).toBe('name bar');
});
