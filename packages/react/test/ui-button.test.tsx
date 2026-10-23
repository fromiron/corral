import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Button } from '../src/ui/button.tsx';

describe('design kit Button composition', () => {
  it('preserves labels, link semantics, and handlers supplied by the render slot', () => {
    const onClick = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
    render(
      <Button
        render={
          <a href="/settings" onClick={onClick}>
            Settings
          </a>
        }
      />,
    );
    const link = screen.getByRole('link', { name: 'Settings' });
    fireEvent.click(link);
    expect(onClick).toHaveBeenCalledOnce();
    expect(link).toHaveAttribute('href', '/settings');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('keeps render functions and disabled controls working', () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick} render={(props) => <button {...props} />}>
        Save
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Save' });
    fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(onClick).not.toHaveBeenCalled();
  });
});
