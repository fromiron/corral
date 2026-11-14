import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { EmptyState, Page } from '../src/design-kit/components/blocks/page-chrome.tsx';

// The path bar names a screen; the page frame only keeps the name for the document outline.

it('names the page with one h1 that only the outline reads, and shows no title or intro', () => {
  const { container } = render(
    <Page title="Needs you" toolbar={<div data-testid="toolbar">Filters</div>}>
      <p>Rows</p>
    </Page>,
  );
  const headings = container.querySelectorAll('h1');
  expect(headings).toHaveLength(1);
  const heading = screen.getByRole('heading', { level: 1, name: 'Needs you' });
  expect(heading).toHaveClass('sr-only');
  // The shell's own app-name heading steps aside for it (apps/studio/src/index.css).
  expect(heading).toHaveAttribute('data-slot', 'page-title');
  // The toolbar row opens the page: nothing visible stands above it.
  const stack = heading.parentElement;
  const visible = [...(stack?.children ?? [])].filter((child) => !child.matches('.sr-only'));
  expect(visible[0]).toBe(screen.getByTestId('toolbar'));
  expect(container.querySelector('header')).toBeNull();
});

it('an empty state may be its title alone', () => {
  const { container } = render(<EmptyState title="No Corrals yet" />);
  expect(screen.getByText('No Corrals yet')).toBeVisible();
  expect(container.querySelector('p')).toBeNull();
});

it('an empty state keeps a line when it has one', () => {
  render(<EmptyState title="Available with the local server" text="Start it to continue." />);
  expect(screen.getByText('Start it to continue.')).toBeVisible();
});
