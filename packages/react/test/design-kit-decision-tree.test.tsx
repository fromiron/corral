import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DecisionTree } from '../src/design-kit/components/agent/decision-tree.tsx';

const decision = {
  question: 'Which recorded branch?',
  pickId: 'recommended',
  options: [
    { id: 'recommended', label: 'Recommended route' },
    { id: 'actual', label: 'Actual route' },
  ],
};

describe('recorded DecisionTree', () => {
  it('shows no chosen route for an explicitly unknown observation, even with a recommendation', () => {
    const { container } = render(
      <DecisionTree agent={{ name: 'Review' }} decision={decision} selectedId={null} readOnly />,
    );
    expect(container.querySelector('[aria-pressed="true"], [data-selected="true"]')).toBeNull();
    expect(screen.queryByText("Agent's pick")).not.toBeInTheDocument();
  });

  it('does not dispatch a choice from clicks or number keys in an observed tree', () => {
    const onSelect = vi.fn();
    const { container } = render(
      <DecisionTree
        agent={{ name: 'Review' }}
        decision={decision}
        selectedId="actual"
        readOnly
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByText('Recommended route'));
    fireEvent.keyDown(window, { key: '1' });
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(container.querySelector('[data-selected="true"]')).toHaveTextContent('Actual route');
  });

  it('retains the supplied interactive component behavior outside recorded mode', () => {
    const onSelect = vi.fn();
    render(<DecisionTree agent={{ name: 'Review' }} decision={decision} onSelect={onSelect} />);
    fireEvent.keyDown(window, { key: '2' });
    expect(onSelect).toHaveBeenCalledWith('actual');
  });
});
