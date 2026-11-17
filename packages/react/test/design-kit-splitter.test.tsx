import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { expect, it, vi } from 'vitest';
import { Splitter } from '../src/design-kit/adapters/splitter.tsx';

// session-panel.md: the splitter is a vertical separator that takes the focus and says the
// current width and its bounds; the arrows change the width in the rail's 16px step and stop at
// the bounds.

function Host({
  initial = 400,
  side,
  onChange = () => {},
  onCommit = () => {},
  onDragChange,
}: {
  initial?: number;
  side?: 'left' | 'right';
  onChange?: (px: number) => void;
  onCommit?: (px: number) => void;
  onDragChange?: (dragging: boolean) => void;
}) {
  const [width, setWidth] = useState(initial);
  return (
    <Splitter
      aria-label="패널 폭"
      value={width}
      min={360}
      max={440}
      side={side}
      onChange={(px) => {
        setWidth(px);
        onChange(px);
      }}
      onCommit={onCommit}
      onDragChange={onDragChange}
    />
  );
}

function stubCapture(element: HTMLElement) {
  element.setPointerCapture = () => {};
  element.releasePointerCapture = () => {};
  element.hasPointerCapture = () => true;
}

it('is a focusable vertical separator that says its value and bounds', () => {
  render(<Host />);
  const splitter = screen.getByRole('separator', { name: '패널 폭' });
  expect(splitter).toHaveAttribute('tabindex', '0');
  expect(splitter).toHaveAttribute('aria-orientation', 'vertical');
  expect(splitter).toHaveAttribute('aria-valuenow', '400');
  expect(splitter).toHaveAttribute('aria-valuemin', '360');
  expect(splitter).toHaveAttribute('aria-valuemax', '440');
});

it('widens a panel on its right with ArrowLeft in 16px steps and commits when the key is let go', () => {
  const onChange = vi.fn();
  const onCommit = vi.fn();
  render(<Host onChange={onChange} onCommit={onCommit} />);
  const splitter = screen.getByRole('separator');
  splitter.focus();
  fireEvent.keyDown(splitter, { key: 'ArrowLeft' });
  expect(onChange).toHaveBeenLastCalledWith(416);
  expect(splitter).toHaveAttribute('aria-valuenow', '416');
  expect(onCommit).not.toHaveBeenCalled();
  // A held key repeats the change and commits once, on release.
  fireEvent.keyDown(splitter, { key: 'ArrowLeft', repeat: true });
  expect(onChange).toHaveBeenLastCalledWith(432);
  fireEvent.keyUp(splitter, { key: 'ArrowLeft' });
  expect(onCommit).toHaveBeenCalledTimes(1);
  expect(onCommit).toHaveBeenLastCalledWith(432);
  fireEvent.keyDown(splitter, { key: 'ArrowRight' });
  fireEvent.keyUp(splitter, { key: 'ArrowRight' });
  expect(onCommit).toHaveBeenLastCalledWith(416);
});

it('stops at the bounds', () => {
  const onChange = vi.fn();
  render(<Host onChange={onChange} />);
  const splitter = screen.getByRole('separator');
  for (let i = 0; i < 10; i++) fireEvent.keyDown(splitter, { key: 'ArrowLeft' });
  expect(splitter).toHaveAttribute('aria-valuenow', '440');
  expect(onChange.mock.calls.every(([px]) => px <= 440)).toBe(true);
  for (let i = 0; i < 10; i++) fireEvent.keyDown(splitter, { key: 'ArrowRight' });
  expect(splitter).toHaveAttribute('aria-valuenow', '360');
  expect(onChange.mock.calls.every(([px]) => px >= 360)).toBe(true);
  // At a bound a further step changes nothing.
  onChange.mockClear();
  fireEvent.keyDown(splitter, { key: 'ArrowRight' });
  expect(onChange).not.toHaveBeenCalled();
});

it('mirrors the keys for a panel on its left', () => {
  const onChange = vi.fn();
  render(<Host side="left" onChange={onChange} />);
  const splitter = screen.getByRole('separator');
  fireEvent.keyDown(splitter, { key: 'ArrowRight' });
  expect(onChange).toHaveBeenLastCalledWith(416);
  fireEvent.keyDown(splitter, { key: 'ArrowLeft' });
  expect(onChange).toHaveBeenLastCalledWith(400);
});

