import type { Meta, StoryObj } from '@storybook/react-vite';
import { Bug, File, GitCompare, Plus, Terminal } from 'lucide-react';
import { expect, fn, waitFor, within } from 'storybook/test';
import { Menu, MenuItem, MenuPopup, MenuTrigger } from './menu.tsx';

const reason = '실행 중인 터미널이 있어요';

/** A "+" list whose terminal row stays while a terminal cannot be made, with the reason under it. */
function PlusList({ onPick }: { onPick?: (name: string) => void }) {
  return (
    <Menu>
      <MenuTrigger
        aria-label="탭 열기"
        className="inline-flex size-7 items-center justify-center rounded-md hover:bg-active"
      >
        <Plus size={14} />
      </MenuTrigger>
      <MenuPopup align="start">
        <MenuItem icon={File} onClick={() => onPick?.('파일')}>
          파일
        </MenuItem>
        <MenuItem icon={Terminal} disabled description={reason} onClick={() => onPick?.('터미널')}>
          터미널
        </MenuItem>
        <MenuItem icon={GitCompare} onClick={() => onPick?.('변경')}>
          변경
        </MenuItem>
        <MenuItem icon={Bug} disabled onClick={() => onPick?.('디버그')}>
          디버그
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

const meta = {
  title: 'Design kit/Menu',
  component: PlusList,
  args: { onPick: fn() },
} satisfies Meta<typeof PlusList>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The arrows reach the unavailable row, which says why; choosing it does nothing and the list
 *  stays open. */
export const UnavailableRow: Story = {
  play: async ({ canvasElement, userEvent, args }) => {
    const page = within(canvasElement.ownerDocument.body);
    const trigger = within(canvasElement).getByRole('button', { name: '탭 열기' });
    trigger.focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(page.getByRole('menuitem', { name: '파일' })).toHaveFocus());
    await userEvent.keyboard('{ArrowDown}');
    const terminal = page.getByRole('menuitem', { name: '터미널' });
    await waitFor(() => expect(terminal).toHaveFocus());
    await expect(terminal).toHaveAttribute('aria-disabled', 'true');
    await expect(terminal).toHaveAccessibleDescription(reason);
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard(' ');
    await expect(args.onPick).not.toHaveBeenCalled();
    await expect(page.getByRole('menu')).toBeVisible();
    // The reason is the second line, under the label, in the secondary colour and not dimmed.
    const line = page.getByText(reason);
    const label = within(terminal).getAllByText('터미널').at(-1) as HTMLElement;
    await expect(line.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      label.getBoundingClientRect().bottom,
    );
    await expect(getComputedStyle(line).opacity).toBe('1');
    await expect(getComputedStyle(terminal).opacity).toBe('1');
    // A disabled row with no reason is reached too, as before.
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    await waitFor(() => expect(page.getByRole('menuitem', { name: '디버그' })).toHaveFocus());
    // A real press on the row (Chromium's own pointer, under the test runner only) lands on the
    // list behind it: nothing is chosen and the list stays open.
    if ((import.meta as { env?: { MODE?: string } }).env?.MODE === 'test') {
      const browser = await import('vitest/browser' as string);
      await browser.userEvent.click(terminal, { force: true });
      await expect(args.onPick).not.toHaveBeenCalled();
      await expect(page.getByRole('menu')).toBeVisible();
      // A real key puts the page back in keyboard modality for the stories after this one.
      await browser.userEvent.keyboard('{Shift}');
    }
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(page.queryByRole('menu')).toBeNull());
  },
};

/** A row its host draws through its own component (as a "+" list's terminal row is), which the
 *  popup cannot number. */
function HostRow({ onPick }: { onPick?: (name: string) => void }) {
  return (
    <MenuItem icon={Terminal} onClick={() => onPick?.('터미널')}>
      터미널
    </MenuItem>
  );
}

function WrappedList({ onPick }: { onPick?: (name: string) => void }) {
  return (
    <Menu>
      <MenuTrigger
        aria-label="탭 열기"
        className="inline-flex size-7 items-center justify-center rounded-md hover:bg-active"
      >
        <Plus size={14} />
      </MenuTrigger>
      <MenuPopup align="start">
        <MenuItem icon={File} onClick={() => onPick?.('파일')}>
          파일
        </MenuItem>
        <HostRow onPick={onPick} />
        <MenuItem icon={GitCompare} onClick={() => onPick?.('변경')}>
          변경
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

/** Choosing a row chooses that row alone, even beside a row its host draws through its own
 *  component: the press is never taken for one between rows. */
export const RowBesideHostRow: Story = {
  render: (args) => <WrappedList {...args} />,
  play: async ({ canvasElement, userEvent, args }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(within(canvasElement).getByRole('button', { name: '탭 열기' }));
    const files = await waitFor(() => page.getByRole('menuitem', { name: '파일' }));
    await userEvent.hover(files);
    await userEvent.click(files);
    await expect(args.onPick).toHaveBeenCalledTimes(1);
    await expect(args.onPick).toHaveBeenCalledWith('파일');
    await waitFor(() => expect(page.queryByRole('menu')).toBeNull());

    await userEvent.click(within(canvasElement).getByRole('button', { name: '탭 열기' }));
    const terminal = await waitFor(() => page.getByRole('menuitem', { name: '터미널' }));
    await userEvent.hover(terminal);
    await userEvent.click(terminal);
    await expect(args.onPick).toHaveBeenCalledTimes(2);
    await expect(args.onPick).toHaveBeenLastCalledWith('터미널');
    await waitFor(() => expect(page.queryByRole('menu')).toBeNull());
  },
};
