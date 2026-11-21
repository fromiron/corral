import type { Meta, StoryObj } from '@storybook/react-vite';
import { Bug, File, GitCompare, Maximize2, Package, Play, Plus, Terminal } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { expect, fireEvent, fn, waitFor, within } from 'storybook/test';
import { Button } from './button.tsx';
import {
  TabsClosable,
  type TabsClosableHandle,
  TabsClosablePanel,
  type TabsClosableTab,
} from './tabs-closable.tsx';

const sample: TabsClosableTab[] = [
  { id: 'files', label: '파일', icon: File },
  { id: 'changes', label: '변경', icon: GitCompare },
  { id: 'run-1', label: '실행 #1', shortLabel: '#1', icon: Play },
  { id: 'run-2', label: '실행 #2', shortLabel: '#2', icon: Play },
  { id: 'run-12', label: '실행 #12', shortLabel: '#12', icon: Play },
  { id: 'artifacts', label: '결과', icon: Package },
];

/** Longer names, to show them shrinking before they drop. */
const longer: TabsClosableTab[] = [
  { id: 'files', label: '파일 목록', icon: File },
  { id: 'changes', label: '변경 검토', icon: GitCompare },
  { id: 'run-1', label: '실행 기록 #1', shortLabel: '#1', icon: Play },
  { id: 'artifacts', label: '결과 목록', icon: Package },
];

/** The testing library's pointer has no coordinates; the strip finds the tab under the pointer. */
function pointAt(element: HTMLElement) {
  const box = element.getBoundingClientRect();
  fireEvent.mouseMove(element, {
    clientX: box.left + box.width / 2,
    clientY: box.top + box.height / 2,
  });
}

/** A host model: closing the selected tab selects its right neighbour, else its left one. */
function Host({
  tabs: initialTabs = sample,
  initial = 'files',
  width,
  onClose,
  testId,
  controls = false,
  reorder = false,
}: {
  tabs?: TabsClosableTab[];
  initial?: string;
  width?: number;
  onClose?: (id: string) => void;
  testId?: string;
  /** Host buttons outside the strip: select the last tab, and render again. */
  controls?: boolean;
  /** The host lets tabs be dragged and moved with Mod+Shift+arrows. */
  reorder?: boolean;
}) {
  const [tabs, setTabs] = useState(initialTabs);
  const [, setRenders] = useState(0);
  const [selected, setSelected] = useState<string | null>(initial);
  const [maximized, setMaximized] = useState(false);
  const strip = useRef<TabsClosableHandle>(null);
  const root = useRef<HTMLDivElement>(null);
  const [focusNext, setFocusNext] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (focusNext === null) return;
    strip.current?.focusTab(focusNext);
    setFocusNext(null);
  }, [focusNext]);
  const prefix = testId ?? 'story';
  return (
    <div
      ref={root}
      data-testid={testId}
      className="flex flex-col rounded-xl border border-border bg-background"
      // Story URLs pass the width as text.
      style={{ width: width === undefined ? undefined : Number(width) }}
    >
      <div className="flex h-10 items-center px-2">
        <TabsClosable
          ref={strip}
          className="flex-1"
          aria-label="패널 탭"
          idPrefix={prefix}
          // A fresh array of equal tabs on every render, as a host deriving them would pass.
          tabs={tabs.map((tab) => ({ ...tab }))}
          selectedId={selected}
          onSelect={setSelected}
          closeLabel={(tab) => `${tab.label} 닫기`}
          onClose={(id) => {
            onClose?.(id);
            const index = tabs.findIndex((tab) => tab.id === id);
            const rest = tabs.filter((tab) => tab.id !== id);
            const neighbour = (rest[index] ?? rest[index - 1])?.id ?? null;
            const hadFocus = root.current?.contains(document.activeElement) ?? false;
            const nextSelected = id === selected ? neighbour : selected;
            setTabs(rest);
            setSelected(nextSelected);
            if (hadFocus) setFocusNext(id === selected ? nextSelected : neighbour);
          }}
          {...(reorder
            ? {
                onReorder: (id: string, to: number) =>
                  setTabs((current) => {
                    const tab = current.find((item) => item.id === id);
                    if (!tab) return current;
                    const rest = current.filter((item) => item.id !== id);
                    return [...rest.slice(0, to), tab, ...rest.slice(to)];
                  }),
                announceMove: (tab: TabsClosableTab, position: number, count: number) =>
                  `${tab.label}: ${position}번째 / ${count}개`,
              }
            : {})}
          trailing={
            <Button variant="ghost" size="icon-compact" aria-label="탭 열기">
              <Plus />
            </Button>
          }
          end={
            <Button
              variant="ghost"
              size="icon-compact"
              aria-label="넓히기"
              aria-pressed={maximized}
              onClick={() => setMaximized((value) => !value)}
            >
              <Maximize2 />
            </Button>
          }
        />
      </div>
      {controls ? (
        <div className="flex gap-1 border-t border-border px-2 py-1">
          <Button
            size="compact"
            variant="ghost"
            onClick={() => setSelected(tabs[tabs.length - 1]?.id ?? null)}
          >
            끝 탭
          </Button>
          <Button size="compact" variant="ghost" onClick={() => setRenders((n) => n + 1)}>
            다시 그리기
          </Button>
          <Button
            size="compact"
            variant="ghost"
            onClick={() =>
              setTabs((current) => [
                ...current,
                {
                  id: `run-${current.length + 10}`,
                  label: `실행 #${current.length + 10}`,
                  shortLabel: `#${current.length + 10}`,
                  icon: Play,
                },
              ])
            }
          >
            탭 추가
          </Button>
        </div>
      ) : null}
      {tabs.map((tab) => (
        <TabsClosablePanel
          key={tab.id}
          idPrefix={prefix}
          tabId={tab.id}
          selected={tab.id === selected}
          className="border-t border-border px-3 py-4 text-ui text-muted-foreground"
        >
          {tab.label}
        </TabsClosablePanel>
      ))}
    </div>
  );
}

