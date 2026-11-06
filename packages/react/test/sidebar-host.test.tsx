import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { expect, it } from 'vitest';
import { Sidebar, SidebarProvider } from '../src/design-kit/components/ui/sidebar.tsx';

function HostSidebar() {
  const [width, setWidth] = useState('256px');
  const [open, setOpen] = useState(true);
  return (
    <>
      <output data-testid="host-width">{width}</output>
      <output data-testid="host-open">{String(open)}</output>
      <SidebarProvider
        persist={false}
        shortcut={null}
        mobileBreakpoint={0}
        open={open}
        onOpenChange={setOpen}
        width={width}
        onWidthChange={setWidth}
        minWidth={220}
        maxWidth={420}
      >
        <Sidebar
          railProps={{
            role: 'separator',
            'aria-label': 'Sidebar width',
            tabIndex: 0,
            'aria-valuenow': Number.parseFloat(width),
            'aria-valuemin': 220,
            'aria-valuemax': 420,
          }}
        >
          <a href="#project">Project</a>
        </Sidebar>
      </SidebarProvider>
    </>
  );
}

it('uses the source rail to update the host width within the host bounds', () => {
  render(<HostSidebar />);
  const rail = screen.getByRole('separator', { name: 'Sidebar width' });
  rail.focus();
  fireEvent.keyDown(rail, { key: 'ArrowRight' });
  expect(screen.getByTestId('host-width')).toHaveTextContent('272px');
  expect(rail).toHaveAttribute('aria-valuenow', '272');
  for (let i = 0; i < 20; i++) fireEvent.keyDown(rail, { key: 'ArrowRight' });
  expect(screen.getByTestId('host-width')).toHaveTextContent('420px');
  for (let i = 0; i < 20; i++) fireEvent.keyDown(rail, { key: 'ArrowLeft' });
  expect(screen.getByTestId('host-width')).toHaveTextContent('220px');
  expect(screen.getByTestId('host-open')).toHaveTextContent('true');
});

it('keeps source pointer collapse connected to the same host open state', () => {
  render(<HostSidebar />);
  const rail = screen.getByRole('separator', { name: 'Sidebar width' });
  rail.setPointerCapture = () => {};
  rail.releasePointerCapture = () => {};
  fireEvent.pointerDown(rail, { pointerId: 1, clientX: 256 });
  fireEvent.pointerUp(rail, { pointerId: 1, clientX: 256 });
  expect(screen.getByTestId('host-open')).toHaveTextContent('false');
  expect(screen.getByTestId('host-width')).toHaveTextContent('256px');
});
