import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { expect, it, vi } from 'vitest';
import { Checkbox } from '../src/design-kit/adapters/checkbox.tsx';
import { CheckboxGroup, CheckboxItem } from '../src/design-kit/components/ui/checkbox-group.tsx';

function Confirmation() {
  const [checked, setChecked] = useState(false);
  return (
    <>
      <Checkbox label="Reviewed" checked={checked} onToggle={() => setChecked((value) => !value)} />
      <button type="button">After</button>
    </>
  );
}

it('keeps visible checkbox decoration inert inside the public focus owner', () => {
  render(<Confirmation />);
  const row = screen.getByRole('checkbox', { name: 'Reviewed' });
  for (const control of row.querySelectorAll('[role="checkbox"], input[type="checkbox"]')) {
    expect(control.closest('[inert]')).not.toBeNull();
  }
});

it('the public checkbox still toggles once by pointer and keyboard, then Tab exits', async () => {
  const user = userEvent.setup();
  render(<Confirmation />);
  const row = screen.getByRole('checkbox', { name: 'Reviewed' });
  await user.click(row);
  expect(row).toHaveAttribute('aria-checked', 'true');
  await user.keyboard(' ');
  expect(row).toHaveAttribute('aria-checked', 'false');
  await user.tab();
  expect(screen.getByRole('button', { name: 'After' })).toHaveFocus();
});

it('skips disabled choices, retains their explanation and never activates one', async () => {
  const user = userEvent.setup();
  const toggle = vi.fn();
  render(
    <>
      <CheckboxGroup checkedIndices={new Set()}>
        <CheckboxItem index={0} label="First" checked={false} onToggle={toggle} />
        <CheckboxItem
          index={1}
          label="Not trusted"
          checked={false}
          disabled
          tabIndex={-1}
          aria-describedby="reason"
          onToggle={toggle}
        />
        <CheckboxItem index={2} label="Off" checked={false} disabled onToggle={toggle} />
        <CheckboxItem index={3} label="Last" checked={false} onToggle={toggle} />
      </CheckboxGroup>
      <span id="reason">Trust this version first.</span>
    </>,
  );
  const disabled = screen.getByRole('checkbox', { name: 'Not trusted' });
  expect(disabled).toHaveAccessibleDescription('Trust this version first.');
  expect(disabled).toHaveAttribute('aria-disabled', 'true');
  expect(disabled).toHaveClass('opacity-50');
  // A tap must hit this row, not the group's click-between-rows handler.
  expect(disabled).not.toHaveClass('pointer-events-none');
  expect(screen.getByRole('checkbox', { name: 'Off' })).not.toHaveAttribute('tabindex');
  await user.tab();
  await user.keyboard('{ArrowDown}');
  expect(screen.getByRole('checkbox', { name: 'Last' })).toHaveFocus();
  await user.tab({ shift: true });
  expect(screen.getByRole('checkbox', { name: 'First' })).toHaveFocus();
  fireEvent.click(disabled);
  act(() => disabled.focus());
  expect(disabled).toHaveFocus();
  await user.keyboard(' {Enter}');
  expect(toggle).not.toHaveBeenCalled();
});
