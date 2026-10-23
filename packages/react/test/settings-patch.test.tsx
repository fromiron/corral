import { emptyProjection } from '@corral/core';
import { linearCorral } from '@corral/testkit';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { ReinsPanel } from '../src/components/ReinsPanel.tsx';
import messages from '../src/messages/en.json' with { type: 'json' };
import { createRunSession } from '../src/run/session.ts';

function setup() {
  const session = createRunSession({} as never);
  const sendCommand = vi.fn(async () => ({ status: 'applied' }) as never);
  const projection = {
    ...emptyProjection('run_patch'),
    status: 'running' as const,
    controlRevision: 3,
  };
  projection.budget.spent = 42;
  session.setState({
    runId: projection.runId,
    definition: linearCorral(['writer']),
    projection,
    sendCommand,
  });
  render(
    <IntlProvider locale="en" messages={messages}>
      <ReinsPanel session={session} target={null} />
    </IntlProvider>,
  );
  return { session, sendCommand };
}

describe('future settings preview (C-035)', () => {
  it('shows spent usage and current → proposed before submitting the reviewed revision', () => {
    const { sendCommand } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Change settings' }));
    fireEvent.change(screen.getByLabelText('Proposed value'), { target: { value: '80000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview changes' }));
    expect(screen.getByTestId('patch-preview')).toHaveTextContent('64000');
    expect(screen.getByTestId('patch-preview')).toHaveTextContent('80000');
    expect(screen.getByTestId('patch-preview')).toHaveTextContent(
      '42 confirmed tokens already spent',
    );
    expect(sendCommand).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm settings change' }));
    expect(sendCommand).toHaveBeenCalledWith({
      type: 'patch',
      expectedControlRevision: 3,
      payload: { kind: 'run_limits', changes: { maxOutputTokens: 80000 } },
    });
  });
  it('requires a new preview when another control revision arrives', () => {
    const { session, sendCommand } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Change settings' }));
    fireEvent.change(screen.getByLabelText('Proposed value'), { target: { value: '80000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview changes' }));
    act(() =>
      session.setState({
        projection: {
          ...(session.getState().projection ?? emptyProjection('run_patch')),
          controlRevision: 4,
        },
      }),
    );
    expect(screen.getByRole('button', { name: 'Confirm settings change' })).toBeDisabled();
    expect(sendCommand).not.toHaveBeenCalled();
  });
});
