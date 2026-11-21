import type { Meta, StoryObj } from '@storybook/react-vite';
import { File, GitCompare, Maximize2, Package, Play, Plus } from 'lucide-react';
import { useState } from 'react';
import { expect, fn, waitFor, within } from 'storybook/test';
import { Button } from './button.tsx';
import { SidePanelFrame, type SidePanelPresentation } from './side-panel-frame.tsx';
import { TabsClosable, TabsClosablePanel, type TabsClosableTab } from './tabs-closable.tsx';

const tabs: TabsClosableTab[] = [
  { id: 'files', label: '파일', icon: File },
  { id: 'changes', label: '변경', icon: GitCompare },
  { id: 'run-1', label: '실행 #1', shortLabel: '#1', icon: Play },
  { id: 'artifacts', label: '결과', icon: Package },
];

const presentations: SidePanelPresentation[] = [
  'closed',
  'beside',
  'maximized',
  'drawer',
  'withdrawn',
];

function Host({
  initial = 'beside',
  width = 960,
  height = 420,
  dock = false,
  dockHeight: initialDockHeight = 160,
  onScrimPress,
  onEscape,
}: {
  initial?: SidePanelPresentation;
  width?: number;
  height?: number;
  /** A bottom region (a dock) under the conversation and the panel. */
  dock?: boolean;
  dockHeight?: number;
  onScrimPress?: () => void;
  onEscape?: () => void;
}) {
  const [presentation, setPresentation] = useState(initial);
  const [sideWidth, setSideWidth] = useState(400);
  const [selected, setSelected] = useState('files');
  const [frameWidth, setFrameWidth] = useState(0);
  const [dockHeight, setDockHeight] = useState(Number(initialDockHeight));
  const [shownDockHeight, setShownDockHeight] = useState<number | null>(null);
  const [dockWithdrawn, setDockWithdrawn] = useState(false);
  const bottom = dock
    ? {
        bottom: (
          <div className="flex min-h-0 flex-1 flex-col p-3 text-ui text-muted-foreground">
            <input
              aria-label="터미널 입력"
              className="h-9 w-full rounded-lg border border-border bg-transparent px-3 text-ui"
            />
          </div>
        ),
        bottomLabel: '도크',
        bottomHeight: dockHeight,
        mainMinHeight: 160,
        bottomMinHeight: 120,
        onShownBottomHeightChange: setShownDockHeight,
        onBottomWithdrawnChange: setDockWithdrawn,
        bottomResize: {
          'aria-label': '도크 높이',
          min: 96,
          max: 480,
          onChange: setDockHeight,
          onReset: () => setDockHeight(160),
        },
      }
    : {};
  return (
    // Story URLs pass the width as text.
    <div className="flex flex-col gap-2" style={{ width: Number(width), maxWidth: '100%' }}>
      {/* Stands in for the sidebar and top bar: outside the frame, always operable. */}
      <div role="toolbar" aria-label="보기" className="flex gap-1">
        {presentations.map((value) => (
          <Button
            key={value}
            size="compact"
            variant="ghost"
            aria-pressed={presentation === value}
            onClick={() => setPresentation(value)}
          >
            {value}
          </Button>
        ))}
        {dock ? (
          <output aria-label="보이는 도크 높이" className="ms-auto text-ui text-muted-foreground">
            {dockWithdrawn ? 'withdrawn' : shownDockHeight}
          </output>
        ) : null}
      </div>
      <SidePanelFrame
        {...bottom}
        className="rounded-xl border border-border bg-background"
        style={{ height: Number(height) }}
        presentation={presentation}
        sideLabel="패널"
        sideWidth={sideWidth}
        // A narrow frame gives the drawer all of its width.
        drawerWidth={frameWidth > 0 && frameWidth < 640 ? frameWidth : 400}
        onFrameWidthChange={setFrameWidth}
        resize={{ 'aria-label': '패널 폭', min: 360, max: 560, onChange: setSideWidth }}
        onScrimPress={() => {
          onScrimPress?.();
          setPresentation('closed');
        }}
        onEscape={() => {
          onEscape?.();
          setPresentation('closed');
        }}
        main={
          <div className="flex min-h-0 flex-1 flex-col">
            <div
              data-testid="conversation"
              // biome-ignore lint/a11y/noNoninteractiveTabindex: A scrolling log takes the focus so the keyboard can scroll it.
              tabIndex={0}
              className="min-h-0 flex-1 overflow-y-auto p-4 text-ui"
            >
              {Array.from({ length: 40 }, (_, index) => (
                <p key={String(index)} className="py-1 text-muted-foreground">
                  메시지 {index + 1}
                </p>
              ))}
            </div>
            <div className="border-t border-border p-3">
              <input
                aria-label="메시지"
                className="h-9 w-full rounded-lg border border-border bg-transparent px-3 text-ui"
              />
            </div>
          </div>
        }
        side={
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex h-10 shrink-0 items-center border-b border-border px-2">
              <TabsClosable
                className="flex-1"
                aria-label="패널 탭"
                idPrefix="frame"
                tabs={tabs}
                selectedId={selected}
                onSelect={setSelected}
                onClose={() => {}}
                closeLabel={(tab) => `${tab.label} 닫기`}
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
                    aria-pressed={presentation === 'maximized'}
                    onClick={() =>
                      setPresentation(presentation === 'maximized' ? 'beside' : 'maximized')
                    }
                  >
                    <Maximize2 />
                  </Button>
                }
              />
            </div>
            {tabs.map((tab) => (
              <TabsClosablePanel
                key={tab.id}
                idPrefix="frame"
                tabId={tab.id}
                selected={tab.id === selected}
                className="min-h-0 flex-1 p-4 text-ui text-muted-foreground"
              >
                <label className="flex flex-col gap-1">
                  {tab.label}
                  <input className="h-9 rounded-lg border border-border bg-transparent px-3" />
                </label>
              </TabsClosablePanel>
            ))}
          </div>
        }
      />
    </div>
  );
}

