import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { File, GitCompare, Play } from 'lucide-react';
import { createRef, useLayoutEffect, useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TabsClosable,
  type TabsClosableHandle,
  TabsClosablePanel,
  type TabsClosableTab,
} from '../src/design-kit/adapters/tabs-closable.tsx';

// session-panel.md: arrows move the focus only, Enter and Space select, Delete closes the focused
// tab, a middle click closes, and each close control is named after its tab. Overflow needs a
// layout engine and is covered by the stories.

const sample: TabsClosableTab[] = [
  { id: 'files', label: '파일', icon: File },
  { id: 'changes', label: '변경', icon: GitCompare },
  { id: 'run-1', label: '실행 #1', shortLabel: '#1', icon: Play },
];

function Strip({
  tabs = sample,
  initial = 'files',
  onSelect = () => {},
  onClose = () => {},
  handle,
}: {
  tabs?: TabsClosableTab[];
  initial?: string;
  onSelect?: (id: string) => void;
  onClose?: (id: string) => void;
  handle?: React.Ref<TabsClosableHandle>;
}) {
  const [selected, setSelected] = useState(initial);
  return (
    <>
      <TabsClosable
        ref={handle}
        aria-label="패널"
        idPrefix="panel"
        tabs={tabs}
        selectedId={selected}
        onSelect={(id) => {
          setSelected(id);
          onSelect(id);
        }}
        onClose={onClose}
        closeLabel={(tab) => `${tab.label} 닫기`}
        trailing={<button type="button">더하기</button>}
        end={<button type="button">넓히기</button>}
      />
      {tabs.map((tab) => (
        <TabsClosablePanel
          key={tab.id}
          idPrefix="panel"
          tabId={tab.id}
          selected={tab.id === selected}
        >
          {tab.label} 내용
        </TabsClosablePanel>
      ))}
    </>
  );
}

it('moves the focus with the arrows without selecting, and selects with Enter and Space', async () => {
  const onSelect = vi.fn();
  render(<Strip onSelect={onSelect} />);
  const user = userEvent.setup();
  const files = screen.getByRole('tab', { name: '파일' });
  files.focus();
  await user.keyboard('{ArrowRight}');
  const changes = screen.getByRole('tab', { name: '변경' });
  expect(changes).toHaveFocus();
  expect(onSelect).not.toHaveBeenCalled();
  expect(files).toHaveAttribute('aria-selected', 'true');
  await user.keyboard('{Enter}');
  expect(onSelect).toHaveBeenLastCalledWith('changes');
  expect(changes).toHaveAttribute('aria-selected', 'true');
  await user.keyboard('{ArrowRight}');
  expect(screen.getByRole('tab', { name: '실행 #1' })).toHaveFocus();
  await user.keyboard(' ');
  expect(onSelect).toHaveBeenLastCalledWith('run-1');
  expect(onSelect).toHaveBeenCalledTimes(2);
});

it('closes the focused tab with Delete and never another one', async () => {
  const onClose = vi.fn();
  const onSelect = vi.fn();
  render(<Strip onClose={onClose} onSelect={onSelect} />);
  const user = userEvent.setup();
  screen.getByRole('tab', { name: '파일' }).focus();
  await user.keyboard('{ArrowRight}{ArrowRight}');
  await user.keyboard('{Delete}');
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onClose).toHaveBeenCalledWith('run-1');
  expect(onSelect).not.toHaveBeenCalled();
  // Other keys close nothing.
  await user.keyboard('{Backspace}x');
  expect(onClose).toHaveBeenCalledTimes(1);
});

it('names each close control after its tab and keeps it out of the tab and the tab order', async () => {
  const onClose = vi.fn();
  const onSelect = vi.fn();
  render(<Strip onClose={onClose} onSelect={onSelect} />);
  const tablist = screen.getByRole('tablist', { name: '패널' });
  for (const tab of sample) {
    const close = screen.getByRole('button', { name: `${tab.label} 닫기` });
    expect(close).toHaveAttribute('tabindex', '-1');
    // It says which tab it closes, also when two tabs share a name.
    expect(close).toHaveAttribute('data-tab-id', tab.id);
    expect(tablist.contains(close)).toBe(false);
  }
  // A tab contains no other control, and its name is only its label.
  for (const tab of within(tablist).getAllByRole('tab')) {
    expect(tab.querySelector('button, [role="button"], [tabindex]')).toBeNull();
  }
  within(tablist)
    .getAllByRole('tab')
    .forEach((tab, index) => {
      expect(tab).toHaveAccessibleName(sample[index]?.label);
    });
  await userEvent.setup().click(screen.getByRole('button', { name: '변경 닫기' }));
  expect(onClose).toHaveBeenCalledWith('changes');
  expect(onSelect).not.toHaveBeenCalled();
});