it('ignores other keys and keys already handled', () => {
  const onChange = vi.fn();
  const onCommit = vi.fn();
  render(<Host onChange={onChange} onCommit={onCommit} />);
  const splitter = screen.getByRole('separator');
  fireEvent.keyDown(splitter, { key: 'ArrowUp' });
  fireEvent.keyDown(splitter, { key: 'Enter' });
  fireEvent.keyUp(splitter, { key: 'Enter' });
  const handled = new KeyboardEvent('keydown', {
    key: 'ArrowLeft',
    bubbles: true,
    cancelable: true,
  });
  handled.preventDefault();
  splitter.dispatchEvent(handled);
  expect(onChange).not.toHaveBeenCalled();
  expect(onCommit).not.toHaveBeenCalled();
});

it('resizes with a pointer drag from the width at the press and commits at its end', () => {
  const onChange = vi.fn();
  const onCommit = vi.fn();
  render(<Host onChange={onChange} onCommit={onCommit} />);
  const splitter = screen.getByRole('separator');
  stubCapture(splitter);
  fireEvent.pointerDown(splitter, { pointerId: 1, button: 0, clientX: 500 });
  fireEvent.pointerMove(splitter, { pointerId: 1, buttons: 1, clientX: 480 });
  expect(onChange).toHaveBeenLastCalledWith(420);
  fireEvent.pointerMove(splitter, { pointerId: 1, buttons: 1, clientX: 300 });
  expect(onChange).toHaveBeenLastCalledWith(440);
  fireEvent.pointerMove(splitter, { pointerId: 1, buttons: 1, clientX: 510 });
  expect(onChange).toHaveBeenLastCalledWith(390);
  expect(onCommit).not.toHaveBeenCalled();
  fireEvent.pointerUp(splitter, { pointerId: 1, clientX: 510 });
  expect(onCommit).toHaveBeenCalledTimes(1);
  expect(onCommit).toHaveBeenLastCalledWith(390);
  // Moves after the drag ended change nothing.
  onChange.mockClear();
  fireEvent.pointerMove(splitter, { pointerId: 1, buttons: 1, clientX: 400 });
  expect(onChange).not.toHaveBeenCalled();
});

it('emits nothing for a press without movement', () => {
  const onChange = vi.fn();
  const onCommit = vi.fn();
  render(<Host onChange={onChange} onCommit={onCommit} />);
  const splitter = screen.getByRole('separator');
  stubCapture(splitter);
  fireEvent.pointerDown(splitter, { pointerId: 1, button: 0, clientX: 500 });
  fireEvent.pointerUp(splitter, { pointerId: 1, clientX: 500 });
  fireEvent.click(splitter);
  fireEvent.doubleClick(splitter);
  expect(onChange).not.toHaveBeenCalled();
  expect(onCommit).not.toHaveBeenCalled();
  expect(splitter).toHaveAttribute('aria-valuenow', '400');
});

it('ends a cancelled drag where it stands', () => {
  const onChange = vi.fn();
  const onCommit = vi.fn();
  render(<Host onChange={onChange} onCommit={onCommit} />);
  const splitter = screen.getByRole('separator');
  stubCapture(splitter);
  fireEvent.pointerDown(splitter, { pointerId: 1, button: 0, clientX: 500 });
  fireEvent.pointerMove(splitter, { pointerId: 1, buttons: 1, clientX: 490 });
  fireEvent.pointerCancel(splitter, { pointerId: 1 });
  expect(onCommit).toHaveBeenLastCalledWith(410);
  onChange.mockClear();
  fireEvent.pointerMove(splitter, { pointerId: 1, buttons: 1, clientX: 400 });
  expect(onChange).not.toHaveBeenCalled();
});

it('commits nothing for a key press at a bound, and keeps the host blur handler', () => {
  const onCommit = vi.fn();
  const onBlur = vi.fn();
  render(
    <Splitter
      aria-label="패널 폭"
      value={440}
      min={360}
      max={440}
      onChange={() => {}}
      onCommit={onCommit}
      onBlur={onBlur}
    />,
  );
  const splitter = screen.getByRole('separator');
  splitter.focus();
  fireEvent.keyDown(splitter, { key: 'ArrowLeft' });
  fireEvent.keyUp(splitter, { key: 'ArrowLeft' });
  expect(onCommit).not.toHaveBeenCalled();
  splitter.blur();
  expect(onBlur).toHaveBeenCalledTimes(1);
});

