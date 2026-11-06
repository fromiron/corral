import { fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { createPortal } from 'react-dom';
import { expect, it, vi } from 'vitest';
import { InputMessage } from '../src/design-kit/components/ui/input-message.tsx';

it('keeps editing and host recovery actions available when submission is blocked', () => {
  const onChange = vi.fn();
  const onSend = vi.fn();
  render(
    <InputMessage
      value="Preserve my request"
      onValueChange={onChange}
      onSend={onSend}
      sendDisabled
      textareaProps={{ 'aria-label': 'Request' }}
      contentSlot={<button type="button">Connect model</button>}
    />,
  );
  expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Connect model' })).toBeEnabled();
  expect(screen.getByRole('textbox', { name: 'Request' })).toBeEnabled();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Corrected request' } });
  expect(onChange).toHaveBeenCalledWith('Corrected request');
  expect(onSend).not.toHaveBeenCalled();
});

it('renders one host input and leaves its keyboard and draft lifetime to the host', () => {
  const inputRef = createRef<HTMLTextAreaElement>();
  const keyDown = vi.fn();
  const onSend = vi.fn();
  const onChange = vi.fn();
  render(
    <InputMessage
      inputRef={inputRef}
      value="Keep until the receipt is confirmed"
      onValueChange={onChange}
      onSend={onSend}
      renderInput={(props) => <textarea {...props} onKeyDown={keyDown} aria-label="Request" />}
    />,
  );
  const input = screen.getByRole('textbox', { name: 'Request' });
  expect(screen.getAllByRole('textbox')).toHaveLength(1);
  expect(inputRef.current).toBe(input);
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
  expect(keyDown).toHaveBeenCalledOnce();
  expect(onSend).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  expect(onSend).toHaveBeenCalledWith('Keep until the receipt is confirmed', []);
  expect(input).toHaveValue('Keep until the receipt is confirmed');
  expect(onChange).not.toHaveBeenCalled();
});

it('does not steal focus from a portaled action menu inside a slot', () => {
  render(
    <InputMessage
      value="Draft"
      onValueChange={() => {}}
      leftSlot={createPortal(
        <div role="menu">
          <div role="menuitem" tabIndex={0}>
            Project reference
          </div>
        </div>,
        document.body,
      )}
    />,
  );
  const item = screen.getByRole('menuitem', { name: 'Project reference' });
  item.focus();
  fireEvent.mouseDown(item);
  expect(item).toHaveFocus();
});