it('closes a tab on a middle click without selecting it', () => {
  const onClose = vi.fn();
  const onSelect = vi.fn();
  render(<Strip onClose={onClose} onSelect={onSelect} />);
  const changes = screen.getByRole('tab', { name: '변경' });
  fireEvent.mouseDown(changes, { button: 1 });
  fireEvent.mouseUp(changes, { button: 1 });
  fireEvent(changes, new MouseEvent('auxclick', { bubbles: true, button: 1 }));
  expect(onClose).toHaveBeenCalledWith('changes');
  expect(onSelect).not.toHaveBeenCalled();
  // A secondary (right) click closes nothing.
  fireEvent(changes, new MouseEvent('auxclick', { bubbles: true, button: 2 }));
  expect(onClose).toHaveBeenCalledTimes(1);
});

it('keeps a middle press from starting the browser autoscroll', () => {
  render(<Strip />);
  const changes = screen.getByRole('tab', { name: '변경' });
  // fireEvent returns false when the default was prevented.
  expect(fireEvent.mouseDown(changes, { button: 1 })).toBe(false);
  expect(
    fireEvent.mouseDown(screen.getByRole('button', { name: '변경 닫기' }), { button: 1 }),
  ).toBe(false);
});

it('closes a tab on a middle click on its close control', () => {
  const onClose = vi.fn();
  render(<Strip onClose={onClose} />);
  const close = screen.getByRole('button', { name: '변경 닫기' });
  fireEvent(close, new MouseEvent('auxclick', { bubbles: true, button: 1 }));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onClose).toHaveBeenCalledWith('changes');
});

it('closes one tab for a held Delete, and none for a Delete chord', () => {
  const onClose = vi.fn();
  render(<Strip onClose={onClose} />);
  const files = screen.getByRole('tab', { name: '파일' });
  files.focus();
  fireEvent.keyDown(files, { key: 'Delete', repeat: true });
  for (const modifier of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey']) {
    fireEvent.keyDown(files, { key: 'Delete', [modifier]: true });
  }
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.keyDown(files, { key: 'Delete' });
  expect(onClose).toHaveBeenCalledTimes(1);
});

it('dispatches no focus event when the host renders again with equal tabs', async () => {
  const view = render(<Strip tabs={sample.map((tab) => ({ ...tab }))} />);
  screen.getByRole('tab', { name: '변경' }).focus();
  await Promise.resolve();
  const focusins = vi.fn();
  document.addEventListener('focusin', focusins, true);
  for (let round = 0; round < 5; round++) {
    view.rerender(<Strip tabs={sample.map((tab) => ({ ...tab }))} />);
  }
  await Promise.resolve();
  await Promise.resolve();
  document.removeEventListener('focusin', focusins, true);
  expect(focusins).not.toHaveBeenCalled();
  expect(screen.getByRole('tab', { name: '변경' })).toHaveFocus();
});

it('links each tab to its panel, which is named by the tab', () => {
  render(<Strip />);
  const files = screen.getByRole('tab', { name: '파일' });
  expect(files).toHaveAttribute('id', 'panel-tab-files');
  expect(files).toHaveAttribute('aria-controls', 'panel-panel-files');
  const panel = screen.getByRole('tabpanel', { name: '파일' });
  expect(panel).toHaveAttribute('id', 'panel-panel-files');
  expect(panel).toHaveTextContent('파일 내용');
});

it("renders a panel's content once its tab is first selected, and keeps it after", async () => {
  render(<Strip />);
  const user = userEvent.setup();
  // Never selected: nothing rendered yet.
  expect(screen.queryByText('변경 내용')).toBeNull();
  await user.click(screen.getByRole('tab', { name: '변경' }));
  expect(screen.getByText('변경 내용')).toBeVisible();
  await user.click(screen.getByRole('tab', { name: '파일' }));
  // Selected once: kept, hidden.
  expect(screen.getByText('변경 내용')).not.toBeVisible();
});

it('lets the host move the focus to a tab by id', () => {
  const handle = createRef<TabsClosableHandle>();
  render(<Strip handle={handle} />);
  expect(handle.current?.focusTab('changes')).toBe(true);
  expect(screen.getByRole('tab', { name: '변경' })).toHaveFocus();
  expect(handle.current?.focusTab('missing')).toBe(false);
});

it('does not pick a selection when the host removes a tab', () => {
  const onSelect = vi.fn();
  const view = render(<Strip onSelect={onSelect} initial="changes" />);
  view.rerender(
    <Strip
      onSelect={onSelect}
      initial="changes"
      tabs={sample.filter((tab) => tab.id !== 'changes')}
    />,
  );
  expect(onSelect).not.toHaveBeenCalled();
  expect(screen.queryByRole('tab', { selected: true })).toBeNull();
});

