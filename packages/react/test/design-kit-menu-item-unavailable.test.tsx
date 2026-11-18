import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { File, GitCompare, Terminal } from 'lucide-react';
import { expect, it, vi } from 'vitest';
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '../src/design-kit/adapters/menu.tsx';

// S4: the "+" list keeps its terminal row while a terminal cannot be made. The row is disabled but
// reachable by the arrows, so a screen reader hears it with its reason; choosing it does nothing
// and leaves the menu open; the reason is a second line the row is described by.

const reason = '실행 중인 터미널이 있어요';

function Plus({ onFiles = () => {}, onTerminal = () => {} }) {
  return (
    <Menu>
      <MenuTrigger>탭 열기</MenuTrigger>
      <MenuPopup>
        <MenuItem icon={File} onClick={onFiles}>
          파일
        </MenuItem>
        <MenuItem icon={Terminal} disabled description={reason} onClick={onTerminal}>
          터미널
        </MenuItem>
        <MenuItem icon={GitCompare}>변경</MenuItem>
      </MenuPopup>
    </Menu>
  );
}

async function open() {
  const user = userEvent.setup();
  const trigger = screen.getByRole('button', { name: '탭 열기' });
  trigger.focus();
  await user.keyboard('{Enter}');
  await waitFor(() => expect(screen.getByRole('menu')).toBeInTheDocument());
  return { user, trigger };
}

it('lets the arrows reach an unavailable row, which is aria-disabled', async () => {
  render(<Plus />);
  const { user } = await open();
  await waitFor(() => expect(screen.getByRole('menuitem', { name: '파일' })).toHaveFocus());
  await user.keyboard('{ArrowDown}');
  const terminal = screen.getByRole('menuitem', { name: '터미널' });
  await waitFor(() => expect(terminal).toHaveFocus());
  expect(terminal).toHaveAttribute('aria-disabled', 'true');
  await user.keyboard('{ArrowDown}');
  await waitFor(() => expect(screen.getByRole('menuitem', { name: '변경' })).toHaveFocus());
});

it('does nothing when an unavailable row is chosen, and keeps the menu open', async () => {
  const onTerminal = vi.fn();
  render(<Plus onTerminal={onTerminal} />);
  const { user, trigger } = await open();
  await user.keyboard('{ArrowDown}');
  const terminal = screen.getByRole('menuitem', { name: '터미널' });
  await waitFor(() => expect(terminal).toHaveFocus());
  await user.keyboard('{Enter}');
  await user.keyboard(' ');
  // A press on the row itself, past its pointer-events: none.
  await userEvent.setup({ pointerEventsCheck: 0 }).click(terminal);
  expect(onTerminal).not.toHaveBeenCalled();
  expect(screen.getByRole('menu')).toBeInTheDocument();
  expect(trigger).toHaveAttribute('aria-expanded', 'true');
});

it('shows the reason as a second line the row is described by', async () => {
  render(<Plus />);
  await open();
  const terminal = screen.getByRole('menuitem', { name: '터미널' });
  expect(terminal).toHaveAccessibleName('터미널');
  expect(terminal).toHaveAccessibleDescription(reason);
  const line = screen.getByText(reason);
  expect(terminal.contains(line)).toBe(true);
  expect(line).toBeVisible();
  expect(line).toHaveClass('text-muted-foreground');
  expect(line.closest('.sr-only')).toBeNull();
  // An available row has no second line.
  expect(screen.getByRole('menuitem', { name: '파일' })).not.toHaveAccessibleDescription();
});
