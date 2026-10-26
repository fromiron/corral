import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Slider } from '../src/design-kit/components/ui/slider.tsx';

describe('supplied Slider integration', () => {
  it('uses Base UI arrow keys with a controlled cursor across 10,000 events', async () => {
    const user = userEvent.setup();
    function Cursor() {
      const [value, setValue] = useState(9_999);
      return (
        <Slider
          size="compact"
          label="Recorded event"
          value={value}
          min={0}
          max={10_000}
          onChange={(next) => setValue(next as number)}
        />
      );
    }
    const { container } = render(<Cursor />);
    const slider = screen.getByRole('slider', { name: 'Recorded event' });
    expect(slider).toHaveAttribute('max', '10000');
    expect(slider).toHaveValue('9999');
    await user.tab();
    expect(slider).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(slider).toHaveValue('10000');
    await user.keyboard('{ArrowRight}');
    expect(slider).toHaveValue('10000');
    await user.keyboard('{ArrowLeft}');
    expect(slider).toHaveValue('9999');
    // Compact is a supplied size; its default omits per-event pips at this range.
    expect(container.querySelectorAll('*').length).toBeLessThan(100);
  });

  it('keeps a disabled cursor outside the keyboard focus path', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <>
        <button type="button">Before</button>
        <Slider
          size="compact"
          label="Recorded event"
          value={3}
          min={0}
          max={10_000}
          disabled
          onChange={onChange}
        />
        <button type="button">After</button>
      </>,
    );
    const slider = screen.getByRole('slider', { name: 'Recorded event' });
    expect(slider).toBeDisabled();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Before' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(onChange).not.toHaveBeenCalled();
    expect(slider).toHaveValue('3');
  });
});
