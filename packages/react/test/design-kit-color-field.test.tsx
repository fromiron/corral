import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { expect, it, vi } from 'vitest';
import { ColorField } from '../src/design-kit/adapters/color-field.tsx';

function Field({ onColor }: { onColor?: (color: string) => void }) {
  const [text, setText] = useState('#336699');
  const [color, setColor] = useState('#336699');
  return (
    <>
      <label htmlFor="accent">Accent</label>
      <ColorField
        id="accent"
        text={text}
        color={color}
        invalid={text === '#bad'}
        pickerLabel="Pick accent"
        onTextChange={setText}
        onColorChange={(next) => {
          setColor(next);
          setText(next);
          onColor?.(next);
        }}
      />
    </>
  );
}

it('names both parts: the hex field by its label, the OS picker by its own name', () => {
  render(<Field />);
  const text = screen.getByRole('textbox', { name: 'Accent' });
  expect(text).toHaveValue('#336699');
  const picker = screen.getByLabelText('Pick accent');
  expect(picker).toHaveAttribute('type', 'color');
  expect(picker).toHaveValue('#336699');
});

it('keeps the hex text and the picker in step', () => {
  const onColor = vi.fn();
  render(<Field onColor={onColor} />);
  fireEvent.change(screen.getByLabelText('Pick accent'), { target: { value: '#aa0000' } });
  expect(onColor).toHaveBeenCalledWith('#aa0000');
  expect(screen.getByRole('textbox', { name: 'Accent' })).toHaveValue('#aa0000');
});

it('marks an invalid hex on the text field for assistive tech, not only by color', () => {
  render(<Field />);
  const text = screen.getByRole('textbox', { name: 'Accent' });
  expect(text).not.toHaveAttribute('aria-invalid');
  fireEvent.change(text, { target: { value: '#bad' } });
  expect(text).toHaveAttribute('aria-invalid', 'true');
  // The tile keeps the last color that applied.
  expect(screen.getByLabelText('Pick accent')).toHaveValue('#336699');
});