const meta = {
  title: 'Design kit/SidePanelFrame',
  component: Host,
  args: { onScrimPress: fn(), onEscape: fn() },
  argTypes: {
    initial: { options: presentations, control: 'select' },
    width: { control: 'number' },
    height: { control: 'number' },
    dock: { control: 'boolean' },
    dockHeight: { control: 'number' },
  },
} satisfies Meta<typeof Host>;
export default meta;
type Story = StoryObj<typeof meta>;

function parts(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const main = canvasElement.querySelector<HTMLElement>('[data-slot="side-panel-main"]');
  if (!main) throw new Error('Missing the main region');
  const show = async (value: SidePanelPresentation) => {
    const button = canvas.getByRole('button', { name: value });
    button.click();
    await waitFor(() => expect(button).toHaveAttribute('aria-pressed', 'true'));
  };
  return { canvas, main, show };
}

const settled = (element: HTMLElement) =>
  waitFor(() =>
    expect(getComputedStyle(element).transform).toMatch(/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/),
  );

export const Beside: Story = {
  play: async ({ canvasElement, userEvent }) => {
    const { canvas, main } = parts(canvasElement);
    const side = canvas.getByRole('region', { name: '패널' });
    await expect(main).not.toHaveAttribute('inert');
    await expect(side.getBoundingClientRect().width).toBe(400);
    // Tab order: the conversation, then the splitter, then the panel.
    const splitter = canvas.getByRole('separator', { name: '패널 폭' });
    canvas.getByRole('textbox', { name: '메시지' }).focus();
    await userEvent.tab();
    await expect(splitter).toHaveFocus();
    splitter.blur();
  },
};

