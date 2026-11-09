import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QueuedStack } from '../src/design-kit/components/blocks/queued-stack.tsx';
import type { QueuedMessage } from '../src/design-kit/components/ui/input-message.tsx';

const queue: QueuedMessage[] = [
  { id: 'first', text: 'First', files: [] },
  { id: 'second', text: 'Second', files: [] },
];

function card(text: string): HTMLElement {
  const el = screen.getByText(text).parentElement;
  if (!el) throw new Error(`No card for ${text}`);
  return el;
}

/** Fans the stack out, then presses the second card and drags it a full slot down. */
function dragSecondCard(from: HTMLElement = card('Second')) {
  fireEvent.mouseEnter(card('Second'));
  fireEvent.pointerDown(from, { button: 0, clientY: 0 });
  fireEvent.pointerMove(window, { clientY: 60 });
}

describe('QueuedStack order', () => {
  it('drags to reorder only when the host can change the stored order', () => {
    const onQueueChange = vi.fn();
    render(
      <QueuedStack
        queue={queue}
        onQueueChange={onQueueChange}
        onEdit={vi.fn()}
        onRemove={vi.fn()}
        bottom={0}
      />,
    );
    fireEvent.mouseEnter(card('Second'));
    expect(card('Second').style.cursor).toBe('grab');
    const restingLayer = card('Second').style.zIndex;
    dragSecondCard();
    expect(onQueueChange).toHaveBeenCalledWith([queue[1], queue[0]]);
    expect(card('Second').style.zIndex).not.toBe(restingLayer);
  });

  it('offers no drag reordering without onQueueChange', () => {
    render(<QueuedStack queue={queue} onEdit={vi.fn()} onRemove={vi.fn()} bottom={0} />);
    fireEvent.mouseEnter(card('Second'));
    expect(card('Second').style.cursor).toBe('default');
    expect(card('Second').style.touchAction).toBe('');
    const restingLayer = card('Second').style.zIndex;
    dragSecondCard();
    // A drag would lift the pressed card above the others.
    expect(card('Second').style.zIndex).toBe(restingLayer);
    fireEvent.pointerUp(window);
  });

  it('still calls back for edit and remove without onQueueChange', () => {
    const onEdit = vi.fn();
    const onRemove = vi.fn();
    render(<QueuedStack queue={queue} onEdit={onEdit} onRemove={onRemove} bottom={0} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit queued message: Second' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove queued message: First' }));
    expect(onEdit).toHaveBeenCalledWith(queue[1]);
    expect(onRemove).toHaveBeenCalledWith(queue[0]);
  });

  it('runs a host card action without dragging or editing the card', () => {
    const onStart = vi.fn();
    const onEdit = vi.fn();
    const onQueueChange = vi.fn();
    render(
      <QueuedStack
        queue={queue}
        onQueueChange={onQueueChange}
        onEdit={onEdit}
        onRemove={vi.fn()}
        bottom={0}
        renderActions={(item) => (
          <button type="button" onClick={() => onStart(item)}>
            Start {item.text} now
          </button>
        )}
      />,
    );
    const start = screen.getByRole('button', { name: 'Start Second now' });
    dragSecondCard(start);
    fireEvent.pointerUp(window);
    fireEvent.click(start);
    fireEvent.doubleClick(start);
    expect(onStart).toHaveBeenCalledWith(queue[1]);
    expect(onQueueChange).not.toHaveBeenCalled();
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('takes localized names', () => {
    render(
      <QueuedStack
        queue={queue}
        onEdit={vi.fn()}
        onRemove={vi.fn()}
        bottom={0}
        labels={{ editMessage: (text) => `편집: ${text}` }}
      />,
    );
    expect(screen.getByRole('button', { name: '편집: First' })).toBeInTheDocument();
  });
});
