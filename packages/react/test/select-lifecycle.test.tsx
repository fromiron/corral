import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { expect, it } from 'vitest';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '../src/design-kit/components/ui/select.tsx';

function Fixture({ controlled = false }: { controlled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('first');
  return (
    <>
      <Select
        value={value}
        onValueChange={setValue}
        {...(controlled ? { open, onOpenChange: setOpen } : {})}
      >
        <SelectTrigger aria-label="Round" />
        <SelectContent>
          <SelectItem index={0} value="first">
            First
          </SelectItem>
          <SelectItem index={1} value="second">
            Second
          </SelectItem>
        </SelectContent>
      </Select>
      <button type="button">After</button>
    </>
  );
}

it.each([false, true])(
  'selection closes accessibly and can reopen (controlled=%s)',
  async (controlled) => {
    const user = userEvent.setup();
    render(<Fixture controlled={controlled} />);
    const trigger = screen.getByRole('combobox', { name: 'Round' });
    await user.click(trigger);
    await user.click(await screen.findByRole('option', { name: 'Second' }));
    expect(trigger).toHaveTextContent('Second');
    await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    await waitFor(() =>
      expect(document.querySelectorAll('[data-base-ui-focus-guard][tabindex="0"]')).toHaveLength(0),
    );
    expect(trigger).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus();
    await user.click(trigger);
    await waitFor(() => expect(screen.getByRole('listbox')).toBeVisible());
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    await waitFor(() =>
      expect(document.querySelectorAll('[data-base-ui-focus-guard][tabindex="0"]')).toHaveLength(0),
    );
    expect(trigger).toHaveFocus();
  },
);
