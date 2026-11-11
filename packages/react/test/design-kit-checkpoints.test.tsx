import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  type AgentCheckpoint,
  AgentCheckpoints,
} from '../src/design-kit/components/agent/agent-checkpoints.tsx';

const checkpoints: AgentCheckpoint[] = [
  { id: 'plan', label: 'Planned the change', status: 'done', at: 1_000 },
  { id: 'copy', label: 'Wrote the copy', status: 'done', at: 2_000 },
];

function headLabel(container: HTMLElement) {
  return container.querySelector('[aria-current="step"]')?.getAttribute('aria-label');
}

describe('AgentCheckpoints rewind', () => {
  it('asks the host to rewind without marking the checkpoint restored', () => {
    const onRewind = vi.fn();
    const { container } = render(
      <AgentCheckpoints checkpoints={checkpoints} startedAt={0} onRewind={onRewind} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Rewind' }));
    fireEvent.keyDown(screen.getByLabelText('Planned the change – press Enter to rewind here'), {
      key: 'Enter',
    });
    expect(onRewind).toHaveBeenCalledTimes(2);
    expect(onRewind).toHaveBeenNthCalledWith(1, 'plan');
    expect(onRewind).toHaveBeenNthCalledWith(2, 'plan');
    expect(headLabel(container)).toBe('Wrote the copy, current');
  });

  it('moves the head only when the host reports it', () => {
    const { container, rerender } = render(
      <AgentCheckpoints checkpoints={checkpoints} startedAt={0} onRewind={vi.fn()} />,
    );
    rerender(
      <AgentCheckpoints checkpoints={checkpoints} startedAt={0} head="plan" onRewind={vi.fn()} />,
    );
    expect(headLabel(container)).toBe('Planned the change, current');
  });

  it('offers no rewind without onRewind', () => {
    render(<AgentCheckpoints checkpoints={checkpoints} startedAt={0} />);
    expect(screen.queryByRole('button', { name: 'Rewind' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Planned the change')).toBeInTheDocument();
  });
});