it('commits a key press cut short by the focus leaving', () => {
  const onCommit = vi.fn();
  render(<Host onCommit={onCommit} />);
  const splitter = screen.getByRole('separator');
  splitter.focus();
  fireEvent.keyDown(splitter, { key: 'ArrowLeft' });
  splitter.blur();
  expect(onCommit).toHaveBeenCalledWith(416);
  fireEvent.keyUp(splitter, { key: 'ArrowLeft' });
  expect(onCommit).toHaveBeenCalledTimes(1);
});

it('ends a drag whose release never arrives, at the lost capture or a move with no button', () => {
  const onChange = vi.fn();
  const onCommit = vi.fn();
  const onDragChange = vi.fn();
  render(<Host onChange={onChange} onCommit={onCommit} onDragChange={onDragChange} />);
  const splitter = screen.getByRole('separator');
  stubCapture(splitter);
  fireEvent.pointerDown(splitter, { pointerId: 1, button: 0, buttons: 1, clientX: 500 });
  fireEvent.pointerMove(splitter, { pointerId: 1, buttons: 1, clientX: 490 });
  expect(onDragChange).toHaveBeenLastCalledWith(true);
  fireEvent(splitter, new PointerEvent('lostpointercapture', { pointerId: 1, bubbles: true }));
  expect(onCommit).toHaveBeenLastCalledWith(410);
  expect(onDragChange).toHaveBeenLastCalledWith(false);
  onChange.mockClear();
  // A later hover does not resize.
  fireEvent.pointerMove(splitter, { pointerId: 1, buttons: 0, clientX: 300 });
  expect(onChange).not.toHaveBeenCalled();

  fireEvent.pointerDown(splitter, { pointerId: 1, button: 0, buttons: 1, clientX: 500 });
  fireEvent.pointerMove(splitter, { pointerId: 1, buttons: 1, clientX: 480 });
  // The release happened outside the window: the next move has no button down.
  fireEvent.pointerMove(splitter, { pointerId: 1, buttons: 0, clientX: 300 });
  expect(onCommit).toHaveBeenCalledTimes(2);
  expect(onCommit).toHaveBeenLastCalledWith(430);
  expect(onChange).not.toHaveBeenCalledWith(440);
});

it('compares a drag with its own last width, not the width the host last rendered', () => {
  const onChange = vi.fn();
  const onCommit = vi.fn();
  // A host that has not rendered the new width yet.
  render(
    <Splitter
      aria-label="패널 폭"
      value={400}
      min={360}
      max={440}
      onChange={onChange}
      onCommit={onCommit}
    />,
  );
  const splitter = screen.getByRole('separator');
  stubCapture(splitter);
  fireEvent.pointerDown(splitter, { pointerId: 1, button: 0, buttons: 1, clientX: 500 });
  fireEvent.pointerMove(splitter, { pointerId: 1, buttons: 1, clientX: 480 });
  fireEvent.pointerMove(splitter, { pointerId: 1, buttons: 1, clientX: 500 });
  expect(onChange.mock.calls.map(([px]) => px)).toEqual([420, 400]);
  fireEvent.pointerUp(splitter, { pointerId: 1, clientX: 500 });
  expect(onCommit).toHaveBeenLastCalledWith(400);
});

it('commits a drag cut short by unmounting', () => {
  const onCommit = vi.fn();
  const view = render(<Host onCommit={onCommit} />);
  const splitter = screen.getByRole('separator');
  stubCapture(splitter);
  fireEvent.pointerDown(splitter, { pointerId: 1, button: 0, buttons: 1, clientX: 500 });
  fireEvent.pointerMove(splitter, { pointerId: 1, buttons: 1, clientX: 470 });
  view.unmount();
  expect(onCommit).toHaveBeenCalledWith(430);
});

it('keeps its values within bounds when the minimum is above the maximum', () => {
  render(<Splitter aria-label="패널 폭" value={300} min={400} max={350} onChange={() => {}} />);
  const splitter = screen.getByRole('separator');
  expect(splitter).toHaveAttribute('aria-valuemin', '400');
  expect(splitter).toHaveAttribute('aria-valuemax', '400');
  expect(splitter).toHaveAttribute('aria-valuenow', '400');
});