/** Four tabs as the panel has them, and eight with several runs. */
const four = [sample[0], sample[1], sample[2], sample[5]] as TabsClosableTab[];
const eight: TabsClosableTab[] = [
  ...four,
  ...[2, 3, 4, 5].map((n) => ({
    id: `run-${n}`,
    label: `실행 #${n}`,
    shortLabel: `#${n}`,
    icon: Play,
  })),
];

/** Nine tabs, for a strip that scrolls. */
const nine: TabsClosableTab[] = [
  ...sample,
  ...[3, 4, 5, 6].map((n) => ({
    id: `run-${n}`,
    label: `실행 #${n}`,
    shortLabel: `#${n}`,
    icon: Play,
  })),
];

const meta = {
  title: 'Design kit/TabsClosable',
  component: Host,
  args: { onClose: fn() },
  argTypes: {
    tabs: {
      options: ['four', 'eight', 'nine', 'longer'],
      mapping: { four, eight, nine, longer },
      control: 'select',
    },
    initial: { control: 'text' },
    width: { control: 'number' },
  },
} satisfies Meta<typeof Host>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Keyboard: Story = {
  args: { width: 640, tabs: sample.slice(0, 4) },
  play: async ({ canvasElement, userEvent, args }) => {
    const canvas = within(canvasElement);
    const tab = (name: string) => canvas.getByRole('tab', { name });
    tab('파일').focus();
    await userEvent.keyboard('{ArrowRight}');
    await expect(tab('변경')).toHaveFocus();
    await expect(tab('파일')).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{Enter}');
    await expect(tab('변경')).toHaveAttribute('aria-selected', 'true');
    await expect(canvas.getByRole('tabpanel', { name: '변경' })).toBeVisible();
    // Delete closes the focused tab; this host selects its right neighbour and focuses it.
    await userEvent.keyboard('{Delete}');
    await expect(args.onClose).toHaveBeenCalledWith('changes');
    await waitFor(() => expect(tab('실행 #1')).toHaveFocus());
    await expect(tab('실행 #1')).toHaveAttribute('aria-selected', 'true');
    // An unselected tab closes without moving the selection.
    await userEvent.keyboard('{ArrowLeft}{Delete}');
    await expect(args.onClose).toHaveBeenLastCalledWith('files');
    await expect(tab('실행 #1')).toHaveAttribute('aria-selected', 'true');
    await expect(canvas.getByRole('button', { name: '실행 #2 닫기' })).toHaveAttribute(
      'tabindex',
      '-1',
    );
    // Space selects too.
    await userEvent.keyboard('{ArrowRight} ');
    await expect(tab('실행 #2')).toHaveAttribute('aria-selected', 'true');
    await expect(tab('실행 #2')).toHaveFocus();
  },
};

/** The selected tab's close control stands after its name; an unselected tab's appears in its
 *  icon's place on hover, with no shift. */
