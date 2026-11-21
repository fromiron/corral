import type { Receipt } from '@corral/contracts';
import { emptyProjection } from '@corral/core';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { sessionStore } from '../stories/fixtures.tsx';
import { RunActions } from './RunActions.tsx';

const pause: Receipt = {
  commandId: 'cmd_pause',
  runId: 'run_story',
  status: 'accepted',
  acceptedSeq: 4,
  target: 'run:run_story',
  requestedBoundary: 'safe_boundary',
  relatedEventIds: [],
};

/** A whole-run pause waiting for its boundary, and a resume whose response was lost (which sets
 *  the connection's error too). */
const session = () =>
  sessionStore({
    runId: 'run_story',
    projection: { ...emptyProjection('run_story'), status: 'pausing' },
    receipts: { cmd_pause: pause },
    commandTypes: { cmd_pause: 'pause' },
    commandError: 'the connection closed',
    unconfirmedCommands: {
      cmd_resume: {
        error: 'the connection closed',
        command: {
          schemaVersion: '0.1',
          runId: 'run_story',
          commandId: 'cmd_resume',
          type: 'resume',
          payload: { scope: 'run' },
        },
      },
    },
  });

/** The run tab's head beside the conversation, in a 360px panel: receipts only, one line each. */
function BesideHead({ width = 360 }: { width?: number }) {
  return (
    <section
      data-testid="head"
      className="@container/run-head border-b border-line px-4 py-2"
      style={{ width }}
    >
      <div className="flex min-h-9 min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <div className="flex min-w-0 max-w-full items-center gap-1">
          <RunActions session={session()} compact narrowIcons receiptsOnly receiptLines />
        </div>
      </div>
    </section>
  );
}

const meta = {
  title: 'Reins/RunActions',
  component: BesideHead,
} satisfies Meta<typeof BesideHead>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Each receipt keeps one line from the left edge; cut, its words show whole in the tooltip. */
export const ReceiptLines: Story = {
  args: { width: 360 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const page = within(canvasElement.ownerDocument.body);
    await document.fonts.ready;
    const head = canvas.getByTestId('head');
    const box = head.getBoundingClientRect();
    const lines = [...head.querySelectorAll<HTMLElement>('[data-slot="receipt-line"]')];
    await expect(lines).toHaveLength(2);
    for (const line of lines) {
      const rect = line.getBoundingClientRect();
      // One line, as tall as its action at most, from the head's left padding.
      await expect(rect.height).toBeLessThanOrEqual(28);
      await expect(Math.abs(rect.left - (box.left + 16))).toBeLessThanOrEqual(1);
      await expect(rect.right).toBeLessThanOrEqual(box.right - 16 + 1);
    }
    await expect(head.scrollWidth).toBeLessThanOrEqual(head.clientWidth);
    const retry = canvas.getByRole('button', { name: 'Check receipt and retry safely' });
    await expect(retry.getBoundingClientRect().right).toBeLessThanOrEqual(box.right - 16 + 1);
    const text = (line: HTMLElement) =>
      line.querySelector('[data-slot="receipt-line-text"]') as HTMLElement;
    const lost = text(retry.closest('[data-slot="receipt-line"]') as HTMLElement);
    await waitFor(() => expect(lost.scrollWidth).toBeGreaterThan(lost.clientWidth));
    await waitFor(() => expect(lost).toHaveAttribute('tabindex', '0'));
    // The keyboard reaches the cut words, and the tooltip says them whole.
    await userEvent.tab();
    await expect(lost).toHaveFocus();
    const tip = await page.findByRole('tooltip');
    await expect(tip).toHaveTextContent(
      'Resume run · Receipt not confirmed. Check the run before retrying.',
    );
    // The loss is said once, without the browser's words.
    await expect(head.textContent).not.toContain('the connection closed');
  },
};

/** Wide enough, a line is whole: no tab stop and no tooltip. */
export const ReceiptLinesWide: Story = {
  args: { width: 900 },
  play: async ({ canvasElement }) => {
    await document.fonts.ready;
    const texts = [
      ...canvasElement.querySelectorAll<HTMLElement>('[data-slot="receipt-line-text"]'),
    ];
    await expect(texts).toHaveLength(2);
    for (const text of texts) {
      await expect(text.scrollWidth).toBeLessThanOrEqual(text.clientWidth + 1);
      await expect(text).not.toHaveAttribute('tabindex');
    }
  },
};
