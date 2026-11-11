import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ColorPicker, ColorPickerPopover } from '../src/design-kit/components/ui/color-picker.tsx';

// The kit color picker as Corral copies it: opaque `#rrggbb` only, hex the one format, the
// host's swatches and localized labels.

function Picker({
  onColor,
  swatches,
}: {
  onColor?: (color: string) => void;
  swatches?: { color: string; label: string }[];
}) {
  const [color, setColor] = useState('#336699');
  return (
    <ColorPicker
      value={color}
      swatches={swatches}
      labels={{ area: 'Shade', hue: 'Hue', hex: 'Hex', invalid: 'Use #rrggbb.' }}
      onValueChange={(next) => {
        setColor(next);
        onColor?.(next);
      }}
    />
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the copied kit color picker', () => {
  it('is opaque and hex only: one hex field, one hue slider, no alpha and no format menu', () => {
    render(<Picker />);
    expect(screen.getByRole('textbox', { name: 'Hex' })).toHaveValue('336699');
    expect(
      screen.getAllByRole('slider').map((slider) => slider.getAttribute('aria-label')),
    ).toEqual(['Hue']);
    expect(screen.queryByRole('textbox', { name: /alpha/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /hex|rgb|hsl|oklch/i })).toBeNull();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('applies a typed six-digit hex at once in lower case, and marks anything else without applying it', async () => {
    const user = userEvent.setup();
    const onColor = vi.fn();
    render(<Picker onColor={onColor} />);
    const hex = screen.getByRole('textbox', { name: 'Hex' });
    await user.click(hex);
    await user.keyboard('{Control>}a{/Control}ABCDEF');
    expect(onColor).toHaveBeenLastCalledWith('#abcdef');
    expect(hex).not.toHaveAttribute('aria-invalid');
    onColor.mockClear();
    for (const bad of ['#12345', 'red', '#abc']) {
      await user.clear(hex);
      await user.type(hex, bad);
      await user.keyboard('{Enter}');
      expect(hex).toHaveAttribute('aria-invalid', 'true');
      const message = document.getElementById(hex.getAttribute('aria-describedby') ?? '');
      expect(message).toHaveTextContent('Use #rrggbb.');
    }
    expect(onColor).not.toHaveBeenCalled();
    // A valid value clears the mark.
    await user.clear(hex);
    await user.type(hex, '#00ff00');
    expect(onColor).toHaveBeenLastCalledWith('#00ff00');
    expect(hex).not.toHaveAttribute('aria-invalid');
  });

  it("picks one of the host's swatches by name and marks the one that matches", async () => {
    const user = userEvent.setup();
    const onColor = vi.fn();
    render(
      <Picker
        onColor={onColor}
        swatches={[
          { color: '#336699', label: 'Info' },
          { color: '#cc0000', label: 'Error' },
        ]}
      />,
    );
    expect(screen.getByRole('button', { name: 'Info' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Error' })).toHaveAttribute('aria-pressed', 'false');
    await user.click(screen.getByRole('button', { name: 'Error' }));
    expect(onColor).toHaveBeenLastCalledWith('#cc0000');
    expect(screen.getByRole('button', { name: 'Error' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('moves saturation and brightness with arrow keys on the area, and the hue on its slider', async () => {
    const user = userEvent.setup();
    const onColor = vi.fn();
    render(<Picker onColor={onColor} />);
    const area = screen.getByRole('application', { name: 'Shade' });
    act(() => area.focus());
    fireEvent.keyDown(area, { key: 'ArrowLeft', shiftKey: true });
    const desaturated = onColor.mock.lastCall?.[0] as string;
    expect(desaturated).toMatch(/^#[0-9a-f]{6}$/);
    expect(desaturated).not.toBe('#336699');
    fireEvent.keyDown(area, { key: 'ArrowDown', shiftKey: true });
    const darker = onColor.mock.lastCall?.[0] as string;
    expect(darker).not.toBe(desaturated);
    const hue = screen.getByRole('slider', { name: 'Hue' });
    const before = Number((hue as HTMLInputElement).value);
    act(() => hue.focus());
    await user.keyboard('{ArrowRight}');
    expect(Number((hue as HTMLInputElement).value)).toBe(before + 1);
    expect(onColor.mock.lastCall?.[0]).not.toBe(darker);
  });

  it('opens in a named popup from a host trigger, and offers the eyedropper only where the browser has one', async () => {
    const user = userEvent.setup();
    function Tile() {
      const [color, setColor] = useState('#336699');
      return (
        <ColorPickerPopover
          value={color}
          onValueChange={setColor}
          popupLabel="Accent"
          labels={{ hex: 'Hex', eyedropper: 'From the screen' }}
          trigger={
            <button type="button" aria-label="Accent">
              tile
            </button>
          }
        />
      );
    }
    const { unmount } = render(<Tile />);
    await user.click(screen.getByRole('button', { name: 'Accent' }));
    const popup = await screen.findByRole('dialog', { name: 'Accent' });
    expect(within(popup).getByRole('textbox', { name: 'Hex' })).toHaveValue('336699');
    expect(within(popup).queryByRole('button', { name: 'From the screen' })).toBeNull();
    unmount();

    vi.stubGlobal(
      'EyeDropper',
      class {
        open() {
          return Promise.resolve({ sRGBHex: '#123456' });
        }
      },
    );
    render(<Tile />);
    await user.click(screen.getByRole('button', { name: 'Accent' }));
    const again = await screen.findByRole('dialog', { name: 'Accent' });
    await user.click(within(again).getByRole('button', { name: 'From the screen' }));
    expect(within(again).getByRole('textbox', { name: 'Hex' })).toHaveValue('123456');
  });
});