export const HoverClose: Story = {
  args: { width: 640, tabs: sample.slice(0, 3) },
  play: async ({ canvasElement, userEvent, args }) => {
    const canvas = within(canvasElement);
    const changes = canvas.getByRole('tab', { name: '변경' });
    const close = canvas.getByRole('button', { name: '변경 닫기' });
    const selectedClose = canvas.getByRole('button', { name: '파일 닫기' });
    await waitFor(() => expect(getComputedStyle(selectedClose).opacity).toBe('1'));
    await expect(getComputedStyle(close).opacity).toBe('0');
    // After the selected tab's name, inside its end, with a 24px hit box.
    const files = canvas.getByRole('tab', { name: '파일' }).getBoundingClientRect();
    const name = canvas
      .getByRole('tab', { name: '파일' })
      .querySelector('[data-slot="tabs-closable-label"]') as HTMLElement;
    const selectedBox = selectedClose.getBoundingClientRect();
    await expect(selectedBox.width).toBe(24);
    await expect(selectedBox.left).toBeGreaterThanOrEqual(name.getBoundingClientRect().right);
    await expect(selectedBox.right).toBeLessThanOrEqual(files.right);
    const before = changes.getBoundingClientRect();
    pointAt(changes);
    await waitFor(() => expect(getComputedStyle(close).opacity).toBe('1'));
    const after = changes.getBoundingClientRect();
    await expect(after.width).toBe(before.width);
    await expect(after.left).toBe(before.left);
    // The control lies over the tab's leading slot, inside the tab.
    const box = close.getBoundingClientRect();
    await expect(box.left).toBeGreaterThanOrEqual(after.left);
    await expect(box.right).toBeLessThan(after.left + after.width / 2 + 12);
    await expect(box.width).toBe(24);
    // Moving onto the control keeps it shown, and pressing it closes that tab only.
    pointAt(close);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await expect(getComputedStyle(close).opacity).toBe('1');
    await userEvent.click(close);
    await expect(args.onClose).toHaveBeenCalledWith('changes');
    await expect(canvas.getByRole('tab', { name: '파일' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    // Beyond the last tab the pointer hovers nothing.
    const strip = canvasElement.querySelector<HTMLElement>('[data-slot="tabs-closable-scroller"]');
    const end = (strip as HTMLElement).getBoundingClientRect();
    const tablist = canvas.getByRole('tablist').parentElement as HTMLElement;
    fireEvent.mouseLeave(tablist);
    fireEvent.mouseMove(strip as HTMLElement, { clientX: end.right - 8, clientY: end.top + 14 });
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const last = canvas.getByRole('button', { name: '실행 #1 닫기' });
    await expect(getComputedStyle(last).opacity).toBe('0');
  },
};

/** Whether a tab's name is cut short (truncated), and whether it is shown at all. */
function nameState(tab: HTMLElement) {
  const name = tab.querySelector<HTMLElement>('[data-slot="tabs-closable-name"]');
  const label = tab.querySelector<HTMLElement>('[data-slot="tabs-closable-label"]');
  if (!name || !label) throw new Error('Missing a tab name');
  const hidden = name.getBoundingClientRect().width <= 1;
  return { hidden, cut: !hidden && label.scrollWidth > label.clientWidth + 1 };
}

/** The strip's stage, after checking what holds at every stage. Throws until laid out. */
function stage(strip: HTMLElement) {
  const tabs = within(strip).getAllByRole('tab');
  const selected = tabs.find((tab) => tab.getAttribute('aria-selected') === 'true');
  if (!selected) throw new Error('Missing the selected tab');
  const scroller = strip.querySelector<HTMLElement>('[data-slot="tabs-closable-scroller"]');
  if (!scroller) throw new Error('Missing the scroller');
  const states = tabs.map(nameState);
  const others = states.filter((_, index) => tabs[index] !== selected);
  const compact = others.some((state) => state.hidden);
  // The selected tab always shows its whole name.
  expect(nameState(selected)).toEqual({ hidden: false, cut: false });
  // Names drop together: once one unselected name is gone, all are.
  if (compact) expect(others.every((state) => state.hidden)).toBe(true);
  // The strip scrolls only after the names have gone.
  const scrolls = scroller.scrollWidth > scroller.clientWidth + 1;
  if (scrolls) expect(compact).toBe(true);
  // The selected tab is in view.
  const view = scroller.getBoundingClientRect();
  const box = selected.getBoundingClientRect();
  expect(box.left).toBeGreaterThanOrEqual(view.left);
  expect(box.right).toBeLessThanOrEqual(view.right);
  // "+" follows the last tab, or the strip once it scrolls; maximize stands at the far right.
  // Neither scrolls away.
  const root = strip.querySelector('[data-slot="tabs-closable"]') as HTMLElement;
  const rootBox = root.getBoundingClientRect();
  const plus = within(strip).getByRole('button', { name: '탭 열기' }).getBoundingClientRect();
  const maximize = within(strip).getByRole('button', { name: '넓히기' }).getBoundingClientRect();
  const lastTab = (tabs[tabs.length - 1] as HTMLElement).getBoundingClientRect();
  expect(plus.left).toBeGreaterThanOrEqual(rootBox.left);
  expect(maximize.right).toBeLessThanOrEqual(rootBox.right);
  expect(rootBox.right - maximize.right).toBeLessThan(1);
  expect(maximize.left - plus.right).toBeGreaterThanOrEqual(8);
  if (scrolls) expect(plus.left - view.right).toBeGreaterThanOrEqual(12);
  else expect(plus.left - lastTab.right).toBeLessThan(1);
  return { compact, scrolls, cut: others.some((state) => state.cut) };
}

/** The overflow stages at three panel widths, the run tab selected at the end. */
export const Overflow: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      <Host testId="wide" width={900} initial="run-12" />
      <Host testId="medium" width={480} initial="run-12" />
      <Host testId="narrow" width={360} initial="run-12" />
      <Host testId="shrink" width={430} tabs={longer} initial="files" />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await document.fonts.ready;
    // The strips measure again once the fonts are in; read each stage once settled.
    const settle = (id: string, expected: ReturnType<typeof stage>) =>
      waitFor(() => expect(stage(canvas.getByTestId(id))).toEqual(expected));
    await settle('wide', { compact: false, scrolls: false, cut: false });
    await settle('medium', { compact: true, scrolls: false, cut: false });
    await settle('narrow', { compact: true, scrolls: true, cut: false });
    await settle('shrink', { compact: false, scrolls: false, cut: true });
  },
};

/** Keyboard focus at either end of a scrolling strip keeps its whole ring in view. */
export const EdgeFocus: Story = {
  args: { width: 360, initial: 'run-12', tabs: nine },
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await document.fonts.ready;
    const scroller = canvasElement.querySelector<HTMLElement>(
      '[data-slot="tabs-closable-scroller"]',
    ) as HTMLElement;
    await waitFor(() => expect(scroller.scrollWidth).toBeGreaterThan(scroller.clientWidth));
    const ringInView = () =>
      waitFor(() => {
        const ring = canvasElement.querySelector('[data-slot="tabs-closable-focus-ring"]');
        if (!ring) throw new Error('Missing the focus ring');
        const box = ring.getBoundingClientRect();
        const view = scroller.getBoundingClientRect();
        expect(box.left).toBeGreaterThanOrEqual(view.left);
        expect(box.right).toBeLessThanOrEqual(view.right);
        expect(box.top).toBeGreaterThanOrEqual(view.top);
        expect(box.bottom).toBeLessThanOrEqual(view.bottom);
      });
    await userEvent.tab();
    await expect(canvas.getByRole('tab', { name: '실행 #12' })).toHaveFocus();
    await userEvent.keyboard('{Home}');
    await expect(canvas.getByRole('tab', { name: '파일' })).toHaveFocus();
    await ringInView();
    await userEvent.keyboard('{End}');
    await expect(canvas.getByRole('tab', { name: '실행 #6' })).toHaveFocus();
    await ringInView();
    // From the first tab the arrows wrap to the last one, across the whole strip.
    await userEvent.keyboard('{Home}');
    await ringInView();
    await userEvent.keyboard('{ArrowLeft}');
    await expect(canvas.getByRole('tab', { name: '실행 #6' })).toHaveFocus();
    await ringInView();
    // The focused tab, shrunk to its icon, names itself; axe reads the tooltip once it is in.
    const tip = await within(canvasElement.ownerDocument.body).findByRole('tooltip');
    await waitFor(() =>
      expect(getComputedStyle(tip.firstElementChild as Element).opacity).toBe('1'),
    );
  },
};