it('puts the trailing slot after the tabs and the end slot last, both outside the tablist', () => {
  render(<Strip />);
  const tablist = screen.getByRole('tablist');
  const more = screen.getByRole('button', { name: '더하기' });
  const widen = screen.getByRole('button', { name: '넓히기' });
  expect(tablist.contains(more)).toBe(false);
  expect(tablist.contains(widen)).toBe(false);
  expect(more.closest('[data-slot="tabs-closable-trailing"]')).not.toBeNull();
  expect(widen.closest('[data-slot="tabs-closable-end"]')).not.toBeNull();
  const follows = (a: Node, b: Node) =>
    (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  expect(follows(tablist, more)).toBe(true);
  expect(follows(more, widen)).toBe(true);
  // Both are the strip's own children, after the scroller: neither scrolls with the tabs.
  const scroller = document.querySelector('[data-slot="tabs-closable-scroller"]') as HTMLElement;
  expect(scroller.contains(more)).toBe(false);
  expect(scroller.contains(widen)).toBe(false);
});

function ClosingHost() {
  const [tabs, setTabs] = useState(sample);
  const [selected, setSelected] = useState('files');
  const [focusNext, setFocusNext] = useState<string | null>(null);
  const strip = useRef<TabsClosableHandle>(null);
  // The host moves the focus as soon as the strip has the new tabs, in the same commit.
  useLayoutEffect(() => {
    if (!focusNext) return;
    strip.current?.focusTab(focusNext);
    setFocusNext(null);
  }, [focusNext]);
  return (
    <TabsClosable
      ref={strip}
      aria-label="패널"
      idPrefix="closing"
      tabs={tabs}
      selectedId={selected}
      onSelect={setSelected}
      closeLabel={(tab) => `${tab.label} 닫기`}
      onClose={(id) => {
        const index = tabs.findIndex((tab) => tab.id === id);
        const rest = tabs.filter((tab) => tab.id !== id);
        const neighbour = (rest[index] ?? rest[index - 1])?.id ?? '';
        setTabs(rest);
        if (id === selected) setSelected(neighbour);
        setFocusNext(neighbour);
      }}
    />
  );
}

it('starts the arrows from the tab the host focused after a close', async () => {
  render(<ClosingHost />);
  const user = userEvent.setup();
  screen.getByRole('tab', { name: '파일' }).focus();
  await user.keyboard('{ArrowRight}{Enter}{Delete}');
  await waitFor(() => expect(screen.getByRole('tab', { name: '실행 #1' })).toHaveFocus());
  await user.keyboard('{ArrowLeft}');
  expect(screen.getByRole('tab', { name: '파일' })).toHaveFocus();
});

it('renders an empty strip, as after the last close', () => {
  render(<Strip tabs={[]} />);
  expect(screen.getByRole('tablist', { name: '패널' })).toBeEmptyDOMElement();
  expect(screen.queryByRole('button', { name: /닫기/ })).toBeNull();
  expect(screen.getByRole('button', { name: '더하기' })).toBeInTheDocument();
});

// Where the close controls stand needs the tabs' boxes, which jsdom does not lay out: each tab is
// given a 60px box in a row, and the strip a width. Focus there is keyboard focus.
function withBoxes(stripWidth: number, run: () => void | Promise<void>) {
  const proto = HTMLElement.prototype;
  const saved = (['offsetWidth', 'offsetHeight', 'offsetLeft', 'clientWidth'] as const).map(
    (key) => [key, Object.getOwnPropertyDescriptor(proto, key)] as const,
  );
  const isTab = (element: HTMLElement) => element.getAttribute('role') === 'tab';
  Object.defineProperty(proto, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return isTab(this) ? 60 : 0;
    },
  });
  Object.defineProperty(proto, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return isTab(this) ? 28 : 0;
    },
  });
  Object.defineProperty(proto, 'offsetLeft', {
    configurable: true,
    get(this: HTMLElement) {
      return isTab(this) ? Number(this.dataset.fluidHoverIndex) * 60 : 0;
    },
  });
  Object.defineProperty(proto, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.dataset.slot === 'tabs-closable' ? stripWidth : 0;
    },
  });
  // jsdom's :focus-visible follows its own heuristics; here a focused tab is keyboard-focused.
  const matches = Element.prototype.matches;
  Element.prototype.matches = function (this: Element, selector: string) {
    if (selector === ':focus-visible') return this === document.activeElement;
    return matches.call(this, selector);
  } as typeof matches;
  const restore = () => {
    Element.prototype.matches = matches;
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(proto, key, descriptor);
      else delete (proto as unknown as Record<string, unknown>)[key];
    }
  };
  return Promise.resolve().then(run).finally(restore);
}

const close = (name: string) => screen.getByRole('button', { name: `${name} 닫기` });