// The bottom dock's height (session-panel S4): a horizontal separator answers ArrowUp and
// ArrowDown, drags along y, and shows the row-resize cursor; a double press may reset.

function Rows({
  initial = 240,
  side = 'bottom',
  onChange = () => {},
  onCommit = () => {},
  onReset,
}: {
  initial?: number;
  side?: 'top' | 'bottom';
  onChange?: (px: number) => void;
  onCommit?: (px: number) => void;
  onReset?: () => void;
}) {
  const [height, setHeight] = useState(initial);
  return (
    <Splitter
      aria-label="도크 높이"
      orientation="horizontal"
      side={side}
      value={height}
      min={120}
      max={400}
      onChange={(px) => {
        setHeight(px);
        onChange(px);
      }}
      onCommit={onCommit}
      onReset={onReset}
    />
  );
}

it('is a horizontal separator whose ArrowUp grows a panel below it, and ignores the side arrows', () => {
  const onChange = vi.fn();
  const onCommit = vi.fn();
  render(<Rows onChange={onChange} onCommit={onCommit} />);
  const splitter = screen.getByRole('separator', { name: '도크 높이' });
  expect(splitter).toHaveAttribute('aria-orientation', 'horizontal');
  expect(splitter).toHaveAttribute('aria-valuenow', '240');
  expect(splitter).toHaveClass('cursor-row-resize');
  expect(splitter).toHaveClass('h-2');
  fireEvent.keyDown(splitter, { key: 'ArrowUp' });
  expect(onChange).toHaveBeenLastCalledWith(256);
  fireEvent.keyUp(splitter, { key: 'ArrowUp' });
  expect(onCommit).toHaveBeenLastCalledWith(256);
  fireEvent.keyDown(splitter, { key: 'ArrowDown' });
  expect(onChange).toHaveBeenLastCalledWith(240);
  onChange.mockClear();
  fireEvent.keyDown(splitter, { key: 'ArrowLeft' });
  fireEvent.keyDown(splitter, { key: 'ArrowRight' });
  expect(onChange).not.toHaveBeenCalled();
});

it('mirrors the keys for a panel above it', () => {
  const onChange = vi.fn();
  render(<Rows side="top" onChange={onChange} />);
  const splitter = screen.getByRole('separator', { name: '도크 높이' });
  fireEvent.keyDown(splitter, { key: 'ArrowDown' });
  expect(onChange).toHaveBeenLastCalledWith(256);
});

it('leaves ArrowUp and ArrowDown alone when vertical', () => {
  const onChange = vi.fn();
  render(<Host onChange={onChange} />);
  const splitter = screen.getByRole('separator', { name: '패널 폭' });
  fireEvent.keyDown(splitter, { key: 'ArrowUp' });
  fireEvent.keyDown(splitter, { key: 'ArrowDown' });
  expect(onChange).not.toHaveBeenCalled();
});

it('resizes a panel below with a drag along y', () => {
  const onChange = vi.fn();
  const onCommit = vi.fn();
  render(<Rows onChange={onChange} onCommit={onCommit} />);
  const splitter = screen.getByRole('separator', { name: '도크 높이' });
  stubCapture(splitter);
  fireEvent.pointerDown(splitter, {
    pointerId: 1,
    button: 0,
    buttons: 1,
    clientX: 50,
    clientY: 500,
  });
  fireEvent.pointerMove(splitter, { pointerId: 1, buttons: 1, clientX: 90, clientY: 470 });
  expect(onChange).toHaveBeenLastCalledWith(270);
  fireEvent.pointerUp(splitter, { pointerId: 1, clientX: 90, clientY: 470 });
  expect(onCommit).toHaveBeenLastCalledWith(270);
});

it('resets on a double press only when the host asks for it', () => {
  const onReset = vi.fn();
  render(<Rows onReset={onReset} />);
  fireEvent.doubleClick(screen.getByRole('separator', { name: '도크 높이' }));
  expect(onReset).toHaveBeenCalledTimes(1);
  const onResetWide = vi.fn();
  render(
    <Splitter
      aria-label="패널 폭 2"
      value={400}
      min={360}
      max={440}
      onChange={() => {}}
      onReset={onResetWide}
    />,
  );
  fireEvent.doubleClick(screen.getByRole('separator', { name: '패널 폭 2' }));
  expect(onResetWide).toHaveBeenCalledTimes(1);
});
