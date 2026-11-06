import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { expect, it } from 'vitest';
import { RadioGroup, RadioItem } from '../src/design-kit/components/ui/radio-group.tsx';

function Choices() {
  const [value, setValue] = useState('flow');
  return (
    <>
      <RadioGroup value={value} onValueChange={setValue} aria-label="Runs">
        <RadioItem index={0} value="flow" label="In the flow" />
        <RadioItem index={1} value="called" label="Only when called" />
      </RadioGroup>
      <button type="button">After</button>
    </>
  );
}

it('keeps primitive radios fully hidden within the single public radio owner', () => {
  render(<Choices />);
  for (const radio of screen.getAllByRole('radio')) {
    const nested = radio.querySelectorAll('input, button, [tabindex]');
    expect(nested.length).toBeGreaterThan(0);
    for (const control of nested) expect(control).not.toBeVisible();
  }
});

it('arrow selection stays on the public row and Tab leaves the group', async () => {
  const user = userEvent.setup();
  render(<Choices />);
  await user.tab();
  expect(screen.getByRole('radio', { name: 'In the flow' })).toHaveFocus();
  await user.keyboard('{ArrowDown}');
  expect(screen.getByRole('radio', { name: 'Only when called' })).toHaveFocus();
  expect(screen.getByRole('radio', { name: 'Only when called' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await user.tab();
  expect(screen.getByRole('button', { name: 'After' })).toHaveFocus();
});
