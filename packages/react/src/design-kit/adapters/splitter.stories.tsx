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