export const Drawer: Story = {
  args: { initial: 'closed' },
  play: async ({ canvasElement, userEvent, args }) => {
    const { canvas, main, show } = parts(canvasElement);
    await show('drawer');
    const side = await canvas.findByRole('region', { name: '패널' });
    await settled(side);
    await expect(main).toHaveAttribute('inert');
    const scrim = canvasElement.querySelector<HTMLElement>('[data-slot="side-panel-scrim"]');
    if (!scrim) throw new Error('Missing the scrim');
    // Only the main region is dimmed; the frame's right edge holds the drawer.
    const frame = canvasElement.querySelector<HTMLElement>('[data-slot="side-panel-frame"]');
    await expect(Math.round(side.getBoundingClientRect().right)).toBe(
      Math.round((frame as HTMLElement).getBoundingClientRect().right) - 1,
    );
    await expect(Math.round(side.getBoundingClientRect().width)).toBe(400);
    // What is outside the frame stays operable, and pressing it is not a press on the scrim.
    await userEvent.click(canvas.getByRole('button', { name: 'beside' }));
    await expect(args.onScrimPress).not.toHaveBeenCalled();
    await expect(main).not.toHaveAttribute('inert');
    await show('drawer');
    await settled(await canvas.findByRole('region', { name: '패널' }));
    // Escape closes the drawer.
    canvas.getByRole('tab', { name: '파일' }).focus();
    await userEvent.keyboard('{Escape}');
    await expect(args.onEscape).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(canvas.queryByRole('region', { name: '패널' })).toBeNull());
    await expect(main).not.toHaveAttribute('inert');
    // So does a press on the dimmed conversation.
    await show('drawer');
    await settled(await canvas.findByRole('region', { name: '패널' }));
    const again = canvasElement.querySelector<HTMLElement>('[data-slot="side-panel-scrim"]');
    await userEvent.click(again as HTMLElement);
    await expect(args.onScrimPress).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(canvasElement.querySelector('[data-slot="side-panel-scrim"]')).toBeNull(),
    );
    // Closed, the side stays mounted for its tabs' state, hidden and out of reach.
    await waitFor(() =>
      expect(canvasElement.querySelector('[data-slot="side-panel-side"]')).toHaveAttribute(
        'data-presentation',
        'closed',
      ),
    );
    await expect(canvas.queryByRole('region', { name: '패널' })).toBeNull();
  },
};

/** One Escape closes the drawer even while a tooltip in it is open. */
export const EscapeOverTooltip: Story = {
  args: { initial: 'drawer' },
  play: async ({ canvasElement, userEvent, args }) => {
    const { canvas } = parts(canvasElement);
    const page = within(canvasElement.ownerDocument.body);
    const side = canvas.getByRole('region', { name: '패널' });
    await settled(side);
    const close = canvas.getByRole('button', { name: '파일 닫기' });
    await userEvent.hover(close);
    await expect(await page.findByRole('tooltip')).toHaveTextContent('파일 닫기');
    await userEvent.keyboard('{Escape}');
    await expect(args.onEscape).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(canvas.queryByRole('region', { name: '패널' })).toBeNull());
    await waitFor(() => expect(page.queryByRole('tooltip')).toBeNull());
    await userEvent.unhover(close);
  },
};

/** Focus moved into the drawer while it slides in scrolls nothing sideways. */
export const FocusDuringSlide: Story = {
  args: { initial: 'closed' },
  play: async ({ canvasElement }) => {
    const { canvas, show } = parts(canvasElement);
    const frame = canvasElement.querySelector<HTMLElement>(
      '[data-slot="side-panel-frame"]',
    ) as HTMLElement;
    const scrolled = () => {
      const offsets: number[] = [];
      for (let node: HTMLElement | null = frame; node; node = node.parentElement) {
        offsets.push(node.scrollLeft);
      }
      return offsets;
    };
    const before = scrolled();
    await show('drawer');
    // At once, mid-slide.
    canvas.getByRole('tab', { name: '파일' }).focus();
    await expect(canvas.getByRole('tab', { name: '파일' })).toHaveFocus();
    await expect(frame.scrollLeft).toBe(0);
    const side = canvas.getByRole('region', { name: '패널' });
    await settled(side);
    await expect(scrolled()).toEqual(before);
    await expect(Math.round(side.getBoundingClientRect().right)).toBe(
      Math.round(frame.getBoundingClientRect().right) - 1,
    );
  },
};

