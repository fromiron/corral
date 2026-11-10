// @vitest-environment jsdom
import { Tabs } from '@corral/react/design-kit';
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TopbarBar, TopbarFit, TopbarSlotContext } from '../TopbarSlot.tsx';
import type { TopbarLayout } from '../topbarTier.ts';
import { DockTopBar } from './DockTopBar.tsx';

Element.prototype.getAnimations ??= () => [];

vi.mock('use-intl', () => {
  const translate = (key: string) => key;
  return { useTranslations: () => translate };
});

// jsdom lays nothing out: what each tier asks for is given here, as a 390px phone's bar would
// measure it, so the bar rests on its last tier (the folded view menu on a second row).
const fixture = vi.hoisted(() => ({ needs: [] as number[] }));
vi.mock('../topbarTier.ts', async (original) => {
  const real = await original<typeof import('../topbarTier.ts')>();
  return {
    ...real,
    measureTopbar: (_bar: HTMLElement, layout: TopbarLayout) =>
      fixture.needs[real.TOPBAR_TIERS.indexOf(layout.tier)] ?? 0,
  };
});

const disposals: (() => Promise<void>)[] = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  fixture.needs = [1322, 1188, 1146, 1063, 838, 763, 517, 366];
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => 390);
});
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function Bar() {
  const [views, setViews] = useState<HTMLElement | null>(null);
  return (
    <TopbarFit>
      <TopbarBar>
        <div data-topbar-part="views" ref={setViews} />
      </TopbarBar>
      <TopbarSlotContext.Provider value={{ views, actions: null, crumbs: null }}>
        <Tabs value="files">
          <DockTopBar
            sessionView="files"
            fileWork
            compact
            active="context:files"
            panels={[]}
            openContext={() => {}}
            onSelectView={() => {}}
            onSelectPane={() => {}}
          />
        </Tabs>
      </TopbarSlotContext.Provider>
    </TopbarFit>
  );
}

it('keeps the folded view menu, and its focus, while the bar tries a roomier tier', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  disposals.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () => root.render(<Bar />));
  const bar = container.querySelector('header');
  expect(bar?.getAttribute('data-topbar-tier')).toBe('two-rows-menu');
  const trigger = () =>
    [...container.querySelectorAll<HTMLElement>('[role="combobox"]')].find(
      (element) =>
        element.getAttribute('aria-label') === 'sessionViews' && !element.closest('[hidden]'),
    );
  const menu = trigger();
  expect(menu).toBeDefined();
  act(() => menu?.focus());
  expect(document.activeElement).toBe(menu);
  // The content changed (another view's run pill): the tier on screen asks for a new width, so
  // the bar tries the roomier tier with tabs before it settles back on the menu.
  fixture.needs = fixture.needs.map((need) => need + 4);
  await act(async () => {
    bar?.append(document.createElement('span'));
    await Promise.resolve();
  });
  expect(bar?.getAttribute('data-topbar-tier')).toBe('two-rows-menu');
  // The same trigger is there, and still holds the keyboard.
  expect(trigger()).toBe(menu);
  expect(document.activeElement).toBe(menu);
});