it('stands the close control after the selected tab name, always shown', () =>
  withBoxes(1000, async () => {
    render(<Strip initial="changes" />);
    await waitFor(() => expect(close('변경')).toHaveAttribute('data-shown'));
    // The selected tab is the second 60px box; its close glyph ends as far from the end as the icon starts (10px), so the 24px box ends 4px before it.
    expect(close('변경')).toHaveAttribute('data-place', 'end');
    expect(close('변경').style.left).toBe(`${60 + 60 - 4 - 24}px`);
    expect(close('변경').style.width).toBe('24px');
    expect(close('파일')).not.toHaveAttribute('data-shown');
    expect(close('실행 #1')).not.toHaveAttribute('data-shown');
  }));

it('puts the close control in the icon place of a named tab on focus', () =>
  withBoxes(1000, async () => {
    render(<Strip initial="changes" />);
    await waitFor(() => expect(close('변경')).toHaveAttribute('data-shown'));
    const files = screen.getByRole('tab', { name: '파일' });
    files.focus();
    await waitFor(() => expect(close('파일')).toHaveAttribute('data-shown'));
    expect(close('파일')).toHaveAttribute('data-place', 'icon');
    // Centred on the 14px icon after 10px of padding.
    expect(close('파일').style.left).toBe(`${10 + 7 - 12}px`);
    // The icon gives way, and nothing else moves.
    expect(files.querySelector('svg')).toHaveClass('opacity-0');
    expect(files.style.paddingLeft).toBe('10px');
    // The selected tab keeps its own.
    expect(close('변경')).toHaveAttribute('data-shown');
  }));

it('shows no close control on a tab shrunk to its icon, but does on one with a short label', () =>
  withBoxes(100, async () => {
    render(<Strip initial="files" />);
    // 100px leaves no room for the names: the unselected tabs keep their icon (and short label).
    await waitFor(() =>
      expect(
        screen.getByRole('tab', { name: '변경' }).querySelector('[data-slot="tabs-closable-name"]'),
      ).toHaveClass('sr-only'),
    );
    const changes = screen.getByRole('tab', { name: '변경' });
    changes.focus();
    await waitFor(() => expect(changes).toHaveAttribute('data-fluid-hover-active'));
    expect(close('변경')).not.toHaveAttribute('data-shown');
    expect(changes.querySelector('svg')).not.toHaveClass('opacity-0');
    const run = screen.getByRole('tab', { name: '실행 #1' });
    run.focus();
    await waitFor(() => expect(close('실행 #1')).toHaveAttribute('data-shown'));
    expect(close('파일')).toHaveAttribute('data-shown');
  }));

it('follows the focused tab to its new place when a tab before it goes', () =>
  withBoxes(1000, async () => {
    const view = render(<Strip initial="changes" />);
    await waitFor(() => expect(close('변경')).toHaveAttribute('data-shown'));
    screen.getByRole('tab', { name: '실행 #1' }).focus();
    await waitFor(() => expect(close('실행 #1')).toHaveAttribute('data-shown'));
    view.rerender(<Strip initial="changes" tabs={sample.filter((tab) => tab.id !== 'files')} />);
    // Now second, not third: its close control still shows in its icon's place.
    await waitFor(() => expect(close('실행 #1').style.left).toBe(`${60 + 10 + 7 - 12}px`));
    expect(close('실행 #1')).toHaveAttribute('data-shown');
  }));

it('shows no close control in the icon place for a focus that is not keyboard focus', () =>
  withBoxes(1000, async () => {
    render(<Strip initial="changes" />);
    await waitFor(() => expect(close('변경')).toHaveAttribute('data-shown'));
    const files = screen.getByRole('tab', { name: '파일' });
    const matches = Element.prototype.matches;
    Element.prototype.matches = function (this: Element, selector: string) {
      return selector === ':focus-visible' ? false : matches.call(this, selector);
    } as typeof matches;
    try {
      files.focus();
      await waitFor(() => expect(files).toHaveFocus());
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(close('파일')).not.toHaveAttribute('data-shown');
      expect(files.querySelector('svg')).not.toHaveClass('opacity-0');
    } finally {
      Element.prototype.matches = matches;
    }
  }));

it('lets a focused close control show itself and its ring', () => {
  render(<Strip />);
  const control = screen.getByRole('button', { name: '변경 닫기' });
  expect(control).not.toHaveClass('outline-none');
  expect(control).toHaveClass('focus-visible:opacity-100');
  expect(control.className).toContain('focus-visible:outline-[color:var(--focus-ring)]');
});

// session-panel.md "탭": a run tab carries its state mark in the icon's place, at every stage, and
// says the state as its description; its name stays "실행 #n".