/** An unselected tab shrunk to its icon names itself in the kit's tooltip, on keyboard focus
 *  and on hover; the close control under the pointer names the tab it closes. */
export const IconOnlyTooltip: Story = {
  args: { width: 360, initial: 'run-12' },
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    const page = within(canvasElement.ownerDocument.body);
    await document.fonts.ready;
    const run2 = canvas.getByRole('tab', { name: '실행 #2' });
    await waitFor(() => expect(nameState(run2).hidden).toBe(true));
    await expect(run2).not.toHaveAttribute('title');
    await userEvent.tab();
    await userEvent.keyboard('{ArrowLeft}');
    await expect(run2).toHaveFocus();
    const tip = await page.findByRole('tooltip');
    await expect(tip).toHaveTextContent('실행 #2');
    await waitFor(() =>
      expect(getComputedStyle(tip.firstElementChild as Element).opacity).toBe('1'),
    );
    // A short label is text: the close control takes the icon's place.
    await waitFor(() =>
      expect(getComputedStyle(canvas.getByRole('button', { name: '실행 #2 닫기' })).opacity).toBe(
        '1',
      ),
    );
    // Escape closes the tooltip and goes on, unhandled, to whatever listens under it.
    const escapes: boolean[] = [];
    const listen = (event: KeyboardEvent) => {
      if (event.key === 'Escape') escapes.push(event.defaultPrevented);
    };
    window.addEventListener('keydown', listen);
    await userEvent.keyboard('{Escape}');
    window.removeEventListener('keydown', listen);
    await expect(escapes).toEqual([false]);
    await waitFor(() => expect(page.queryByRole('tooltip')).toBeNull());
    await expect(run2).toHaveFocus();
    // Dismissed only until the focus comes back.
    await userEvent.keyboard('{ArrowRight}{ArrowLeft}');
    await expect(run2).toHaveFocus();
    await waitFor(async () =>
      expect(await page.findByRole('tooltip')).toHaveTextContent('실행 #2'),
    );
    // A tab shrunk to its icon alone shows no close control: a press only selects it.
    await userEvent.keyboard('{Home}{ArrowRight}');
    const changes = canvas.getByRole('tab', { name: '변경' });
    await expect(changes).toHaveFocus();
    await waitFor(async () => expect(await page.findByRole('tooltip')).toHaveTextContent('변경'));
    await expect(getComputedStyle(canvas.getByRole('button', { name: '변경 닫기' })).opacity).toBe(
      '0',
    );
    // A tab whose whole name shows has no tooltip.
    await userEvent.keyboard('{End}{ArrowLeft}');
    await expect(canvas.getByRole('tab', { name: '실행 #12' })).toHaveFocus();
    await new Promise((resolve) => setTimeout(resolve, 700));
    await expect(page.queryByRole('tooltip')).toBeNull();
    // The close control's tooltip is its accessible name.
    const close = canvas.getByRole('button', { name: '실행 #12 닫기' });
    await userEvent.hover(close);
    const closeTip = await page.findByRole('tooltip');
    await expect(closeTip).toHaveTextContent('실행 #12 닫기');
    await userEvent.unhover(close);
    await waitFor(() => expect(page.queryByRole('tooltip')).toBeNull());
  },
};

/** A name cut short in the shrinking stage shows whole in the tooltip. */
export const CutNameTooltip: Story = {
  args: { width: 430, tabs: longer, initial: 'files' },
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    const page = within(canvasElement.ownerDocument.body);
    await document.fonts.ready;
    const changes = canvas.getByRole('tab', { name: '변경 검토' });
    await waitFor(() => expect(nameState(changes).cut).toBe(true));
    await userEvent.hover(changes);
    pointAt(changes);
    const tip = await page.findByRole('tooltip');
    await expect(tip).toHaveTextContent('변경 검토');
    await waitFor(() =>
      expect(getComputedStyle(tip.firstElementChild as Element).opacity).toBe('1'),
    );
    // A named tab under the pointer shows its close control in its icon's place.
    await expect(
      getComputedStyle(canvas.getByRole('button', { name: '변경 검토 닫기' })).opacity,
    ).toBe('1');
    // Escape closes it; the next time the pointer arrives it opens again.
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(page.queryByRole('tooltip')).toBeNull());
    await userEvent.unhover(changes);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await userEvent.hover(changes);
    await waitFor(async () =>
      expect(await page.findByRole('tooltip')).toHaveTextContent('변경 검토'),
    );
    await waitFor(() =>
      expect(getComputedStyle(page.getByRole('tooltip').firstElementChild as Element).opacity).toBe(
        '1',
      ),
    );
    await userEvent.unhover(changes);
    await waitFor(() => expect(page.queryByRole('tooltip')).toBeNull());
  },
};

/** A strip narrowed within a stage (a splitter drag) keeps the selected tab in view, and the
 *  trailing controls clear of the fade once it scrolls. */
export const Narrowed: Story = {
  args: { width: 760, tabs: nine, initial: 'run-6', testId: 'narrowed' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await document.fonts.ready;
    const host = canvas.getByTestId('narrowed');
    const scroller = canvasElement.querySelector<HTMLElement>(
      '[data-slot="tabs-closable-scroller"]',
    ) as HTMLElement;
    const selected = canvas.getByRole('tab', { name: '실행 #6' });
    await waitFor(() =>
      expect(nameState(canvas.getByRole('tab', { name: '변경' })).hidden).toBe(true),
    );
    await expect(scroller.scrollWidth).toBeLessThanOrEqual(scroller.clientWidth + 1);
    host.style.width = '320px';
    await waitFor(() => {
      expect(scroller.scrollWidth).toBeGreaterThan(scroller.clientWidth + 1);
      const view = scroller.getBoundingClientRect();
      const box = selected.getBoundingClientRect();
      expect(box.left).toBeGreaterThanOrEqual(view.left);
      expect(box.right).toBeLessThanOrEqual(view.right);
      const trailing = canvas.getByRole('button', { name: '탭 열기' }).getBoundingClientRect();
      expect(trailing.left - view.right).toBeGreaterThanOrEqual(12);
    });
  },
};

