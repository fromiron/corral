// @vitest-environment jsdom
import { Tabs } from '@corral/react/design-kit';
import { act, type ComponentProps, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { TopbarBar, TopbarFit, TopbarSlotContext } from '../TopbarSlot.tsx';
import { type TopbarLayout, topbarLayout } from '../topbarTier.ts';
import { DockTopBar, type PrimaryView } from './DockTopBar.tsx';

// Two ways to put the bar on a tier. `tier` sets it outright; null leaves it to the real fit,
// which measures what each tier asks for. jsdom lays nothing out, so `needs` gives those
// measurements, as a 390px phone's bar would take them.
const fixture = vi.hoisted(() => ({ tier: 0 as number | null, needs: [] as number[] }));
vi.mock('../TopbarSlot.tsx', async (original) => {
  const real = await original<typeof import('../TopbarSlot.tsx')>();
  return {
    ...real,
    useTopbarLayout: () => {
      const fitted = real.useTopbarLayout();
      return fixture.tier === null ? fitted : topbarLayout(fixture.tier);
    },
  };
});
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
  fixture.tier = 0;
  fixture.needs = [];
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
  Element.prototype.getAnimations ??= () => [];
  Element.prototype.scrollIntoView ??= () => {};
});
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Text a person reads: the kit draws each label twice, once hidden to reserve its bold width. */
function visibleText(element: Element | null | undefined) {
  const copy = element?.cloneNode(true) as Element | undefined;
  for (const hidden of copy?.querySelectorAll('[aria-hidden="true"]') ?? []) hidden.remove();
  return copy?.textContent?.trim();
}

/** A control on screen: not inside an element the bar keeps hidden for another tier. */
const shown = (element: Element) => !element.closest('[hidden]');

async function mount(props: Partial<ComponentProps<typeof DockTopBar>> = {}) {
  const topbar = document.createElement('div');
  const container = document.createElement('div');
  document.body.append(topbar, container);
  const root = createRoot(container);
  disposals.push(async () => {
    await act(async () => root.unmount());
    container.remove();
    topbar.remove();
  });
  const onSelectView = vi.fn<(view: PrimaryView) => void>();
  const openContext = vi.fn();
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <TopbarSlotContext.Provider value={{ actions: null, crumbs: null, views: topbar }}>
          <Tabs value={props.sessionView ?? 'chat'} onValueChange={() => {}}>
            <DockTopBar
              sessionView="chat"
              fileWork
              compact={false}
              active="chat"
              panels={[]}
              openContext={openContext}
              onSelectView={onSelectView}
              onSelectPane={() => {}}
              {...props}
            />
          </Tabs>
        </TopbarSlotContext.Provider>
      </IntlProvider>,
    ),
  );
  const tab = (name: string) =>
    [...topbar.querySelectorAll<HTMLElement>('[role="tab"]')].find(
      (item) => (item.getAttribute('aria-label') ?? visibleText(item)) === name,
    );
  return { topbar, onSelectView, openContext, tab };
}

it('names the session views Conversation, Files, Changes and Runs', async () => {
  const view = await mount();
  expect(
    [...view.topbar.querySelectorAll('[role="tab"]')]
      .filter(shown)
      .map((item) => visibleText(item)),
  ).toEqual(['Conversation', 'Files', 'Changes', 'Runs']);
  // While the tabs fit, the folded menu is kept hidden, never shown beside them.
  expect([...view.topbar.querySelectorAll('[role="combobox"]')].filter(shown)).toEqual([]);
});

it('marks the Changes tab with the count of changed files and keeps its name', async () => {
  const view = await mount({ changeCount: 2 });
  const changes = view.tab('Changes');
  expect(changes?.getAttribute('data-count')).toBe('2');
  expect(changes?.getAttribute('aria-label')).toBe('Changes');
  expect(changes?.getAttribute('aria-description')).toBe('2 changed files');
  // No other tab, and no tab of a session without changes, carries a count.
  expect(view.tab('Runs')?.hasAttribute('data-count')).toBe(false);
  const clean = await mount();
  expect(clean.tab('Changes')?.hasAttribute('data-count')).toBe(false);
});

it('folds the tabs into one menu that shows the current view and switches views', async () => {
  fixture.tier = 4;
  const view = await mount({ sessionView: 'changes', changeCount: 3 });
  const menus = [...view.topbar.querySelectorAll<HTMLElement>('[role="combobox"]')].filter(shown);
  expect(menus).toHaveLength(1);
  const [menu] = menus;
  expect(menu?.getAttribute('aria-label')).toBe('Conversation views');
  expect(menu?.textContent).toContain('Changes');
  expect(menu?.textContent).toContain('3');
  // The tabs stay in the document, hidden, so each panel keeps its name.
  const list = view.topbar.querySelector('[role="tablist"]');
  expect(list?.closest('[hidden]')).not.toBeNull();
  // A hidden tab lends its panel all of its text, the kit's width-reserving copy included; its
  // own name keeps the panel's name to the word, once.
  expect(
    [...(list?.querySelectorAll('[role="tab"]') ?? [])].map((item) =>
      item.getAttribute('aria-label'),
    ),
  ).toEqual(['Conversation', 'Files', 'Changes', 'Runs']);
  await act(async () => {
    menu?.focus();
    menu?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
  expect(options.map((option) => visibleText(option))).toEqual([
    'Conversation',
    'Files',
    'Changes3',
    'Runs',
  ]);
  await act(async () => options[3]?.click());
  expect(view.onSelectView).toHaveBeenCalledWith('run');
});

it('keeps the tabs where no top bar hosts them, however narrow', async () => {
  fixture.tier = 7;
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
        <Tabs value="chat" onValueChange={() => {}}>
          <DockTopBar
            sessionView="chat"
            fileWork={false}
            compact={false}
            active="chat"
            panels={[]}
            openContext={() => {}}
            onSelectView={() => {}}
            onSelectPane={() => {}}
          />
        </Tabs>
      </IntlProvider>,
    ),
  );
  expect(container.querySelectorAll('[role="tab"]')).toHaveLength(2);
  expect(container.querySelector('[role="combobox"]')).toBeNull();
  expect(container.querySelector('[role="tablist"]')?.closest('[hidden]')).toBeNull();
});

it('a narrow pane switcher reads Panes, not the open file its tab already names', async () => {
  await mount({
    sessionView: 'files',
    compact: true,
    active: 'document:readme',
    panels: [{ id: 'document:readme', title: 'README.md' }],
  });
  const toolbar = document.querySelector('[data-testid="dock-toolbar"]');
  const switcher = toolbar?.querySelector<HTMLElement>('[role="combobox"]');
  expect(switcher?.getAttribute('aria-label')).toBe('Panes');
  expect(visibleText(switcher)).toBe('Panes');
});

function Bar() {
  const [views, setViews] = useState<HTMLElement | null>(null);
  return (
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
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
    </IntlProvider>
  );
}

it('keeps the folded view menu, and its focus, while the bar tries a roomier tier', async () => {
  // The real fit, on a 390px phone's bar: it rests on its last tier (the folded view menu on a
  // second row).
  fixture.tier = null;
  fixture.needs = [1322, 1188, 1146, 1063, 838, 763, 517, 366];
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => 390);
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
      (element) => element.getAttribute('aria-label') === 'Conversation views' && shown(element),
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
