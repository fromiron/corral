import { emptyProjection } from '@corral/core';
import { linearCorral } from '@corral/testkit';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { RunActions } from '../src/components/RunActions.tsx';
import { RunView } from '../src/components/RunView.tsx';
import messages from '../src/messages/en.json' with { type: 'json' };
import { createRunSession } from '../src/run/session.ts';

function renderRun() {
  const sendCommand = vi.fn(async () => ({ status: 'queued' }) as never);
  const session = createRunSession({} as never);
  session.setState({
    runId: 'run_controls',
    definition: linearCorral(['writer']),
    projection: { ...emptyProjection('run_controls'), status: 'running' },
    sendCommand,
  });
  render(
    <IntlProvider locale="en" messages={messages}>
      <RunView session={session} onSteer={vi.fn()} />
    </IntlProvider>,
  );
  return { session, sendCommand };
}

describe('run controls', () => {
  it('keeps an unconfirmed command visible and retries its exact ID', () => {
    const { session } = renderRun();
    const retryCommand = vi.fn(async () => ({ status: 'applied' }) as never);
    act(() =>
      session.setState({
        retryCommand,
        unconfirmedCommands: {
          cmd_unknown: {
            error: 'response lost',
            command: {
              schemaVersion: '0.1',
              runId: 'run_controls',
              commandId: 'cmd_unknown',
              type: 'cancel',
              payload: { scope: { kind: 'run' }, reason: 'User cancelled' },
            },
          },
        },
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Check receipt and retry safely' }));
    expect(retryCommand).toHaveBeenCalledWith('cmd_unknown');
  });

  it('pauses the whole run through a command without optimistic paused status', () => {
    const { session, sendCommand } = renderRun();
    fireEvent.click(screen.getByRole('button', { name: 'Pause run' }));
    expect(sendCommand).toHaveBeenCalledWith({ type: 'pause', payload: { scope: 'run' } });
    expect(session.getState().projection?.status).toBe('running');
  });
  it('requires an explicit whole-run cancellation confirmation', () => {
    const { sendCommand } = renderRun();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel whole run' }));
    expect(sendCommand).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm whole run cancellation' }));
    expect(sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'cancel',
        payload: { scope: { kind: 'run' }, reason: 'User cancelled the run' },
      }),
    );
  });
  it('a cancel confirmation opened for one run never cancels the next run the view follows', () => {
    const sendCommand = vi.fn(async () => ({ status: 'queued' }) as never);
    const session = createRunSession({} as never);
    session.setState({
      runId: 'run_controls',
      projection: { ...emptyProjection('run_controls'), status: 'running' },
      sendCommand,
    });
    // RunActions alone, as a dock or editor shows it: nothing remounts it when the run changes.
    render(
      <IntlProvider locale="en" messages={messages}>
        <RunActions session={session} />
      </IntlProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel whole run' }));
    act(() =>
      session.setState({
        runId: 'run_next',
        projection: { ...emptyProjection('run_next'), status: 'running' },
      }),
    );
    expect(screen.queryByRole('button', { name: 'Confirm whole run cancellation' })).toBeNull();
    act(() =>
      session.setState({
        runId: 'run_controls',
        projection: { ...emptyProjection('run_controls'), status: 'running' },
      }),
    );
    // Coming back does not revive the earlier confirmation either.
    expect(screen.queryByRole('button', { name: 'Confirm whole run cancellation' })).toBeNull();
    expect(sendCommand).not.toHaveBeenCalled();
  });
});