/** A selection made elsewhere (the host's) brings the selected tab into view; renders with an
 *  equal new array of tabs move nothing and reopen no tooltip. */
export const HostChanges: Story = {
  args: { width: 360, tabs: nine, initial: 'files', controls: true },
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    const page = within(canvasElement.ownerDocument.body);
    await document.fonts.ready;
    const scroller = canvasElement.querySelector<HTMLElement>(
      '[data-slot="tabs-closable-scroller"]',
    ) as HTMLElement;
    await waitFor(() => expect(scroller.scrollWidth).toBeGreaterThan(scroller.clientWidth));
    await expect(scroller.scrollLeft).toBe(0);
    canvas.getByRole('button', { name: '끝 탭' }).click();
    const last = canvas.getByRole('tab', { name: '실행 #6' });
    await waitFor(() => expect(last).toHaveAttribute('aria-selected', 'true'));
    await waitFor(() => {
      const view = scroller.getBoundingClientRect();
      const box = last.getBoundingClientRect();
      expect(box.left).toBeGreaterThanOrEqual(view.left);
      expect(box.right).toBeLessThanOrEqual(view.right);
    });
    // Focus an icon-only tab, let its tooltip open, then dismiss it.
    last.focus();
    await userEvent.keyboard('{ArrowLeft}');
    const run5 = canvas.getByRole('tab', { name: '실행 #5' });
    await expect(run5).toHaveFocus();
    await page.findByRole('tooltip');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(page.queryByRole('tooltip')).toBeNull());
    const scrolled = scroller.scrollLeft;
    const focusins: Event[] = [];
    const count = (event: Event) => focusins.push(event);
    canvasElement.addEventListener('focusin', count, true);
    const again = canvas.getByRole('button', { name: '다시 그리기' });
    for (let round = 0; round < 5; round++) {
      again.click();
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    await new Promise((resolve) => setTimeout(resolve, 700));
    canvasElement.removeEventListener('focusin', count, true);
    await expect(focusins).toHaveLength(0);
    await expect(scroller.scrollLeft).toBe(scrolled);
    await expect(run5).toHaveFocus();
    await expect(page.queryByRole('tooltip')).toBeNull();
    // A vertical wheel scrolls the strip sideways.
    scroller.scrollLeft = 0;
    scroller.dispatchEvent(
      new WheelEvent('wheel', { deltaY: 60, deltaX: 0, bubbles: true, cancelable: true }),
    );
    await expect(scroller.scrollLeft).toBeGreaterThan(0);
  },
};

const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A tooltip the pointer asked for while its name showed stays shut once the name goes: the
 *  pointer rests on the selected tab, and the host selects another. */
export const NoStrayTooltip: Story = {
  args: { width: 360, tabs: nine, initial: 'run-12', controls: true },
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    const page = within(canvasElement.ownerDocument.body);
    await document.fonts.ready;
    const run12 = canvas.getByRole('tab', { name: '실행 #12' });
    await waitFor(() =>
      expect(nameState(canvas.getByRole('tab', { name: '변경' })).hidden).toBe(true),
    );
    await userEvent.hover(run12);
    pointAt(run12);
    await pause(800);
    await expect(page.queryByRole('tooltip')).toBeNull();
    canvas.getByRole('button', { name: '끝 탭' }).click();
    await waitFor(() => expect(nameState(run12).hidden).toBe(true));
    await pause(800);
    await expect(page.queryByRole('tooltip')).toBeNull();
    await userEvent.unhover(run12);
  },
};

/** When a resize flips the stage, the selected pill and close control are on their tab from the
 *  first frame the new stage paints. */
export const StageFlipFrames: Story = {
  args: { width: 640, tabs: four, initial: 'artifacts', testId: 'flip' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await document.fonts.ready;
    const host = canvas.getByTestId('flip');
    const selected = canvas.getByRole('tab', { name: '결과' });
    const close = canvas.getByRole('button', { name: '결과 닫기' });
    const tablist = canvas.getByRole('tablist');
    const pill = tablist.querySelector(':scope > [aria-hidden="true"]') as HTMLElement;
    await waitFor(() => expect(getComputedStyle(close).opacity).toBe('1'));
    const offsets = () => {
      const tab = selected.getBoundingClientRect();
      return {
        close: Math.abs(close.getBoundingClientRect().right - (tab.right - 4)),
        pill: Math.abs(pill.getBoundingClientRect().left - tab.left),
      };
    };
    await expect(offsets().close).toBeLessThanOrEqual(2);
    host.style.width = '260px';
    // The first frame reads the new width before anything has heard of it; from the next one on,
    // every frame is in place.
    await frame();
    const seen = [];
    for (let index = 0; index < 4; index++) {
      await frame();
      seen.push(offsets());
    }
    await expect(nameState(canvas.getByRole('tab', { name: '변경' })).hidden).toBe(true);
    for (const offset of seen) {
      await expect(offset.close).toBeLessThanOrEqual(2);
      await expect(offset.pill).toBeLessThanOrEqual(2);
    }
  },
};