/** A narrow frame: the host gives the drawer all of it. */
export const NarrowDrawer: Story = {
  args: { initial: 'drawer', width: 480 },
  play: async ({ canvasElement }) => {
    const { canvas } = parts(canvasElement);
    const side = canvas.getByRole('region', { name: '패널' });
    await settled(side);
    const frame = canvasElement.querySelector<HTMLElement>('[data-slot="side-panel-frame"]');
    await expect(Math.round(side.getBoundingClientRect().width)).toBe(
      Math.round((frame as HTMLElement).clientWidth),
    );
  },
};

/** Maximizing and coming back keeps the conversation where it was, and the panel's draft. */
export const KeepsState: Story = {
  play: async ({ canvasElement, userEvent }) => {
    const { canvas, main, show } = parts(canvasElement);
    const log = canvas.getByTestId('conversation');
    log.scrollTop = 240;
    const field = within(canvas.getByRole('tabpanel', { name: '파일' })).getByRole('textbox');
    await userEvent.type(field, '초안');
    await userEvent.click(canvas.getByRole('button', { name: '넓히기' }));
    await expect(main).toHaveAttribute('inert');
    await expect(main).not.toBeVisible();
    await expect(canvas.getByRole('region', { name: '패널' }).getBoundingClientRect().width).toBe(
      (canvasElement.querySelector('[data-slot="side-panel-frame"]') as HTMLElement).clientWidth,
    );
    await userEvent.click(canvas.getByRole('button', { name: '넓히기' }));
    await expect(main).toBeVisible();
    await expect(log.scrollTop).toBe(240);
    await show('withdrawn');
    await expect(canvas.queryByRole('region', { name: '패널' })).toBeNull();
    await show('beside');
    await expect(
      within(canvas.getByRole('tabpanel', { name: '파일' })).getByRole('textbox'),
    ).toHaveValue('초안');
    await expect(log.scrollTop).toBe(240);
  },
};

/** A dock under both: a drawer and its scrim cover it too; a maximized panel covers the
 *  conversation only; the dock yields so the conversation keeps 160px. */
export const WithDock: Story = {
  args: { dock: true, dockHeight: 160 },
  play: async ({ canvasElement, userEvent }) => {
    const { canvas, main, show } = parts(canvasElement);
    const frame = canvasElement.querySelector<HTMLElement>(
      '[data-slot="side-panel-frame"]',
    ) as HTMLElement;
    const area = canvasElement.querySelector<HTMLElement>(
      '[data-slot="side-panel-bottom-area"]',
    ) as HTMLElement;
    const dock = canvas.getByRole('region', { name: '도크' });
    const box = (element: Element) => element.getBoundingClientRect();
    const round = (value: number) => Math.round(value);
    // Beside: under the conversation and the panel, across the frame.
    const side = canvas.getByRole('region', { name: '패널' });
    await expect(round(box(dock).height)).toBe(160);
    await expect(round(box(dock).width)).toBe(frame.clientWidth);
    await expect(round(box(side).bottom)).toBe(round(box(dock).top));
    await expect(round(box(main).bottom)).toBe(round(box(dock).top));
    // Maximized: the panel covers the conversation, not the dock.
    await show('maximized');
    await expect(main).toHaveAttribute('inert');
    await expect(area).not.toHaveAttribute('inert');
    await expect(round(box(side).bottom)).toBe(round(box(dock).top));
    await expect(round(box(side).width)).toBe(frame.clientWidth);
    // Drawer: the drawer and the scrim reach the frame's foot, over the dock, which is out of use.
    await show('drawer');
    const drawer = await canvas.findByRole('region', { name: '패널' });
    await settled(drawer);
    await expect(area).toHaveAttribute('inert');
    const scrim = canvasElement.querySelector('[data-slot="side-panel-scrim"]') as HTMLElement;
    await expect(round(box(scrim).bottom)).toBe(round(box(frame).bottom) - 1);
    await expect(round(box(drawer).bottom)).toBe(round(box(frame).bottom) - 1);
    // A press on the dimmed dock is a press on the scrim.
    const foot = box(dock);
    await expect(
      canvasElement.ownerDocument.elementFromPoint(foot.left + 40, foot.top + foot.height / 2),
    ).toBe(scrim);
    await show('beside');
    await expect(area).not.toHaveAttribute('inert');
    // Dragging the line up grows the dock until the conversation has 160px left, then it stops.
    const splitter = canvas.getByRole('separator', { name: '도크 높이' });
    await expect(splitter).toHaveAttribute('aria-orientation', 'horizontal');
    const line = box(splitter);
    const x = line.left + line.width / 2;
    const y = line.top + line.height / 2;
    await userEvent.pointer([
      { keys: '[MouseLeft>]', target: splitter, coords: { clientX: x, clientY: y } },
      { target: splitter, coords: { clientX: x, clientY: y - 400 } },
      { keys: '[/MouseLeft]', target: splitter, coords: { clientX: x, clientY: y - 400 } },
    ]);
    const room = frame.clientHeight - 160;
    await waitFor(() => expect(round(box(dock).height)).toBe(room));
    await expect(round(box(main).height)).toBe(160);
    await expect(canvas.getByRole('status', { name: '보이는 도크 높이' })).toHaveTextContent(
      String(room),
    );
    // A double press puts it back.
    await userEvent.dblClick(splitter);
    await waitFor(() => expect(round(box(dock).height)).toBe(160));
    splitter.blur();
  },
};

