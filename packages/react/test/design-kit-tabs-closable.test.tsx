import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { File, GitCompare, Play } from 'lucide-react';
import { createRef, useLayoutEffect, useRef, useState } from 'react';
import { expect, it, vi } from 'vitest';
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

it('keeps the trailing slot outside the tablist', () => {
  render(<Strip />);
  const more = screen.getByRole('button', { name: '더하기' });
  expect(screen.getByRole('tablist').contains(more)).toBe(false);
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
// given a 60px box in a row, and the strip a width.
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
      return this.dataset.slot === 'tabs-closable-scroller' ? stripWidth : 0;
    },
  });
  const restore = () => {
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
