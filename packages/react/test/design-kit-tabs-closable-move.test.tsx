import { fireEvent, render, screen } from '@testing-library/react';
import { Bug, File, GitCompare, Terminal } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SidePanelFrame } from '../src/design-kit/adapters/side-panel-frame.tsx';
import { TabsClosable, type TabsClosableTab } from '../src/design-kit/adapters/tabs-closable.tsx';
import { STEP_DRAG_TYPE } from '../src/team-editor/TeamGraphCanvas.tsx';

// session-panel.md S4: a terminal tab moves between the panel's strip and the dock's by drag. Two
// strips share a group; only a tab the host marks movable crosses; the source hears onMoveOut and
// the target onMoveIn, and nothing closes. The drag never becomes an HTML5 drag, so the team
// editor's step drop targets never see it.

const panelTabs: TabsClosableTab[] = [
  { id: 'files', label: '파일', icon: File },
  { id: 'term-1', label: '터미널 1', icon: Terminal, movable: true },
  { id: 'changes', label: '변경', icon: GitCompare },
];
const dockTabs: TabsClosableTab[] = [
  { id: 'term-2', label: '터미널 2', icon: Terminal, movable: true },
  { id: 'debug', label: '디버그', icon: Bug },
];

type Side = 'A' | 'B';
const spiesFor = () => ({
  onSelect: vi.fn(),
  onClose: vi.fn(),
  onReorder: vi.fn(),
  onMoveOut: vi.fn(),
  onMoveIn: vi.fn(),
  onTabDragChange: vi.fn(),
});
type Spies = Record<Side, ReturnType<typeof spiesFor>>;

function Pair({
  spies,
  bTabs = dockTabs,
  bGroup = 'terminals',
  bInert = false,
  bTakesIn = true,
  aReorders = true,
  showA = true,
  children,
}: {
  spies: Spies;
  bTabs?: TabsClosableTab[];
  bGroup?: string;
  bInert?: boolean;
  bTakesIn?: boolean;
  aReorders?: boolean;
  showA?: boolean;
  children?: ReactNode;
}) {
  const [tabs, setTabs] = useState<Record<Side, TabsClosableTab[]>>({ A: panelTabs, B: bTabs });
  const strip = (side: Side, group: string, options: { reorders: boolean; takesIn: boolean }) => (
    <TabsClosable
      data-testid={side}
      aria-label={side === 'A' ? '패널 탭' : '도크 탭'}
      idPrefix={side}
      tabs={tabs[side]}
      selectedId={tabs[side][0]?.id ?? null}
      onSelect={spies[side].onSelect}
      onClose={spies[side].onClose}
      closeLabel={(tab) => `${tab.label} 닫기`}
      onReorder={options.reorders ? spies[side].onReorder : undefined}
      onTabDragChange={spies[side].onTabDragChange}
      moveGroup={group}
      onMoveOut={spies[side].onMoveOut}
      onMoveIn={
        options.takesIn
          ? (id, index, tab) => {
              spies[side].onMoveIn(id, index, tab);
              const other: Side = side === 'A' ? 'B' : 'A';
              setTabs((current) => {
                const into = current[side].filter((item) => item.id !== id);
                return {
                  ...current,
                  [other]: current[other].filter((item) => item.id !== id),
                  [side]: [...into.slice(0, index), tab, ...into.slice(index)],
                } as Record<Side, TabsClosableTab[]>;
              });
            }
          : undefined
      }
    />
  );
  return (
    <>
      {showA ? strip('A', 'terminals', { reorders: aReorders, takesIn: true }) : null}
      <div inert={bInert}>{strip('B', bGroup, { reorders: true, takesIn: bTakesIn })}</div>
      {children}
    </>
  );
}