/** A mark as a host draws one: it would name itself if the strip let it. */
const mark = (state: string) => (
  <span role="img" aria-label={state} data-testid={`mark-${state}`}>
    ●
  </span>
);
const marked: TabsClosableTab[] = [
  { id: 'files', label: '파일', icon: File },
  { id: 'changes', label: '변경', icon: GitCompare, mark: mark('대기') },
  {
    id: 'run-1',
    label: '실행 #1',
    shortLabel: '#1',
    icon: Play,
    mark: mark('실패'),
    description: '실패',
  },
];
const slotOf = (tab: HTMLElement) =>
  tab.querySelector<HTMLElement>('[data-slot="tabs-closable-icon"]');

it('draws a mark in the icon slot instead of the icon, hidden from assistive technology, and the name stays the label', () => {
  render(<Strip tabs={marked} />);
  const run = screen.getByRole('tab', { name: '실행 #1' });
  const drawn = within(run).getByTestId('mark-실패');
  expect(slotOf(run)?.contains(drawn)).toBe(true);
  expect(run.querySelector('.lucide-play')).toBeNull();
  // The icon's box: the tab does not change width with its state.
  expect(slotOf(run)?.style.width).toBe('14px');
  expect(slotOf(run)?.style.height).toBe('14px');
  expect(drawn.closest('[aria-hidden="true"]')).not.toBeNull();
  expect(run).toHaveAccessibleName('실행 #1');
  expect(screen.getByRole('tab', { name: '변경' })).toHaveAccessibleName('변경');
  // A tab without a mark keeps its icon.
  expect(screen.getByRole('tab', { name: '파일' }).querySelector('.lucide-file')).not.toBeNull();
});

it('describes a tab by its description only when it has one', () => {
  render(<Strip tabs={marked} />);
  const run = screen.getByRole('tab', { name: '실행 #1' });
  expect(run).toHaveAccessibleDescription('실패');
  for (const name of ['파일', '변경']) {
    const tab = screen.getByRole('tab', { name });
    expect(tab).not.toHaveAttribute('aria-description');
    expect(tab).not.toHaveAttribute('aria-describedby');
  }
});

it('falls back to the icon in the same slot, at the same width, when the mark goes', () => {
  const view = render(<Strip tabs={marked} />);
  const run = screen.getByRole('tab', { name: '실행 #1' });
  const slot = slotOf(run);
  expect(within(run).getByTestId('mark-실패')).toBeInTheDocument();
  view.rerender(
    <Strip
      tabs={marked.map((tab) =>
        tab.id === 'run-1' ? { ...tab, mark: undefined, description: undefined } : tab,
      )}
    />,
  );
  expect(within(run).queryByTestId('mark-실패')).toBeNull();
  expect(slotOf(run)).toBe(slot);
  expect(slot?.querySelector('.lucide-play')).not.toBeNull();
  expect(slot?.style.width).toBe('14px');
  expect(run).not.toHaveAttribute('aria-description');
});

it('keeps the mark, with the run number, on a tab shrunk to its icon', () =>
  withBoxes(100, async () => {
    render(<Strip tabs={marked} initial="files" />);
    const run = screen.getByRole('tab', { name: '실행 #1' });
    await waitFor(() =>
      expect(run.querySelector('[data-slot="tabs-closable-name"]')).toHaveClass('sr-only'),
    );
    expect(slotOf(run)?.contains(within(run).getByTestId('mark-실패'))).toBe(true);
    expect(run.querySelector('.lucide-play')).toBeNull();
    expect(run).toHaveTextContent('#1');
    expect(run).toHaveAccessibleName('실행 #1');
    // One without a short label keeps its mark too.
    const changes = screen.getByRole('tab', { name: '변경' });
    expect(slotOf(changes)?.contains(within(changes).getByTestId('mark-대기'))).toBe(true);
  }));

it('gives the mark’s place to the close control on focus, and gives it back after', () =>
  withBoxes(1000, async () => {
    render(<Strip tabs={marked} initial="changes" />);
    await waitFor(() => expect(close('변경')).toHaveAttribute('data-shown'));
    const run = screen.getByRole('tab', { name: '실행 #1' });
    const drawn = () =>
      within(run).getByTestId('mark-실패').closest<HTMLElement>('[data-slot="tabs-closable-mark"]');
    expect(drawn()).not.toBeNull();
    expect(drawn()).not.toHaveClass('opacity-0');
    run.focus();
    await waitFor(() => expect(close('실행 #1')).toHaveAttribute('data-shown'));
    expect(close('실행 #1')).toHaveAttribute('data-place', 'icon');
    expect(drawn()).toHaveClass('opacity-0');
    screen.getByRole('tab', { name: '파일' }).focus();
    await waitFor(() => expect(close('실행 #1')).not.toHaveAttribute('data-shown'));
    expect(drawn()).not.toHaveClass('opacity-0');
  }));

// --- Reordering (session-panel.md S4): a drag within the strip, and Mod+Shift+arrows on a focused
// tab. The host owns the order; the strip says where a tab is to go.

