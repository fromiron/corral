import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, waitFor, within } from 'storybook/test';
import { Splitter } from './splitter.tsx';

function Host({
  onChange,
  onCommit,
}: {
  onChange?: (px: number) => void;
  onCommit?: (px: number) => void;
}) {
  const [width, setWidth] = useState(240);
  return (
    <div className="flex h-48 w-[640px] max-w-full overflow-hidden rounded-xl border border-border bg-background text-ui">
      <div className="min-w-0 flex-1 p-3 text-muted-foreground">대화</div>
      <Splitter
        aria-label="패널 폭"
        value={width}
        min={200}
        max={360}
        onChange={(px) => {
          setWidth(px);
          onChange?.(px);
        }}
        onCommit={onCommit}
      />
      <div className="shrink-0 p-3 text-muted-foreground" style={{ width }}>
        패널
      </div>
    </div>
  );
}

const meta = {
  title: 'Design kit/Splitter',
  component: Host,
  args: { onChange: fn(), onCommit: fn() },
} satisfies Meta<typeof Host>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Keyboard: Story = {
  play: async ({ canvasElement, userEvent, args }) => {
    const splitter = within(canvasElement).getByRole('separator', { name: '패널 폭' });
    await userEvent.tab();
    await expect(splitter).toHaveFocus();
    await userEvent.keyboard('{ArrowLeft}');
    await expect(splitter).toHaveAttribute('aria-valuenow', '256');
    await expect(args.onCommit).toHaveBeenLastCalledWith(256);
    await userEvent.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}');
    await expect(splitter).toHaveAttribute('aria-valuenow', '200');
    await userEvent.keyboard('{ArrowRight}');
    await expect(splitter).toHaveAttribute('aria-valuenow', '200');
    await expect(args.onChange).not.toHaveBeenCalledWith(184);
    // The panel takes the width the splitter says.
    const panel = within(canvasElement).getByText('패널');
    await expect(panel.getBoundingClientRect().width).toBe(200);
  },
};

export const Drag: Story = {
  play: async ({ canvasElement, args }) => {
    const splitter = within(canvasElement).getByRole('separator', { name: '패널 폭' });
    const box = splitter.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    const at = (clientX: number, buttons = 1) => ({
      pointerId: 1,
      button: 0,
      buttons,
      clientX,
      clientY: y,
      bubbles: true,
    });
    splitter.dispatchEvent(new PointerEvent('pointerdown', at(x)));
    splitter.dispatchEvent(new PointerEvent('pointermove', at(x - 40)));
    await waitFor(() => expect(splitter).toHaveAttribute('data-dragging'));
    splitter.dispatchEvent(new PointerEvent('pointerup', at(x - 40, 0)));
    await expect(args.onCommit).toHaveBeenLastCalledWith(280);
    await waitFor(() => expect(splitter).not.toHaveAttribute('data-dragging'));
    splitter.blur();
  },
};

/** A real pointer, pressed on the strip and released far outside it: the strip keeps the moves
 *  only while it holds the pointer's capture. Runs only under the test runner. */
export const DragOutside: Story = {
  play: async ({ canvasElement, args }) => {
    // Vitest's mode; the module is the runner's own, so its types (which reshape the matchers)
    // stay out of the build.
    if ((import.meta as { env?: { MODE?: string } }).env?.MODE !== 'test') return;
    const { userEvent } = await import('vitest/browser' as string);
    const canvas = within(canvasElement);
    const splitter = canvas.getByRole('separator', { name: '패널 폭' });
    const conversation = canvas.getByText('대화');
    const strip = splitter.getBoundingClientRect();
    const target = conversation.getBoundingClientRect();
    // 60px to the left of the strip's centre, over the conversation.
    await userEvent.dragAndDrop(splitter, conversation, {
      sourcePosition: { x: strip.width / 2, y: strip.height / 2 },
      targetPosition: {
        x: strip.left + strip.width / 2 - 60 - target.left,
        y: target.height / 2,
      },
    } as never);
    await waitFor(() => expect(splitter).toHaveAttribute('aria-valuenow', '300'));
    await expect(args.onCommit).toHaveBeenLastCalledWith(300);
    await expect(splitter).not.toHaveAttribute('data-dragging');
  },
};

/** No play, for looking at it. */
export const Playground: Story = {};

/** A conversation above and a dock below: the line is the dock's first pixel. */
function Rows({ onReset }: { onReset?: () => void }) {
  const [height, setHeight] = useState(120);
  return (
    <div className="flex h-72 w-[480px] max-w-full flex-col overflow-hidden rounded-xl border border-border bg-background text-ui">
      <div className="min-h-0 flex-1 p-3 text-muted-foreground">대화</div>
      <Splitter
        aria-label="도크 높이"
        orientation="horizontal"
        side="bottom"
        value={height}
        min={80}
        max={200}
        onChange={setHeight}
        onReset={() => {
          setHeight(120);
          onReset?.();
        }}
      />
      <div className="shrink-0 p-3 text-muted-foreground" style={{ height }}>
        도크
      </div>
    </div>
  );
}

/** ArrowUp grows the dock, ArrowDown shrinks it; a drag goes along y; a double press resets. */
export const Horizontal: Story = {
  render: () => <Rows />,
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    const splitter = canvas.getByRole('separator', { name: '도크 높이' });
    await expect(splitter).toHaveAttribute('aria-orientation', 'horizontal');
    await expect(getComputedStyle(splitter).cursor).toBe('row-resize');
    await expect(splitter.getBoundingClientRect().height).toBe(8);
    const dock = canvas.getByText('도크');
    // The line is the dock's first pixel: the strip lies over the dock.
    await expect(Math.round(splitter.getBoundingClientRect().top)).toBe(
      Math.round(dock.getBoundingClientRect().top),
    );
    await userEvent.tab();
    await expect(splitter).toHaveFocus();
    await userEvent.keyboard('{ArrowUp}');
    await expect(splitter).toHaveAttribute('aria-valuenow', '136');
    await expect(dock.getBoundingClientRect().height).toBe(136);
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    await expect(splitter).toHaveAttribute('aria-valuenow', '104');
    const box = splitter.getBoundingClientRect();
    const at = (clientY: number, buttons = 1) => ({
      pointerId: 1,
      button: 0,
      buttons,
      clientX: box.left + 40,
      clientY,
      bubbles: true,
    });
    const y = box.top + box.height / 2;
    splitter.dispatchEvent(new PointerEvent('pointerdown', at(y)));
    splitter.dispatchEvent(new PointerEvent('pointermove', at(y - 30)));
    await waitFor(() => expect(splitter).toHaveAttribute('aria-valuenow', '134'));
    splitter.dispatchEvent(new PointerEvent('pointerup', at(y - 30, 0)));
    splitter.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await waitFor(() => expect(splitter).toHaveAttribute('aria-valuenow', '120'));
    splitter.blur();
  },
};