/** A dock the host keeps taller than the frame allows: the shown dock yields, the kept one stays. */
export const DockYields: Story = {
  args: { dock: true, dockHeight: 400 },
  play: async ({ canvasElement }) => {
    const { canvas, main } = parts(canvasElement);
    const frame = canvasElement.querySelector<HTMLElement>(
      '[data-slot="side-panel-frame"]',
    ) as HTMLElement;
    const dock = canvas.getByRole('region', { name: '도크' });
    const room = frame.clientHeight - 160;
    await expect(Math.round(dock.getBoundingClientRect().height)).toBe(room);
    await expect(Math.round(main.getBoundingClientRect().height)).toBe(160);
    await expect(canvas.getByRole('status', { name: '보이는 도크 높이' })).toHaveTextContent(
      String(room),
    );
  },
};

/** A frame too low for the conversation's 160px and the dock's 120px: the dock is withdrawn, and
 *  comes back at its height when the frame grows. */
export const DockWithdraws: Story = {
  args: { dock: true, dockHeight: 200, height: 260 },
  play: async ({ canvasElement }) => {
    const { canvas, main } = parts(canvasElement);
    const frame = canvasElement.querySelector<HTMLElement>(
      '[data-slot="side-panel-frame"]',
    ) as HTMLElement;
    const status = canvas.getByRole('status', { name: '보이는 도크 높이' });
    await expect(status).toHaveTextContent('withdrawn');
    await expect(canvas.queryByRole('region', { name: '도크' })).toBeNull();
    await expect(canvas.queryByRole('separator', { name: '도크 높이' })).toBeNull();
    await expect(Math.round(main.getBoundingClientRect().height)).toBe(frame.clientHeight);
    frame.style.height = '600px';
    await waitFor(() => expect(status).toHaveTextContent('200'));
    const dock = canvas.getByRole('region', { name: '도크' });
    await expect(Math.round(dock.getBoundingClientRect().height)).toBe(200);
    await expect(canvas.getByRole('separator', { name: '도크 높이' })).toBeVisible();
  },
};

/** No play: the presentation and width come from the story's args, for looking at it. */
export const Playground: Story = {};

export const DarkDrawer: Story = {
  args: { initial: 'drawer', width: 900 },
  decorators: [(Story) => <div className="dark bg-background p-3 text-foreground">{Story()}</div>],
  play: async ({ canvasElement }) => {
    await settled(within(canvasElement).getByRole('region', { name: '패널' }));
  },
};