/** A key that moves no focus leaves no stale scroll behind for the next focus to jump back to. */
export const NoLurch: Story = {
  args: { width: 360, tabs: nine, initial: 'files' },
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await document.fonts.ready;
    const scroller = canvasElement.querySelector<HTMLElement>(
      '[data-slot="tabs-closable-scroller"]',
    ) as HTMLElement;
    await waitFor(() => expect(scroller.scrollWidth).toBeGreaterThan(scroller.clientWidth));
    await userEvent.tab();
    await userEvent.keyboard('{Enter}');
    scroller.scrollLeft = scroller.scrollWidth;
    await frame();
    const end = scroller.scrollLeft;
    const lows: number[] = [];
    const watch = () => lows.push(scroller.scrollLeft);
    scroller.addEventListener('scroll', watch);
    await userEvent.click(canvas.getByRole('tab', { name: '실행 #6' }));
    await pause(500);
    scroller.removeEventListener('scroll', watch);
    // The tab is brought clear of the fade (a few px); before, the strip jumped back ~100px.
    await expect(Math.min(end, ...lows)).toBeGreaterThanOrEqual(end - 8);
  },
};

/** A tab focused by a press, then unselected by the host, shows no close control in its icon's
 *  place: that is for keyboard focus and the pointer. */
export const PressFocusNoClose: Story = {
  args: { width: 640, tabs: four, initial: 'files', controls: true },
  play: async ({ canvasElement }) => {
    // A real press, which the testing library's click is not; runs only under the test runner.
    if ((import.meta as { env?: { MODE?: string } }).env?.MODE !== 'test') return;
    const { userEvent } = await import('vitest/browser' as string);
    const canvas = within(canvasElement);
    const changes = canvas.getByRole('tab', { name: '변경' });
    await userEvent.click(changes);
    await expect(changes).toHaveAttribute('aria-selected', 'true');
    await userEvent.hover(canvas.getByRole('tabpanel'));
    canvas.getByRole('button', { name: '끝 탭' }).click();
    await waitFor(() => expect(changes).toHaveAttribute('aria-selected', 'false'));
    await expect(changes).toHaveFocus();
    await pause(200);
    await expect(getComputedStyle(canvas.getByRole('button', { name: '변경 닫기' })).opacity).toBe(
      '0',
    );
    // A real key puts the page back in keyboard modality for the stories after this one.
    await userEvent.keyboard('{Shift}');
  },
};

const order = (canvasElement: HTMLElement) =>
  within(canvasElement)
    .getAllByRole('tab')
    .map((tab) => tab.id.replace('story-tab-', ''));

/** Mod+Shift+arrows move the focused tab; the focus and its ring stay on it, and its place is
 *  said. */
