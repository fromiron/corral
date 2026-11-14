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

it('keeps the toolbar on one line when asked, and wraps it otherwise', () => {
  const row = (toolbar?: 'single' | 'wrap') => {
    const { unmount } = render(
      <InputMessage
        value=""
        onValueChange={() => {}}
        toolbar={toolbar}
        leftSlot={<button type="button">Left tool</button>}
        rightSlot={<button type="button">Right tool</button>}
      />,
    );
    const left = screen.getByRole('button', { name: 'Left tool' }).parentElement;
    const right = screen.getByRole('button', { name: 'Right tool' }).parentElement;
    const classes = {
      row: left?.parentElement?.className ?? '',
      left: left?.className ?? '',
      right: right?.className ?? '',
    };
    unmount();
    return classes;
  };
  const single = row('single');
  // From the sm width up the row never takes a second line: the left slot gives way and the
  // right actions keep their size.
  expect(single.row).toContain('sm:flex-nowrap');
  expect(single.left).toContain('sm:flex-1');
  expect(single.right).toContain('sm:shrink-0');
  for (const part of Object.values(row())) expect(part).not.toContain('sm:flex-nowrap');
});