function moved(tabs: readonly TabsClosableTab[], id: string, to: number) {
  const tab = tabs.find((item) => item.id === id);
  if (!tab) return [...tabs];
  const rest = tabs.filter((item) => item.id !== id);
  return [...rest.slice(0, to), tab, ...rest.slice(to)];
}

const placeWords = (tab: TabsClosableTab, position: number, count: number) =>
  `${tab.label}: ${position}번째 / ${count}개`;

function Reorderable({
  initial = sample,
  onReorder = () => {},
  onSelect = () => {},
  onDragChange,
  refuse = false,
}: {
  initial?: TabsClosableTab[];
  onReorder?: (id: string, to: number) => void;
  onSelect?: (id: string) => void;
  onDragChange?: (dragging: boolean) => void;
  refuse?: boolean;
}) {
  const [tabs, setTabs] = useState(initial);
  const [selected, setSelected] = useState(initial[0]?.id ?? null);
  return (
    <TabsClosable
      aria-label="패널"
      idPrefix="panel"
      tabs={tabs}
      selectedId={selected}
      onSelect={(id) => {
        setSelected(id);
        onSelect(id);
      }}
      onClose={() => {}}
      closeLabel={(tab) => `${tab.label} 닫기`}
      onReorder={(id, to) => {
        onReorder(id, to);
        if (!refuse) setTabs((current) => moved(current, id, to));
      }}
      announceMove={placeWords}
      onTabDragChange={onDragChange}
    />
  );
}

/** The tabs' order, by id. */
const names = () => screen.getAllByRole('tab').map((tab) => tab.id.replace('panel-tab-', ''));
const announcer = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-slot="tabs-closable-announcer"]');
const dropLine = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-slot="tabs-closable-drop-line"]');

describe('reordering by keyboard', () => {
  it('moves the focused tab one place with Ctrl+Shift+arrows, stopping at the ends, and keeps the focus on it', async () => {
    const onReorder = vi.fn();
    const onSelect = vi.fn();
    const view = render(<Reorderable onReorder={onReorder} onSelect={onSelect} />);
    const user = userEvent.setup();
    const changes = screen.getByRole('tab', { name: '변경' });
    changes.focus();
    await user.keyboard('{Control>}{Shift>}{ArrowRight}{/Shift}{/Control}');
    expect(onReorder).toHaveBeenLastCalledWith('changes', 2);
    expect(names()).toEqual(['files', 'run-1', 'changes']);
    expect(screen.getByRole('tab', { name: '변경' })).toHaveFocus();
    expect(announcer(view.container)).toHaveTextContent('변경: 3번째 / 3개');
    // At the end: nothing moves, and the focus stays.
    await user.keyboard('{Control>}{Shift>}{ArrowRight}{/Shift}{/Control}');
    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('tab', { name: '변경' })).toHaveFocus();
    await user.keyboard('{Control>}{Shift>}{ArrowLeft}{ArrowLeft}{/Shift}{/Control}');
    expect(onReorder.mock.calls).toEqual([
      ['changes', 2],
      ['changes', 1],
      ['changes', 0],
    ]);
    expect(names()).toEqual(['changes', 'files', 'run-1']);
    expect(screen.getByRole('tab', { name: '변경' })).toHaveFocus();
    expect(announcer(view.container)).toHaveTextContent('변경: 1번째 / 3개');
    await user.keyboard('{Control>}{Shift>}{ArrowLeft}{/Shift}{/Control}');
    expect(onReorder).toHaveBeenCalledTimes(3);
    // Nothing was selected, and the arrows go on from the tab's new place.
    expect(onSelect).not.toHaveBeenCalled();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: '파일' })).toHaveFocus();
  });

  it('leaves other chords alone, and the chord to a strip the host does not let reorder', async () => {
    const onReorder = vi.fn();
    const view = render(<Reorderable onReorder={onReorder} />);
    const user = userEvent.setup();
    const changes = screen.getByRole('tab', { name: '변경' });
    expect(changes).toHaveAttribute(
      'aria-keyshortcuts',
      'Delete Control+Shift+ArrowLeft Control+Shift+ArrowRight',
    );
    changes.focus();
    // Alt+Shift switches the input language on Windows; ⌘ is the Mac's, not this platform's.
    await user.keyboard('{Alt>}{Shift>}{ArrowRight}{/Shift}{/Alt}');
    await user.keyboard('{Meta>}{Shift>}{ArrowRight}{/Shift}{/Meta}');
    await user.keyboard('{Control>}{ArrowRight}{/Control}');
    expect(onReorder).not.toHaveBeenCalled();
    expect(names()).toEqual(['files', 'changes', 'run-1']);
    view.unmount();
    // Without onReorder the chord is not the strip's, and there is nothing to say.
    const plain = render(<Strip />);
    expect(screen.getByRole('tab', { name: '변경' })).toHaveAttribute(
      'aria-keyshortcuts',
      'Delete',
    );
    expect(announcer(plain.container)).toBeNull();
  });

  it('says nothing when the host refuses the move', async () => {
    const onReorder = vi.fn();
    const view = render(<Reorderable onReorder={onReorder} refuse />);
    const user = userEvent.setup();
    screen.getByRole('tab', { name: '변경' }).focus();
    await user.keyboard('{Control>}{Shift>}{ArrowRight}{/Shift}{/Control}');
    expect(onReorder).toHaveBeenCalledWith('changes', 2);
    expect(names()).toEqual(['files', 'changes', 'run-1']);
    expect(announcer(view.container)).toHaveTextContent('');
    expect(screen.getByRole('tab', { name: '변경' })).toHaveFocus();
  });

  it('keeps a polite region outside the tablist from the start', () => {
    const view = render(<Reorderable />);
    const region = announcer(view.container);
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveTextContent('');
    expect(screen.getByRole('tablist').contains(region)).toBe(false);
  });
});