export const ReorderKeyboard: Story = {
  args: { width: 640, tabs: four, initial: 'files', reorder: true },
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    const changes = canvas.getByRole('tab', { name: '변경' });
    const announcer = canvasElement.querySelector('[data-slot="tabs-closable-announcer"]');
    const ring = () =>
      canvasElement.querySelector<HTMLElement>('[data-slot="tabs-closable-focus-ring"]');
    await userEvent.tab();
    await userEvent.keyboard('{ArrowRight}');
    await expect(changes).toHaveFocus();
    const chord = (key: string) => `{Control>}{Shift>}{${key}}{/Shift}{/Control}`;
    for (const [key, expected, said] of [
      ['ArrowRight', ['files', 'run-1', 'changes', 'artifacts'], '변경: 3번째 / 4개'],
      ['ArrowRight', ['files', 'run-1', 'artifacts', 'changes'], '변경: 4번째 / 4개'],
      ['ArrowLeft', ['files', 'run-1', 'changes', 'artifacts'], '변경: 3번째 / 4개'],
    ] as const) {
      await userEvent.keyboard(chord(key));
      await waitFor(() => expect(order(canvasElement)).toEqual(expected));
      await expect(changes).toHaveFocus();
      await expect(announcer).toHaveTextContent(said);
      // The ring follows the tab to its new place.
      await waitFor(() =>
        expect(Math.round((ring() as HTMLElement).getBoundingClientRect().left + 2)).toBe(
          Math.round(changes.getBoundingClientRect().left),
        ),
      );
    }
    // Nothing was selected.
    await expect(canvas.getByRole('tab', { name: '파일' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  },
};

/** A tab dragged past the threshold shows a line where it would land, and lands there; the press
 *  that ends the drag selects nothing. */
export const ReorderDrag: Story = {
  args: { width: 640, tabs: four, initial: 'files', reorder: true },
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    const tab = (name: string) => canvas.getByRole('tab', { name });
    const line = () =>
      canvasElement.querySelector<HTMLElement>('[data-slot="tabs-closable-drop-line"]');
    // Held mid-drag: the line stands in the gap between the two tabs it falls between.
    const changes = tab('변경');
    const from = changes.getBoundingClientRect();
    const run = tab('실행 #1').getBoundingClientRect();
    const result = tab('결과').getBoundingClientRect();
    const y = from.top + from.height / 2;
    await userEvent.pointer([
      { keys: '[MouseLeft>]', target: changes, coords: { clientX: from.left + 10, clientY: y } },
      { target: changes, coords: { clientX: result.left + result.width * 0.75, clientY: y } },
    ]);
    await expect(changes).toHaveAttribute('data-dragging');
    await expect(getComputedStyle(changes).opacity).toBe('0.4');
    const drawn = line() as HTMLElement;
    await expect(drawn).toHaveAttribute('data-at', '4');
    const box = drawn.getBoundingClientRect();
    await expect(Math.abs(box.left + box.width / 2 - result.right)).toBeLessThanOrEqual(1);
    await userEvent.pointer([
      { target: changes, coords: { clientX: run.left + run.width * 0.75, clientY: y } },
    ]);
    await expect(line()).toHaveAttribute('data-at', '3');
    await userEvent.pointer([
      {
        keys: '[/MouseLeft]',
        target: changes,
        coords: { clientX: run.left + run.width * 0.75, clientY: y },
      },
    ]);
    await waitFor(() =>
      expect(order(canvasElement)).toEqual(['files', 'run-1', 'changes', 'artifacts']),
    );
    await expect(line()).toBeNull();
    await expect(tab('파일')).toHaveAttribute('aria-selected', 'true');
    // A real drag (Chromium's own pointer, under the test runner only), onto the last tab's far
    // half: it lands last, selects nothing and selects no text.
    if ((import.meta as { env?: { MODE?: string } }).env?.MODE !== 'test') return;
    const browser = await import('vitest/browser' as string);
    const last = tab('결과');
    const lastBox = last.getBoundingClientRect();
    await browser.userEvent.dragAndDrop(tab('파일'), last, {
      targetPosition: { x: lastBox.width - 4, y: lastBox.height / 2 },
    });
    await waitFor(() =>
      expect(order(canvasElement)).toEqual(['run-1', 'changes', 'artifacts', 'files']),
    );
    await expect(tab('파일')).toHaveAttribute('aria-selected', 'true');
    await expect(tab('변경')).toHaveAttribute('aria-selected', 'false');
    await expect(canvasElement.ownerDocument.getSelection()?.toString() ?? '').toBe('');
    await expect(line()).toBeNull();
    // A real key puts the page back in keyboard modality for the stories after this one.
    await browser.userEvent.keyboard('{Shift}');
  },
};

/** The team editor's step drag type, which its canvas alone accepts (TeamGraphCanvas). */
const STEP_TYPE = 'application/x-corral-step';

/** The panel's strip and the dock's, sharing a move group, over a canvas that takes only steps. */
function MoveHost() {
  type Side = 'panel' | 'dock';
  const [tabs, setTabs] = useState<Record<Side, TabsClosableTab[]>>({
    panel: [
      { id: 'files', label: '파일', icon: File },
      { id: 'term-1', label: '터미널 1', icon: Terminal, movable: true },
      { id: 'changes', label: '변경', icon: GitCompare },
    ],
    dock: [
      { id: 'term-2', label: '터미널 2', icon: Terminal, movable: true },
      { id: 'debug', label: '디버그', icon: Bug },
    ],
  });
  const [canvas, setCanvas] = useState({ entered: 0, dropped: 0 });
  const strip = (side: Side) => (
    <div className="flex min-w-0 flex-1 flex-col">
      <TabsClosable
        aria-label={side === 'panel' ? '패널 탭' : '도크 탭'}
        idPrefix={side}
        tabs={tabs[side]}
        selectedId={tabs[side][0]?.id ?? null}
        onSelect={() => {}}
        onClose={() => {}}
        closeLabel={(tab) => `${tab.label} 닫기`}
        onReorder={(id, to) =>
          setTabs((current) => {
            const tab = current[side].find((item) => item.id === id) as TabsClosableTab;
            const rest = current[side].filter((item) => item.id !== id);
            return { ...current, [side]: [...rest.slice(0, to), tab, ...rest.slice(to)] };
          })
        }
        announceMove={(tab, position, count) => `${tab.label}: ${position}번째 / ${count}개`}
        moveGroup="terminals"
        onMoveOut={() => {}}
        onMoveIn={(id, index, tab) =>
          setTabs((current) => {
            const other: Side = side === 'panel' ? 'dock' : 'panel';
            const into = current[side].filter((item) => item.id !== id);
            return {
              ...current,
              [other]: current[other].filter((item) => item.id !== id),
              [side]: [...into.slice(0, index), tab, ...into.slice(index)],
            } as Record<Side, TabsClosableTab[]>;
          })
        }
      />
      {tabs[side].map((tab) => (
        <TabsClosablePanel
          key={tab.id}
          idPrefix={side}
          tabId={tab.id}
          selected={tab.id === tabs[side][0]?.id}
          className="sr-only"
        >
          {tab.label}
        </TabsClosablePanel>
      ))}
    </div>
  );
  return (
    <div className="flex w-[560px] flex-col gap-3">
      <div className="flex h-10 items-center rounded-xl border border-border px-2">
        {strip('panel')}
      </div>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: Stands in for the team editor's canvas, a drop target only. */}
      <div
        data-testid="canvas"
        className="flex h-40 items-center justify-center rounded-xl border border-border border-dashed text-ui text-muted-foreground"
        onDragEnter={(event) => {
          if (event.dataTransfer.types.includes(STEP_TYPE))
            setCanvas((value) => ({ ...value, entered: value.entered + 1 }));
        }}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes(STEP_TYPE)) event.preventDefault();
        }}
        onDrop={(event) => {
          if (!event.dataTransfer.types.includes(STEP_TYPE)) return;
          event.preventDefault();
          setCanvas((value) => ({ ...value, dropped: value.dropped + 1 }));
        }}
      >
        <output aria-label="캔버스">
          {canvas.entered}/{canvas.dropped}
        </output>
      </div>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: Stands in for the team editor's step, an HTML5 drag source only. */}
      <span
        draggable
        className="self-start rounded-md border border-border px-2 py-1 text-ui"
        onDragStart={(event) => event.dataTransfer.setData(STEP_TYPE, 'step')}
      >
        단계
      </span>
      <div className="flex h-10 items-center rounded-xl border border-border px-2">
        {strip('dock')}
      </div>
    </div>
  );
}

/** A terminal tab moves between the panel's strip and the dock's by a real drag; a tab that is not
 *  movable stays; the team editor's canvas, which takes a real step drag, never sees a tab drag. */
