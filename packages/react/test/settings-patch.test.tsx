import { emptyProjection } from '@corral/core';
import { linearCorral } from '@corral/testkit';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { ReinsPanel } from '../src/components/ReinsPanel.tsx';
import messages from '../src/messages/en.json' with { type: 'json' };
import { createRunSession } from '../src/run/session.ts';

function setup(definition = linearCorral(['writer'])) {
  const session = createRunSession({} as never);
  const sendCommand = vi.fn(async () => ({ status: 'applied' }) as never);
  const projection = {
    ...emptyProjection('run_patch'),
    status: 'running' as const,
    controlRevision: 3,
  };
  projection.modelCalls.call_done = {
    modelCallId: 'call_done',
    executionId: 'exec_writer',
    finished: true,
    usage: { outputTokens: 42 },
  } as never;
  session.setState({
    runId: projection.runId,
    definition,
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

describe('future settings preview', () => {
  it('shows spent usage and current → proposed before submitting the reviewed revision', () => {
    const { sendCommand } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Change settings' }));
    fireEvent.change(screen.getByLabelText('Proposed value'), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview changes' }));
    expect(screen.getByTestId('patch-preview')).toHaveTextContent('12');
    expect(screen.getByTestId('patch-preview')).toHaveTextContent('20');
    expect(screen.getByTestId('patch-preview')).toHaveTextContent('42 output tokens already used');
    expect(sendCommand).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm settings change' }));
    expect(sendCommand).toHaveBeenCalledWith({
      type: 'patch',
      expectedControlRevision: 3,
      payload: { kind: 'run_limits', changes: { maxSpawns: 20 } },
    });
  });
  it('requires a new preview when another control revision arrives', () => {
    const { session, sendCommand } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Change settings' }));
    fireEvent.change(screen.getByLabelText('Proposed value'), { target: { value: '20' } });
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

  it('shows a Loop without a round cap as unlimited, and a loop_limit patch gives it one', async () => {
    const user = userEvent.setup();
    const definition = linearCorral(['writer']);
    definition.nodes = definition.nodes.map((node) =>
      node.id === 'writer' ? { ...node, parentId: 'rounds' } : node,
    );
    definition.nodes.push({
      id: 'rounds',
      type: 'loop',
      label: 'Rounds',
      limitPolicy: { kind: 'unlimited' },
    });
    const { sendCommand } = setup(definition);
    fireEvent.click(screen.getByRole('button', { name: 'Change settings' }));
    await user.click(screen.getByRole('combobox', { name: 'Change scope' }));
    await user.click(await screen.findByRole('option', { name: 'Future Loop rounds' }));
    expect(screen.getByText('No round limit')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Proposed value'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview changes' }));
    expect(screen.getByTestId('patch-preview')).toHaveTextContent('No round limit');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm settings change' }));
    expect(sendCommand).toHaveBeenCalledWith({
      type: 'patch',
      expectedControlRevision: 3,
      payload: { kind: 'loop_limit', nodeId: 'rounds', maxIterations: 4 },
    });
  });
});
