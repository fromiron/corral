import { fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { expect, it, vi } from 'vitest';
import { EmptyView } from '../src/index.ts';

it('shows the kit empty state with its one action as a secondary button under it', () => {
  const act = vi.fn();
  const { container } = render(
    <EmptyView
      title="No checks"
      text="Checks run commands on your computer."
      action={{ label: 'Open project tools', onClick: act }}
      data-testid="checks-empty"
    />,
  );
  const view = screen.getByTestId('checks-empty');
  expect(view).toHaveAttribute('data-slot', 'empty-view');
  expect(screen.getByText('No checks')).toBeVisible();
  expect(screen.getByText('Checks run commands on your computer.')).toBeVisible();
  const button = screen.getByRole('button', { name: 'Open project tools' });
  // The action follows the empty state rather than sitting inside its frame.
  expect(button.closest('[data-slot="empty-view"]')).toBe(view);
  expect(view.lastElementChild).toBe(button);
  fireEvent.click(button);
  expect(act).toHaveBeenCalledTimes(1);
  expect(container.querySelectorAll('button')).toHaveLength(1);
});

it('a link action keeps its link role', () => {
  // The button gives the link its label, as it does a router link.
  render(
    <EmptyView
      title="No files changed"
      action={{ label: 'Open', render: createElement('a', { href: '/where' }) }}
    />,
  );
  expect(screen.getByText('No files changed')).toBeVisible();
  expect(screen.getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/where');
});

it('without an action there is nothing to press', () => {
  const { container } = render(<EmptyView title="Choose a file to see its changes" />);
  expect(container.querySelector('button, a')).toBeNull();
});