export const MoveAcross: Story = {
  render: () => <MoveHost />,
  play: async ({ canvasElement }) => {
    // Chromium's own pointer and HTML5 drags; runs only under the test runner.
    if ((import.meta as { env?: { MODE?: string } }).env?.MODE !== 'test') return;
    const { userEvent } = await import('vitest/browser' as string);
    const canvas = within(canvasElement);
    const panel = canvas.getByRole('tablist', { name: '패널 탭' });
    const dock = canvas.getByRole('tablist', { name: '도크 탭' });
    const ids = (list: HTMLElement) =>
      within(list)
        .getAllByRole('tab')
        .map((tab) => tab.id.replace(/^(panel|dock)-tab-/, ''));
    const counts = canvas.getByRole('status', { name: '캔버스' });
    // The canvas takes a step drag: Playwright's drag here is a real HTML5 one.
    await userEvent.dragAndDrop(canvas.getByText('단계'), canvas.getByTestId('canvas'));
    await waitFor(() => expect(counts).toHaveTextContent('1/1'));
    // Onto the dock's first tab's near half: in at 0.
    const first = within(dock).getByRole('tab', { name: '터미널 2' });
    await userEvent.dragAndDrop(within(panel).getByRole('tab', { name: '터미널 1' }), first, {
      targetPosition: { x: 4, y: first.getBoundingClientRect().height / 2 },
    });
    await waitFor(() => expect(ids(dock)).toEqual(['term-1', 'term-2', 'debug']));
    await expect(ids(panel)).toEqual(['files', 'changes']);
    // A tab that is not movable stays in its strip.
    await userEvent.dragAndDrop(within(panel).getByRole('tab', { name: '파일' }), first);
    await expect(ids(panel)).toEqual(['files', 'changes']);
    await expect(ids(dock)).toEqual(['term-1', 'term-2', 'debug']);
    // A tab dragged onto the canvas: it hears nothing, and the tab stays.
    await userEvent.dragAndDrop(
      within(dock).getByRole('tab', { name: '터미널 1' }),
      canvas.getByTestId('canvas'),
    );
    await expect(counts).toHaveTextContent('1/1');
    await expect(ids(dock)).toEqual(['term-1', 'term-2', 'debug']);
    await expect(canvasElement.querySelector('[data-slot="tabs-closable-drop-line"]')).toBeNull();
    // A real key puts the page back in keyboard modality for the stories after this one.
    await userEvent.keyboard('{Shift}');
  },
};

/** A tooltip dismissed with Escape stays shut when the host adds a tab. */
export const DismissedStaysShut: Story = {
  args: { width: 360, tabs: nine, initial: 'files', controls: true },
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    const page = within(canvasElement.ownerDocument.body);
    await document.fonts.ready;
    const changes = canvas.getByRole('tab', { name: '변경' });
    await waitFor(() => expect(nameState(changes).hidden).toBe(true));
    await userEvent.tab();
    await userEvent.keyboard('{ArrowRight}');
    await expect(changes).toHaveFocus();
    await expect(await page.findByRole('tooltip')).toHaveTextContent('변경');
    const removed: string[] = [];
    const remove = window.removeEventListener;
    window.removeEventListener = function (this: Window, ...args: Parameters<typeof remove>) {
      if (args[0] === 'keydown' && args[2] === true) removed.push('keydown');
      return remove.apply(this, args);
    } as typeof remove;
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(page.queryByRole('tooltip')).toBeNull());
    window.removeEventListener = remove;
    // The dismissal took its capture listener off at once.
    await expect(removed.length).toBeGreaterThan(0);
    canvas.getByRole('button', { name: '탭 추가' }).click();
    await waitFor(() => expect(canvas.getAllByRole('tab')).toHaveLength(10));
    await pause(800);
    await expect(changes).toHaveFocus();
    await expect(page.queryByRole('tooltip')).toBeNull();
  },
};

/** A state dot in the kit's status colours; a host passes its own mark. */
const dot = (color: string) => (
  <span className="size-2 rounded-full" style={{ backgroundColor: `var(${color})` }} />
);
const marked: TabsClosableTab[] = [
  sample[0] as TabsClosableTab,
  { id: 'run-1', label: '실행 #1', shortLabel: '#1', icon: Play, mark: dot('--warning') },
  {
    id: 'run-2',
    label: '실행 #2',
    shortLabel: '#2',
    icon: Play,
    mark: dot('--destructive'),
    description: '실패',
  },
  { id: 'run-3', label: '실행 #3', shortLabel: '#3', icon: Play },
];

/** Run tabs carry a mark in the icon's place at every stage, and are read with their state; the
 *  name stays the label, and the close control still takes that place on hover and focus. */
export const Marks: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      <Host testId="marks-wide" width={640} tabs={marked} initial="files" />
      <Host testId="marks-narrow" width={240} tabs={marked} initial="files" />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await document.fonts.ready;
    for (const id of ['marks-wide', 'marks-narrow']) {
      const strip = within(canvas.getByTestId(id));
      const run2 = strip.getByRole('tab', { name: '실행 #2' });
      await expect(run2).toHaveAccessibleDescription('실패');
      await expect(strip.getByRole('tab', { name: '실행 #3' })).not.toHaveAttribute(
        'aria-description',
      );
      const slot = run2.querySelector('[data-slot="tabs-closable-icon"]') as HTMLElement;
      await expect(slot.querySelector('[data-slot="tabs-closable-mark"]')).not.toBeNull();
      await expect(slot.querySelector('svg')).toBeNull();
      await expect(slot.getBoundingClientRect().width).toBe(14);
    }
    const narrow = within(canvas.getByTestId('marks-narrow'));
    await waitFor(() =>
      expect(nameState(narrow.getByRole('tab', { name: '실행 #2' })).hidden).toBe(true),
    );
  },
};

/** No play: tabs, width and selection come from the story's args, for looking at it. */
export const Playground: Story = { args: { tabs: four, width: 480 } };

/** The same strip on the dark theme, where axe reads its contrast. */
export const Dark: Story = {
  args: { width: 480, initial: 'run-1' },
  decorators: [(Story) => <div className="dark bg-background p-3 text-foreground">{Story()}</div>],
};
