import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AgentStatusPill } from '../src/design-kit/components/agent/agent-status-pill.tsx';

describe('AgentStatusPill for a host without steps or approvals', () => {
  it('shows the given detail without progress or approve/deny', () => {
    const { container } = render(
      <AgentStatusPill
        name="Builder"
        state="waiting"
        label="Waiting"
        detail="Run #3"
        defaultOpen
      />,
    );
    expect(container).toHaveTextContent('Waiting · Run #3');
    expect(screen.getByRole('button', { name: /^Waiting, Run #3\./ })).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(container).not.toHaveTextContent('%');
    expect(screen.queryByRole('button', { name: /Approve|Deny/ })).not.toBeInTheDocument();
  });

  it('shows progress and the choices only from steps and approval callbacks', () => {
    render(
      <AgentStatusPill
        state="waiting"
        label="Waiting"
        steps={[
          { id: 'read', label: 'Read files', state: 'done' },
          { id: 'push', label: 'Push', state: 'waiting' },
        ]}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
        defaultOpen
      />,
    );
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deny' })).toBeInTheDocument();
  });

  it('leaves announcements to the host when announce is false', () => {
    const { rerender } = render(<AgentStatusPill state="running" label="Working" />);
    expect(screen.getByRole('status')).toHaveTextContent('Working');
    rerender(<AgentStatusPill state="running" label="Working" announce={false} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('takes localized names', () => {
    render(
      <AgentStatusPill
        state="running"
        label="작업 중"
        detail="실행 #3"
        labels={{ toggle: ({ label, detail }) => `${label}, ${detail}. 활동 보기` }}
      />,
    );
    expect(screen.getByRole('button', { name: '작업 중, 실행 #3. 활동 보기' })).toBeInTheDocument();
  });
});