// Strip A spans y 0–40, strip B y 100–140, a canvas y 300–500; tabs are 100px wide from x 0.
const tops: Record<string, number> = { A: 0, B: 100 };
let restore = () => {};
beforeEach(() => {
  const original = Element.prototype.getBoundingClientRect;
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
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const element = this as HTMLElement;
    const strip = element.closest<HTMLElement>('[data-slot="tabs-closable"]');
    const top = strip ? tops[strip.dataset.testid ?? ''] : undefined;
    if (top !== undefined && element.getAttribute('role') === 'tab') {
      return box(Number(element.dataset.fluidHoverIndex) * 100, top + 6, 100, 28);
    }
    if (top !== undefined && element === strip) return box(0, top, 600, 40);
    if (element.dataset.testid === 'canvas') return box(0, 300, 600, 200);
    return original.call(this);
  };
  restore = () => {
    Element.prototype.getBoundingClientRect = original;
  };
});
afterEach(() => restore());

const pointer = { pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1 };
const at = (x: number, y: number) => ({ ...pointer, clientX: x, clientY: y });
const lineIn = (side: Side) =>
  screen.getByTestId(side).querySelector<HTMLElement>('[data-slot="tabs-closable-drop-line"]');
const order = (side: Side) =>
  Array.from(screen.getByTestId(side).querySelectorAll('[role="tab"]')).map((tab) =>
    tab.id.replace(`${side}-tab-`, ''),
  );
const tabIn = (side: Side, name: string) =>
  screen
    .getByRole('tablist', { name: side === 'A' ? '패널 탭' : '도크 탭' })
    .querySelector<HTMLElement>(`#${side}-tab-${name}`) as HTMLElement;

/** Nothing but the move: no close, selection or reorder anywhere. */
function expectOnlyMoved(spies: Spies) {
  for (const side of ['A', 'B'] as const) {
    expect(spies[side].onClose, side).not.toHaveBeenCalled();
    expect(spies[side].onSelect, side).not.toHaveBeenCalled();
    expect(spies[side].onReorder, side).not.toHaveBeenCalled();
  }
}

it('moves a movable tab into the other strip of its group, at the slot under the pointer', () => {
  const spies = { A: spiesFor(), B: spiesFor() };
  render(<Pair spies={spies} />);
  const term = tabIn('A', 'term-1');
  fireEvent.pointerDown(term, at(150, 20));
  fireEvent.pointerMove(term, at(110, 120));
  expect(lineIn('B')).toHaveAttribute('data-at', '1');
  expect(lineIn('A')).toBeNull();
  fireEvent.pointerUp(term, at(110, 120));
  expect(spies.A.onMoveOut).toHaveBeenCalledExactlyOnceWith('term-1');
  expect(spies.B.onMoveIn).toHaveBeenCalledExactlyOnceWith(
    'term-1',
    1,
    expect.objectContaining({ id: 'term-1', label: '터미널 1', movable: true }),
  );
  expect(spies.B.onMoveOut).not.toHaveBeenCalled();
  expect(spies.A.onMoveIn).not.toHaveBeenCalled();
  expectOnlyMoved(spies);
  expect(order('A')).toEqual(['files', 'changes']);
  expect(order('B')).toEqual(['term-2', 'term-1', 'debug']);
  expect(lineIn('A')).toBeNull();
  expect(lineIn('B')).toBeNull();
  expect(spies.A.onTabDragChange.mock.calls).toEqual([[true], [false]]);
});

it('takes a tab into the other strip up to 12px above and below it', () => {
  const spies = { A: spiesFor(), B: spiesFor() };
  render(<Pair spies={spies} />);
  const term = tabIn('A', 'term-1');
  fireEvent.pointerDown(term, at(150, 20));
  for (const [y, inB] of [
    [87, false],
    [88, true],
    [152, true],
    [153, false],
  ] as const) {
    fireEvent.pointerMove(term, at(110, y));
    if (inB) expect(lineIn('B'), String(y)).not.toBeNull();
    else expect(lineIn('B'), String(y)).toBeNull();
  }
  fireEvent.pointerUp(term, at(110, 153));
  expect(spies.B.onMoveIn).not.toHaveBeenCalled();
  expect(spies.A.onMoveOut).not.toHaveBeenCalled();
});

it('keeps a tab that is not movable in its own strip', () => {
  const spies = { A: spiesFor(), B: spiesFor() };
  render(<Pair spies={spies} />);
  const files = tabIn('A', 'files');
  fireEvent.pointerDown(files, at(50, 20));
  fireEvent.pointerMove(files, at(110, 120));
  expect(lineIn('B')).toBeNull();
  fireEvent.pointerUp(files, at(110, 120));
  expect(spies.B.onMoveIn).not.toHaveBeenCalled();
  expect(spies.A.onMoveOut).not.toHaveBeenCalled();
  expectOnlyMoved(spies);
  expect(order('A')).toEqual(['files', 'term-1', 'changes']);
});