/** Tabs 100px wide side by side in a 600px strip 40px high. */
function stubStripBoxes() {
  const original = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const element = this as HTMLElement;
    const box = (left: number, top: number, width: number, height: number) =>
      ({
        left,
        top,
        width,
        height,
        right: left + width,
        bottom: top + height,
        x: left,
        y: top,
      }) as DOMRect;
    if (element.getAttribute('role') === 'tab') {
      return box(Number(element.dataset.fluidHoverIndex) * 100, 6, 100, 28);
    }
    if (element.dataset.slot === 'tabs-closable') return box(0, 0, 600, 40);
    return original.call(this);
  };
  return () => {
    Element.prototype.getBoundingClientRect = original;
  };
}

const pointer = { pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1 };
const at = (x: number, y = 20) => ({ ...pointer, clientX: x, clientY: y });

describe('reordering by drag', () => {
  let restore = () => {};
  beforeEach(() => {
    restore = stubStripBoxes();
  });
  afterEach(() => restore());

  it('reorders by a drag past a small threshold to the place the line shows', () => {
    const onReorder = vi.fn();
    const onSelect = vi.fn();
    const onDragChange = vi.fn();
    const view = render(
      <Reorderable onReorder={onReorder} onSelect={onSelect} onDragChange={onDragChange} />,
    );
    const changes = screen.getByRole('tab', { name: '변경' });
    fireEvent.pointerDown(changes, at(150));
    fireEvent.pointerMove(changes, at(152));
    expect(onDragChange).not.toHaveBeenCalled();
    expect(changes).not.toHaveAttribute('data-dragging');
    // Past the threshold: a drag, the tab dimmed, the line after the last tab.
    fireEvent.pointerMove(changes, at(290));
    expect(onDragChange).toHaveBeenLastCalledWith(true);
    expect(changes).toHaveAttribute('data-dragging');
    expect(dropLine(view.container)).toHaveAttribute('data-at', '3');
    fireEvent.pointerUp(changes, at(290));
    expect(onReorder).toHaveBeenCalledExactlyOnceWith('changes', 2);
    expect(onDragChange).toHaveBeenLastCalledWith(false);
    expect(dropLine(view.container)).toBeNull();
    expect(names()).toEqual(['files', 'run-1', 'changes']);
    expect(screen.getByRole('tab', { name: '변경' })).not.toHaveAttribute('data-dragging');
    // The pointer's click that ends a drag selects nothing; the next press does.
    fireEvent.click(screen.getByRole('tab', { name: '변경' }), { detail: 1 });
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.pointerDown(screen.getByRole('tab', { name: '변경' }), at(250));
    fireEvent.pointerUp(screen.getByRole('tab', { name: '변경' }), at(250));
    fireEvent.click(screen.getByRole('tab', { name: '변경' }), { detail: 1 });
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('changes');
  });

  it('lets a keyboard choice through after a drag whose release brought no click', async () => {
    const onSelect = vi.fn();
    render(<Reorderable onSelect={onSelect} />);
    const user = userEvent.setup();
    const changes = screen.getByRole('tab', { name: '변경' });
    fireEvent.pointerDown(changes, at(150));
    fireEvent.pointerMove(changes, at(290));
    fireEvent.keyDown(changes, { key: 'Escape' });
    // Let go off the tab: no click reaches it.
    fireEvent.pointerUp(changes, at(290));
    screen.getByRole('tab', { name: '실행 #1' }).focus();
    await user.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('run-1');
  });

  it('treats a press that moves less than the threshold as a press', () => {
    const onReorder = vi.fn();
    const onSelect = vi.fn();
    const onDragChange = vi.fn();
    const view = render(
      <Reorderable onReorder={onReorder} onSelect={onSelect} onDragChange={onDragChange} />,
    );
    const changes = screen.getByRole('tab', { name: '변경' });
    fireEvent.pointerDown(changes, at(150));
    fireEvent.pointerMove(changes, at(153, 22));
    fireEvent.pointerUp(changes, at(153, 22));
    fireEvent.click(changes);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('changes');
    expect(onReorder).not.toHaveBeenCalled();
    expect(onDragChange).not.toHaveBeenCalled();
    expect(dropLine(view.container)).toBeNull();
  });

  it('shows no line and moves nothing over the tab’s own place', () => {
    const onReorder = vi.fn();
    const view = render(<Reorderable onReorder={onReorder} />);
    const changes = screen.getByRole('tab', { name: '변경' });
    fireEvent.pointerDown(changes, at(150));
    fireEvent.pointerMove(changes, at(110));
    expect(dropLine(view.container)).toBeNull();
    fireEvent.pointerMove(changes, at(190));
    expect(dropLine(view.container)).toBeNull();
    fireEvent.pointerMove(changes, at(40));
    expect(dropLine(view.container)).toHaveAttribute('data-at', '0');
    fireEvent.pointerMove(changes, at(160));
    expect(dropLine(view.container)).toBeNull();
    fireEvent.pointerUp(changes, at(160));
    expect(onReorder).not.toHaveBeenCalled();
  });

  it('ends a drag without a move on Escape, which goes no further, on a cancelled pointer, and on a lost capture', () => {
    for (const end of ['escape', 'cancel', 'lost'] as const) {
      const onReorder = vi.fn();
      const onDragChange = vi.fn();
      const outer = vi.fn();
      const view = render(
        // biome-ignore lint/a11y/noStaticElementInteractions: Stands in for a host listening for Escape (a drawer).
        <div onKeyDown={outer}>
          <Reorderable onReorder={onReorder} onDragChange={onDragChange} />
        </div>,
      );
      const changes = screen.getByRole('tab', { name: '변경' });
      changes.focus();
      fireEvent.pointerDown(changes, at(150));
      fireEvent.pointerMove(changes, at(290));
      expect(dropLine(view.container), end).not.toBeNull();
      if (end === 'escape') {
        const allowed = fireEvent.keyDown(changes, { key: 'Escape' });
        expect(allowed, end).toBe(false);
        expect(outer, end).not.toHaveBeenCalled();
      } else if (end === 'cancel') fireEvent.pointerCancel(changes, at(290));
      else fireEvent.lostPointerCapture(changes, { pointerId: 1 });
      expect(dropLine(view.container), end).toBeNull();
      expect(onDragChange, end).toHaveBeenLastCalledWith(false);
      expect(changes, end).not.toHaveAttribute('data-dragging');
      fireEvent.pointerUp(changes, at(290));
      expect(onReorder, end).not.toHaveBeenCalled();
      expect(names(), end).toEqual(['files', 'changes', 'run-1']);
      view.unmount();
    }
  });

  it('never starts a native drag, and a touch does not drag', () => {
    const onDragChange = vi.fn();
    const view = render(<Reorderable onDragChange={onDragChange} />);
    const changes = screen.getByRole('tab', { name: '변경' });
    expect(changes).not.toHaveAttribute('draggable', 'true');
    expect(fireEvent.dragStart(changes)).toBe(false);
    fireEvent.pointerDown(changes, { ...at(150), pointerType: 'touch' });
    fireEvent.pointerMove(changes, { ...at(290), pointerType: 'touch' });
    expect(onDragChange).not.toHaveBeenCalled();
    expect(dropLine(view.container)).toBeNull();
  });

  it('ends a drag whose tab the host takes away, and a drag cut short by unmounting', () => {
    const onDragChange = vi.fn();
    const strip = (tabs: TabsClosableTab[]) => (
      <TabsClosable
        aria-label="패널"
        idPrefix="panel"
        tabs={tabs}
        selectedId="files"
        onSelect={() => {}}
        onClose={() => {}}
        closeLabel={(tab) => `${tab.label} 닫기`}
        onReorder={() => {}}
        announceMove={placeWords}
        onTabDragChange={onDragChange}
      />
    );
    const view = render(strip(sample));
    const changes = screen.getByRole('tab', { name: '변경' });
    fireEvent.pointerDown(changes, at(150));
    fireEvent.pointerMove(changes, at(290));
    expect(onDragChange).toHaveBeenLastCalledWith(true);
    view.rerender(strip(sample.filter((tab) => tab.id !== 'changes')));
    expect(onDragChange).toHaveBeenLastCalledWith(false);
    expect(dropLine(view.container)).toBeNull();
    const run = screen.getByRole('tab', { name: '실행 #1' });
    fireEvent.pointerDown(run, at(150));
    fireEvent.pointerMove(run, at(20));
    expect(onDragChange).toHaveBeenLastCalledWith(true);
    view.unmount();
    expect(onDragChange).toHaveBeenLastCalledWith(false);
    expect(onDragChange).toHaveBeenCalledTimes(4);
  });
});
