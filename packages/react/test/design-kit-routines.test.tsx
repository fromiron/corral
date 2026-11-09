import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  type AgentRoutine,
  AgentRoutines,
} from '../src/design-kit/components/agent/agent-routines.tsx';

const routine: AgentRoutine = {
  id: 'triage',
  name: 'Morning triage',
  schedule: { frequency: 'weekdays', time: '09:00' },
  sources: [{ id: 'issues', name: 'Issues' }],
  destination: { label: '#triage' },
  model: { name: 'Model' },
  enabled: true,
  history: [],
};

describe('AgentRoutines without create', () => {
  it('shows no create-from-sentence without onCreate', () => {
    render(<AgentRoutines routines={[routine]} parseDraft={() => null} />);
    expect(screen.queryByRole('button', { name: 'New routine' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Describe the routine' })).not.toBeInTheDocument();
  });

  it('omits every row action whose callback is absent', () => {
    render(<AgentRoutines routines={[{ ...routine, run: { step: 0 } }]} />);
    expect(
      screen.queryByRole('button', { name: /Run Morning triage now/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Stop Morning triage/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.queryByRole('form')).not.toBeInTheDocument();
  });

  it('does not point to New routine in the empty state without onCreate', () => {
    render(<AgentRoutines routines={[]} />);
    expect(screen.getByText('No routines yet.')).toBeInTheDocument();
  });

  it('offers create from a sentence with onCreate', () => {
    render(<AgentRoutines routines={[routine]} onCreate={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'New routine' })).toBeInTheDocument();
  });
});