it('lets a movable tab leave a strip that does not reorder, and only that tab drags there', () => {
  const spies = { A: spiesFor(), B: spiesFor() };
  render(<Pair spies={spies} aReorders={false} />);
  const files = tabIn('A', 'files');
  fireEvent.pointerDown(files, at(50, 20));
  fireEvent.pointerMove(files, at(250, 20));
  fireEvent.pointerUp(files, at(250, 20));
  expect(spies.A.onTabDragChange).not.toHaveBeenCalled();
  const term = tabIn('A', 'term-1');
  fireEvent.pointerDown(term, at(150, 20));
  // Over its own strip there is nowhere to land.
  fireEvent.pointerMove(term, at(290, 20));
  expect(lineIn('A')).toBeNull();
  fireEvent.pointerMove(term, at(10, 120));
  expect(lineIn('B')).toHaveAttribute('data-at', '0');
  fireEvent.pointerUp(term, at(10, 120));
  expect(spies.B.onMoveIn).toHaveBeenCalledWith('term-1', 0, expect.anything());
  expect(order('B')).toEqual(['term-1', 'term-2', 'debug']);
});

it('crosses only into a strip of its group that takes tabs in', () => {
  for (const props of [{ bGroup: 'other' }, { bTakesIn: false }]) {
    const spies = { A: spiesFor(), B: spiesFor() };
    const view = render(<Pair spies={spies} {...props} />);
    const term = tabIn('A', 'term-1');
    fireEvent.pointerDown(term, at(150, 20));
    fireEvent.pointerMove(term, at(110, 120));
    expect(lineIn('B'), JSON.stringify(props)).toBeNull();
    fireEvent.pointerUp(term, at(110, 120));
    expect(spies.A.onMoveOut, JSON.stringify(props)).not.toHaveBeenCalled();
    expect(spies.B.onMoveIn, JSON.stringify(props)).not.toHaveBeenCalled();
    view.unmount();
  }
});

it('leaves a strip that is out of use alone (under a drawer, closed, withdrawn)', () => {
  const spies = { A: spiesFor(), B: spiesFor() };
  render(<Pair spies={spies} bInert />);
  const term = tabIn('A', 'term-1');
  fireEvent.pointerDown(term, at(150, 20));
  fireEvent.pointerMove(term, at(110, 120));
  expect(lineIn('B')).toBeNull();
  fireEvent.pointerUp(term, at(110, 120));
  expect(spies.B.onMoveIn).not.toHaveBeenCalled();
  expect(spies.A.onMoveOut).not.toHaveBeenCalled();
});

it('takes a tab into an empty strip of the group at 0', () => {
  const spies = { A: spiesFor(), B: spiesFor() };
  render(<Pair spies={spies} bTabs={[]} />);
  const term = tabIn('A', 'term-1');
  fireEvent.pointerDown(term, at(150, 20));
  fireEvent.pointerMove(term, at(300, 120));
  expect(lineIn('B')).toHaveAttribute('data-at', '0');
  fireEvent.pointerUp(term, at(300, 120));
  expect(spies.B.onMoveIn).toHaveBeenCalledExactlyOnceWith('term-1', 0, expect.anything());
  expect(order('B')).toEqual(['term-1']);
});

it('clears the other strip’s line on Escape and on a drop outside any strip, and moves nothing', () => {
  const spies = { A: spiesFor(), B: spiesFor() };
  render(<Pair spies={spies} />);
  const term = tabIn('A', 'term-1');
  fireEvent.pointerDown(term, at(150, 20));
  fireEvent.pointerMove(term, at(110, 120));
  expect(lineIn('B')).not.toBeNull();
  expect(fireEvent.keyDown(term, { key: 'Escape' })).toBe(false);
  expect(lineIn('B')).toBeNull();
  fireEvent.pointerUp(term, at(110, 120));
  fireEvent.click(term);
  fireEvent.pointerDown(term, at(150, 20));
  fireEvent.pointerMove(term, at(110, 120));
  expect(lineIn('B')).not.toBeNull();
  fireEvent.pointerMove(term, at(110, 600));
  expect(lineIn('B')).toBeNull();
  fireEvent.pointerUp(term, at(110, 600));
  expect(spies.A.onMoveOut).not.toHaveBeenCalled();
  expect(spies.B.onMoveIn).not.toHaveBeenCalled();
  expectOnlyMoved(spies);
  expect(order('A')).toEqual(['files', 'term-1', 'changes']);
});

