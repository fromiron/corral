import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AgentSteering } from '../src/design-kit/components/agent/agent-steering.tsx';

describe('host-composed agent steering', () => {
  it('does not submit the default input while an IME composition is being confirmed', () => {
    const onQueue = vi.fn();
    render(
      <AgentSteering
        title="Current work"
        agent="Writer"
        status="running"
        steps={[]}
        queued={[]}
        onQueue={onQueue}
      />,
    );
    const input = screen.getByRole('textbox', { name: 'Steer the agent' });
    fireEvent.change(input, { target: { value: '자료 확인' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    expect(onQueue).not.toHaveBeenCalled();
    expect(input).toHaveValue('자료 확인');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onQueue).toHaveBeenCalledWith('자료 확인');
  });

  it('uses one host-owned input without adding unsupported actions or keyboard shortcuts', () => {
    const onQueue = vi.fn();
    const onInterrupt = vi.fn();
    render(
      <AgentSteering
        title="Current work"
        agent="Writer"
        status="running"
        steps={[]}
        queued={[{ id: 'directive_1', text: 'Use primary sources' }]}
        onQueue={onQueue}
        onInterrupt={onInterrupt}
        compose={<textarea aria-label="Request" defaultValue="Keep this draft" />}
      />,
    );
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
    const input = screen.getByRole('textbox', { name: 'Request' });
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    expect(onQueue).not.toHaveBeenCalled();
    expect(onInterrupt).not.toHaveBeenCalled();
    expect(input).toHaveValue('Keep this draft');
    expect(screen.queryByRole('button', { name: 'Pause the run' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Now' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Remove/ })).toBeNull();
    expect(screen.queryByText(/interrupt now/)).toBeNull();
  });

  it('shows the host directive status and evidence without turning a receipt into delivery', () => {
    render(
      <AgentSteering
        title="Current work"
        agent="Writer"
        status="waiting"
        statusLabel="Waiting for approval"
        steps={[]}
        queued={[
          {
            id: 'directive_1',
            domId: 'directive-directive_1',
            text: 'Check the source',
            status: <span>Delivery unknown</span>,
            detail: <span>Receipt not confirmed</span>,
          },
        ]}
        labels={{ queued: 'Instructions for this execution' }}
        compose={null}
      />,
    );
    expect(screen.getByText('Delivery unknown')).toBeInTheDocument();
    expect(screen.getByText('Receipt not confirmed')).toBeInTheDocument();
    expect(screen.getByText('Check the source').closest('li')).toHaveAttribute(
      'id',
      'directive-directive_1',
    );
    expect(screen.getByText('Waiting for approval')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByText('Steered')).toBeNull();
  });

  it('does not invent a step count or zero elapsed time when the host has no observations', () => {
    render(
      <AgentSteering
        title="Current work"
        agent="Writer"
        status="running"
        steps={[]}
        queued={[]}
        compose={null}
      />,
    );
    expect(screen.queryByText(/Step \d/)).toBeNull();
    expect(screen.queryByText(/0s/)).toBeNull();
    expect(screen.queryByRole('list', { name: 'Plan' })).toBeNull();
  });
});
