import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { expect, it } from 'vitest';
import { Checkbox } from '../src/design-kit/adapters/checkbox.tsx';

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
