import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { IntlProvider } from 'use-intl';
import { expect, it } from 'vitest';
import { WorkbenchLayout } from '../../../apps/studio/src/pages/Workbench.tsx';
import messages from '../src/messages/en.json' with { type: 'json' };

function Workspace() {
  const [open, setOpen] = useState(false);
  return (
    <IntlProvider locale="en" messages={messages}>
      <WorkbenchLayout
        main={
          <>
            <input aria-label="Draft" />
            <button type="button" onClick={() => setOpen(true)}>
              Open details
            </button>
          </>
        }
        panel={
          <button type="button" onClick={() => setOpen(false)}>
            Close details
          </button>
        }
        panelOpen={open}
      />
    </IntlProvider>
  );
}

it('[TC-WIDGET-001-H] opening details selects the narrow panel area without remounting the draft', () => {
  render(<Workspace />);
  const draft = screen.getByRole('textbox', { name: 'Draft' });
  fireEvent.change(draft, { target: { value: 'Preserved draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Open details' }));
  expect(screen.getByRole('tab', { name: 'Work panel' })).toHaveAttribute('aria-selected', 'true');
  fireEvent.click(screen.getByRole('tab', { name: 'Conversation' }));
  expect(screen.getByRole('tab', { name: 'Conversation' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  expect(screen.getByRole('textbox', { name: 'Draft' })).toBe(draft);
  expect(draft).toHaveValue('Preserved draft');
  fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
  expect(screen.getByRole('textbox', { name: 'Draft' })).toBe(draft);
});