it('clears the other strip’s line when the dragged tab’s strip goes away mid-drag', () => {
  const spies = { A: spiesFor(), B: spiesFor() };
  const view = render(<Pair spies={spies} />);
  const term = tabIn('A', 'term-1');
  fireEvent.pointerDown(term, at(150, 20));
  fireEvent.pointerMove(term, at(110, 120));
  expect(lineIn('B')).not.toBeNull();
  view.rerender(<Pair spies={spies} showA={false} />);
  expect(lineIn('B')).toBeNull();
  expect(spies.A.onTabDragChange).toHaveBeenLastCalledWith(false);
  expect(spies.B.onMoveIn).not.toHaveBeenCalled();
});

it('is refused by a canvas that takes only the team editor’s step drags', () => {
  const spies = { A: spiesFor(), B: spiesFor() };
  const entered = vi.fn();
  const accepted = vi.fn();
  const dropped = vi.fn();
  render(
    <Pair spies={spies}>
      {/* As TeamGraphCanvas: it accepts a drag only when it carries the step type. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: Stands in for the team editor's canvas, a drop target only. */}
      <div
        data-testid="canvas"
        onDragEnter={entered}
        onDragOver={(event) => {
          if (!event.dataTransfer?.types.includes(STEP_DRAG_TYPE)) return;
          event.preventDefault();
          accepted();
        }}
        onDrop={dropped}
      />
    </Pair>,
  );
  const term = tabIn('A', 'term-1');
  // Nothing on a tab starts an HTML5 drag.
  for (const tab of screen.getAllByRole('tab')) {
    expect(tab).not.toHaveAttribute('draggable', 'true');
    expect(fireEvent.dragStart(tab)).toBe(false);
  }
  fireEvent.pointerDown(term, at(150, 20));
  fireEvent.pointerMove(term, at(100, 400));
  fireEvent.pointerUp(term, at(100, 400));
  expect(entered).not.toHaveBeenCalled();
  expect(accepted).not.toHaveBeenCalled();
  expect(dropped).not.toHaveBeenCalled();
  expect(spies.A.onMoveOut).not.toHaveBeenCalled();
  expect(spies.B.onMoveIn).not.toHaveBeenCalled();
  expectOnlyMoved(spies);
});

it('ends a drag on Escape without closing the drawer the strip is in', () => {
  const onEscape = vi.fn();
  const onTabDragChange = vi.fn();
  const view = render(
    <SidePanelFrame
      presentation="drawer"
      sideLabel="패널"
      sideWidth={400}
      drawerWidth={400}
      onEscape={onEscape}
      main={<p>대화</p>}
      side={
        <TabsClosable
          data-testid="A"
          aria-label="패널 탭"
          idPrefix="A"
          tabs={panelTabs}
          selectedId="files"
          onSelect={() => {}}
          onClose={() => {}}
          closeLabel={(tab) => `${tab.label} 닫기`}
          onReorder={() => {}}
          onTabDragChange={onTabDragChange}
        />
      }
    />,
  );
  const term = tabIn('A', 'term-1');
  fireEvent.pointerDown(term, at(150, 20));
  fireEvent.pointerMove(term, at(290, 20));
  expect(onTabDragChange).toHaveBeenLastCalledWith(true);
  fireEvent.keyDown(term, { key: 'Escape' });
  expect(onTabDragChange).toHaveBeenLastCalledWith(false);
  expect(onEscape).not.toHaveBeenCalled();
  // With no drag, Escape is the drawer's again.
  fireEvent.keyDown(term, { key: 'Escape' });
  expect(onEscape).toHaveBeenCalledTimes(1);
  view.unmount();
});
